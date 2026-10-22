import { endpointKey, normalizeRole, normalizeRoutePath, type ExtractedItem } from "./types";

/**
 * Static analysis of source files. Files are only read as text and matched against known
 * framework conventions; nothing is imported, compiled or executed. Findings are hints with a
 * confidence level, never proof that a route exists or is reachable.
 *
 * Supported: Next.js (app and pages routers), Express/Fastify/Koa-style routers, React Router,
 * Flask/FastAPI decorators, Django `path()`, role checks, Prisma role enums.
 */

export type SourceFile = { path: string; content: string };

export const ANALYZED_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|prisma|vue|svelte)$/;
export const SKIPPED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", "vendor", ".venv", "venv", "__pycache__", "target", ".turbo", ".cache"]);

const lineOf = (content: string, index: number) => content.slice(0, index).split("\n").length;
const AUTH_HINT = /\b(?:requireAuth|requireActor|requireUser|requireSession|getServerSession|auth\(\)|currentUser\(|isAuthenticated|ensureAuthenticated|withAuth|login_required|@login_required|Depends\(\s*get_current_user|authorize\(|authenticate\(|passport\.authenticate|verifyToken|jwtRequired|@jwt_required|redirect\(\s*["'`]\/login)/;

function nextAppRoute(path: string): { route: string; kind: "page" | "route" } | null {
  const match = /(?:^|\/)app\/((?:.*\/)?)(page|route)\.(?:[cm]?[jt]sx?|mdx)$/.exec(path);
  if (!match) return null;
  const segments = match[1].split("/").filter(Boolean);
  if (segments.some((s) => s.startsWith("_") || s.startsWith("@"))) return null; // private folders, parallel slots
  const route = segments.filter((s) => !/^\(.*\)$/.test(s) && !/^\(\.{1,3}\)/.test(s)).join("/");
  return { route: normalizeRoutePath(`/${route}`), kind: match[2] as "page" | "route" };
}

function nextPagesRoute(path: string): { route: string; api: boolean } | null {
  const match = /(?:^|\/)pages\/(.+)\.(?:[cm]?[jt]sx?)$/.exec(path);
  if (!match || /(?:^|\/)_(?:app|document|error)$/.test(match[1]) || /(?:^|\/)src\/.*\/pages\/.*\/components\//.test(path)) return null;
  const route = match[1].replace(/(?:^|\/)index$/, "");
  return { route: normalizeRoutePath(`/${route}`), api: match[1].startsWith("api/") };
}

export function analyzeSourceFiles(files: SourceFile[]): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  const add = (item: ExtractedItem) => items.push(item);

  for (const file of files) {
    const { path, content } = file;
    const isProtected = AUTH_HINT.test(content);

    // Next.js app router
    const app = nextAppRoute(path);
    if (app?.kind === "page") add({ kind: "ROUTE", key: app.route, title: app.route, ref: `${path}:1`, confidence: "HIGH", protected: isProtected || null });
    if (app?.kind === "route") {
      const methods = [...content.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)];
      for (const m of methods) add({ kind: "API_ENDPOINT", key: endpointKey(m[1], app.route), title: `${m[1]} ${app.route}`, ref: `${path}:${lineOf(content, m.index!)}`, confidence: "HIGH", protected: isProtected || null, details: { method: m[1], path: app.route } });
    }

    // Next.js pages router
    const pages = app ? null : nextPagesRoute(path);
    if (pages && !pages.api) add({ kind: "ROUTE", key: pages.route, title: pages.route, ref: `${path}:1`, confidence: "HIGH", protected: isProtected || null });
    if (pages?.api) {
      const methods = [...new Set([...content.matchAll(/req\.method\s*===?\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/g)].map((m) => m[1]))];
      for (const method of methods.length ? methods : ["GET"]) {
        add({ kind: "API_ENDPOINT", key: endpointKey(method, pages.route), title: `${method} ${pages.route}`, ref: `${path}:1`, confidence: methods.length ? "HIGH" : "LOW", protected: isProtected || null, details: { method, path: pages.route } });
      }
    }

    // Express / Fastify / Koa / Hono style routers.
    for (const m of path.endsWith(".py") ? [] : content.matchAll(/\b(?:app|router|server|api|fastify|route[rs]?)\.(get|post|put|patch|delete|all)\(\s*(["'`])(\/[^"'`\s]{0,200})\2/g)) {
      const method = m[1] === "all" ? "GET" : m[1].toUpperCase();
      add({ kind: "API_ENDPOINT", key: endpointKey(method, m[3]), title: `${method} ${normalizeRoutePath(m[3])}`, ref: `${path}:${lineOf(content, m.index!)}`, confidence: "MEDIUM", protected: isProtected || null, details: { method, path: normalizeRoutePath(m[3]), framework: "express-like" } });
    }

    // React Router
    if (/react-router/.test(content)) {
      for (const m of content.matchAll(/<Route\b[^>]*?\bpath=\s*\{?\s*["'`]([^"'`]{1,200})["'`]/g)) {
        add({ kind: "ROUTE", key: normalizeRoutePath(m[1]), title: normalizeRoutePath(m[1]), ref: `${path}:${lineOf(content, m.index!)}`, confidence: "MEDIUM" });
      }
      for (const m of content.matchAll(/\bpath:\s*["'`](\/[^"'`]{0,200})["'`]/g)) {
        add({ kind: "ROUTE", key: normalizeRoutePath(m[1]), title: normalizeRoutePath(m[1]), ref: `${path}:${lineOf(content, m.index!)}`, confidence: "LOW" });
      }
    }

    if (path.endsWith(".py")) {
      // Flask / FastAPI
      for (const m of content.matchAll(/@\w+\.(get|post|put|patch|delete|route)\(\s*["']([^"']{1,200})["']([^)]*)\)/g)) {
        const methods = m[1] === "route" ? [...(m[3].match(/["'](GET|POST|PUT|PATCH|DELETE)["']/gi) ?? ['"GET"'])].map((s) => s.replace(/["']/g, "").toUpperCase()) : [m[1].toUpperCase()];
        for (const method of methods) add({ kind: "API_ENDPOINT", key: endpointKey(method, m[2]), title: `${method} ${normalizeRoutePath(m[2])}`, ref: `${path}:${lineOf(content, m.index!)}`, confidence: "MEDIUM", protected: isProtected || null, details: { method, path: normalizeRoutePath(m[2]), framework: "python" } });
      }
      // Django
      if (/urls\.py$/.test(path)) {
        for (const m of content.matchAll(/\b(?:re_)?path\(\s*r?["']([^"']{0,200})["']/g)) {
          add({ kind: "ROUTE", key: normalizeRoutePath(m[1]), title: normalizeRoutePath(m[1]), ref: `${path}:${lineOf(content, m.index!)}`, confidence: "MEDIUM" });
        }
      }
    }

    // Roles: explicit role checks and role enums.
    const roleHits = [
      ...content.matchAll(/\brole[s]?\b\s*(?:===?|!==?|==|\bin\b|\.includes\(|\.has\()\s*\[?\s*["'`]([A-Za-z][\w-]{1,30})["'`]/g),
      ...content.matchAll(/\b(?:hasRole|requireRole|checkRole|has_role|isRole)\(\s*["'`]([A-Za-z][\w-]{1,30})["'`]/g),
      ...content.matchAll(/@Roles?\(\s*["'`]([A-Za-z][\w-]{1,30})["'`]/g),
    ];
    for (const m of roleHits) {
      const role = normalizeRole(m[1]);
      if (role) add({ kind: "ROLE", key: role, title: role, ref: `${path}:${lineOf(content, m.index!)}`, confidence: "MEDIUM" });
    }
    for (const m of content.matchAll(/\benum\s+(\w*Role\w*)\s*\{([^}]{0,2000})\}/g)) {
      for (const raw of m[2].split(/[\s,]+/)) {
        const value = raw.replace(/=.*$/, "").replace(/["']/g, "").trim();
        if (!/^[A-Za-z][\w]{1,30}$/.test(value) || value.startsWith("//") || value.startsWith("@")) continue;
        const role = normalizeRole(value);
        if (role) add({ kind: "ROLE", key: role, title: role, ref: `${path}:${lineOf(content, m.index!)}`, confidence: "HIGH" });
      }
    }
  }
  // One entry per item: the most confident finding wins; protection hints are combined.
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
  const unique = new Map<string, ExtractedItem>();
  for (const item of items) {
    const id = `${item.kind}:${item.key}`;
    const prior = unique.get(id);
    if (!prior) unique.set(id, item);
    else {
      const best = rank[item.confidence] > rank[prior.confidence] ? item : prior;
      unique.set(id, { ...best, protected: prior.protected || item.protected || null });
    }
  }
  return [...unique.values()];
}
