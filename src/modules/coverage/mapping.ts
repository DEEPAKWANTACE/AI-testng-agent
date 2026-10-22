import type { InventoryKind, ResultStatus } from "@/generated/prisma/enums";
import { normalizeRoutePath } from "@/modules/inventory/types";
import type { SnapshotCase } from "@/modules/test-suites/snapshot";

/**
 * Coverage mapping: which known inventory items approved test cases target, and what the
 * latest results say about them. Deterministic rules only:
 *
 *  - a case *targets* an item when it names the item's key in its coverage references, or
 *    (routes) NAVIGATEs to a matching path, or (endpoints) requests it with API_GET or checks
 *    it with ASSERT_RESPONSE;
 *  - VERIFIED needs a targeting case that contains assertions and passed in its latest run;
 *  - EXERCISED means the item was reached at runtime without any case targeting it.
 *
 * Percentages are always "of the known inventory", never of the application.
 */

export type CoverageLevel = "NOT_PLANNED" | "PLANNED" | "EXERCISED" | "EXECUTED" | "VERIFIED";
export const COVERAGE_LEVELS: CoverageLevel[] = ["NOT_PLANNED", "PLANNED", "EXERCISED", "EXECUTED", "VERIFIED"];

export type CoverageItem = { id: string; kind: InventoryKind; key: string; title: string };
export type PlannedCase = { suiteName: string; version: number; testCase: SnapshotCase };
export type LatestResult = { status: ResultStatus; runId: string; network: Array<{ type: string; method: string; path: string }> };

export type ItemCoverage = {
  itemId: string;
  level: CoverageLevel;
  cases: Array<{ caseKey: string; title: string; suite: string; version: number; status: ResultStatus | null; asserts: boolean }>;
  /** Cases whose runs reached the item without targeting it. */
  exercisedBy: string[];
};

/** Does `pattern` ("/products/:id", "/docs/:slug*") match a concrete path? */
export function matchesRoute(pattern: string, path: string): boolean {
  const p = normalizeRoutePath(pattern).split("/").filter(Boolean);
  const s = normalizeRoutePath(path).split("/").filter(Boolean);
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":") && p[i].endsWith("*")) return s.length >= i;
    if (i >= s.length) return false;
    if (!p[i].startsWith(":") && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

const pathOf = (urlOrPath: string) => {
  try {
    return urlOrPath.startsWith("/") ? urlOrPath.split(/[?#]/)[0] : new URL(urlOrPath).pathname;
  } catch {
    return null;
  }
};

export type CaseTargets = { refs: string[]; navigations: string[]; requests: Array<{ method: string; path: string }>; asserts: boolean };

/** What a case points at, read from its (immutable) snapshot. */
export function caseTargets(testCase: SnapshotCase): CaseTargets {
  const navigations: string[] = [];
  const requests: CaseTargets["requests"] = [];
  let asserts = false;
  for (const step of testCase.steps) {
    const params = (step.params ?? {}) as Record<string, unknown>;
    if (step.kind === "NAVIGATE") {
      const path = pathOf(String(params.url));
      if (path) navigations.push(path);
    }
    if (step.kind === "API_GET") {
      const path = pathOf(String(params.url));
      if (path) requests.push({ method: "GET", path });
    }
    if (step.kind === "ASSERT_RESPONSE" && params.match) {
      const match = params.match as { method?: string; urlContains: string };
      const path = match.urlContains.startsWith("/") ? pathOf(match.urlContains) : null;
      if (path) requests.push({ method: match.method ?? "*", path });
    }
    if (step.kind?.startsWith("ASSERT")) asserts = true;
  }
  return { refs: testCase.requirementRefs.map((r) => r.trim().toLowerCase()), navigations, requests, asserts };
}

function targetsItem(item: CoverageItem, t: CaseTargets): boolean {
  const key = item.key.toLowerCase();
  // "REQ-2", "REQ-2: coupon", "GET /api/cart requires authentication" all name REQ-2 / the endpoint.
  if (t.refs.some((ref) => ref === key || ref.startsWith(`${key} `) || ref.startsWith(`${key}:`))) return true;
  if (item.kind === "ROUTE") return t.navigations.some((path) => matchesRoute(item.key, path));
  if (item.kind === "API_ENDPOINT") {
    const [method, path] = [item.key.split(" ")[0], item.key.slice(item.key.indexOf(" ") + 1)];
    return t.requests.some((r) => (r.method === "*" || r.method === method) && matchesRoute(path, r.path));
  }
  return false;
}

function reached(item: CoverageItem, network: LatestResult["network"]): boolean {
  if (item.kind === "ROUTE") return network.some((n) => n.type === "page" && matchesRoute(item.key, n.path));
  if (item.kind === "API_ENDPOINT") {
    const [method, path] = [item.key.split(" ")[0], item.key.slice(item.key.indexOf(" ") + 1)];
    return network.some((n) => n.method === method && matchesRoute(path, n.path));
  }
  return false;
}

export function computeCoverage(items: CoverageItem[], planned: PlannedCase[], latest: Map<string, LatestResult>): ItemCoverage[] {
  const targets = planned.map((p) => ({ ...p, targets: caseTargets(p.testCase) }));
  return items.map((item) => {
    const cases = targets
      .filter((p) => targetsItem(item, p.targets))
      .map((p) => ({ caseKey: p.testCase.caseKey, title: p.testCase.title, suite: p.suiteName, version: p.version, status: latest.get(p.testCase.caseKey)?.status ?? null, asserts: p.targets.asserts }));
    const exercisedBy = targets
      .filter((p) => !cases.some((c) => c.caseKey === p.testCase.caseKey))
      .filter((p) => {
        const result = latest.get(p.testCase.caseKey);
        return result && reached(item, result.network);
      })
      .map((p) => p.testCase.title);

    let level: CoverageLevel = "NOT_PLANNED";
    if (cases.some((c) => c.asserts && c.status === "PASSED")) level = "VERIFIED";
    else if (cases.some((c) => c.status !== null && c.status !== "SKIPPED" && c.status !== "BLOCKED")) level = "EXECUTED";
    else if (exercisedBy.length) level = "EXERCISED";
    else if (cases.length) level = "PLANNED";
    return { itemId: item.id, level, cases, exercisedBy };
  });
}

export type CoverageSummary = { known: number; byLevel: Record<CoverageLevel, number>; byKind: Record<string, { known: number; verified: number; planned: number }> };

export function summarizeCoverage(items: CoverageItem[], coverage: ItemCoverage[]): CoverageSummary {
  const byLevel = Object.fromEntries(COVERAGE_LEVELS.map((l) => [l, 0])) as Record<CoverageLevel, number>;
  const byKind: CoverageSummary["byKind"] = {};
  coverage.forEach((c, i) => {
    byLevel[c.level]++;
    const kind = (byKind[items[i].kind] ??= { known: 0, verified: 0, planned: 0 });
    kind.known++;
    if (c.level === "VERIFIED") kind.verified++;
    if (c.cases.length) kind.planned++;
  });
  return { known: items.length, byLevel, byKind };
}

export const COVERAGE_DISCLAIMER =
  "Coverage is measured only against the items the sources describe (specifications, requirements, repository analysis and discovery). Untracked behaviour, other inputs and other states aren't counted, so this is never a measure of complete coverage.";
