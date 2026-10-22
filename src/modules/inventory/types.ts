import type { Confidence, InventoryKind } from "@/generated/prisma/enums";

/** One fact found by an analyzer, before it's merged into the application's inventory. */
export type ExtractedItem = {
  kind: InventoryKind;
  key: string;
  title: string;
  details?: Record<string, unknown>;
  /** Where it was found: "openapi.yaml#/paths/~1cart/get", "src/app/cart/page.tsx:1", "line 12". */
  ref: string;
  confidence: Confidence;
  protected?: boolean | null;
  roles?: string[];
};

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

const clean = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** Text from analyzed content is untrusted: control characters removed, length bounded. */
export const safeTitle = (value: string) => clean(value, 300);
export const safeKey = (value: string) => clean(value, 300);

/**
 * Normalizes route patterns from any framework to one form: "/products/:id".
 * Handles ":id", "{id}" (OpenAPI), "[id]" / "[...slug]" (Next.js), "<int:id>" (Flask/Django).
 */
export function normalizeRoutePath(raw: string): string {
  // Regex groups first (Django), so their "?" and character classes aren't misread.
  let path = raw.trim().replace(/\(\?P<([\w-]+)>[^)]*\)/g, ":$1");
  path = path.split(/[?#]/)[0] ?? "";
  path = path
    .replace(/\[\[?\.\.\.([\w-]+)\]?\]/g, ":$1*")
    .replace(/\[([\w-]+)\]/g, ":$1")
    .replace(/\{([\w.-]+)\}/g, ":$1")
    .replace(/<(?:\w+:)?([\w-]+)>/g, ":$1");
  path = path.replace(/^\^|\$$/g, "");
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/$/, "");
  return safeKey(path);
}

export const endpointKey = (method: string, path: string) => `${method.toUpperCase()} ${normalizeRoutePath(path)}`;

/** "Admins", "an administrator", "QA_LEAD" → "admins" / "administrator" / "qa_lead" (lowercase, trimmed). */
export function normalizeRole(raw: string): string | null {
  const role = raw.trim().replace(/^(an?|the)\s+/i, "").replace(/[^\w -]/g, "").trim().toLowerCase().replace(/\s+/g, "_");
  return role.length >= 2 && role.length <= 40 ? role : null;
}
