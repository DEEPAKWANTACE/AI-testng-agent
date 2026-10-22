import { parse as parseYaml } from "yaml";
import { contractTooLarge, type JsonContract } from "@/modules/execution/contract";
import { endpointKey, HTTP_METHODS, normalizeRole, normalizeRoutePath, safeTitle, type ExtractedItem } from "./types";

/**
 * OpenAPI 3.x / Swagger 2.0 → API endpoints (with parameters and response contracts), the
 * routes they live under, and roles named by `x-roles`. The document is data: it is parsed
 * with a plain YAML/JSON parser (no custom tags, no remote $refs) and bounded in size.
 */

export const MAX_SPEC_BYTES = 2_000_000;
const MAX_OPERATIONS = 2_000;
const CONTRACT_DEPTH = 6;

export class SpecError extends Error {}

type Schema = Record<string, unknown>;

export function parseSpecText(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_SPEC_BYTES) throw new SpecError("The specification is larger than 2 MB.");
  let doc: unknown;
  try {
    doc = text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100, customTags: [], merge: false });
  } catch (error) {
    throw new SpecError(`The specification isn't valid JSON or YAML: ${String((error as Error).message).split("\n")[0].slice(0, 200)}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new SpecError("The specification must be an object.");
  const spec = doc as Record<string, unknown>;
  if (typeof spec.openapi !== "string" && spec.swagger !== "2.0") throw new SpecError("Not an OpenAPI 3 or Swagger 2.0 document (missing `openapi` or `swagger` field).");
  if (!spec.paths || typeof spec.paths !== "object") throw new SpecError("The specification has no `paths`.");
  return spec;
}

/** Resolves local "#/…" references only; anything else is left unresolved. */
function resolveRef(spec: Schema, ref: unknown): Schema | null {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  let node: unknown = spec;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) return null;
    node = (node as Schema)[key];
  }
  return node && typeof node === "object" ? (node as Schema) : null;
}

const CONTRACT_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const FORMATS = new Set(["email", "uri", "date-time", "date", "uuid"]);

/** Converts a JSON Schema (OpenAPI flavour) into the executor's contract subset, or null if it can't be expressed. */
export function toContract(spec: Schema, schema: unknown, depth = 0, seen: Set<string> = new Set()): JsonContract | null {
  if (!schema || typeof schema !== "object") return null;
  let s = schema as Schema;
  if (typeof s.$ref === "string") {
    if (seen.has(s.$ref)) return { type: "object" }; // recursive structure: check the shape only
    const target = resolveRef(spec, s.$ref);
    if (!target) return null;
    seen = new Set(seen).add(s.$ref as string);
    s = target;
  }
  if (depth > CONTRACT_DEPTH) return null;

  if (Array.isArray(s.allOf)) {
    const parts = s.allOf.map((p) => toContract(spec, p, depth, seen)).filter((p): p is JsonContract => Boolean(p));
    if (parts.length && parts.every((p) => p.type === "object")) {
      return { type: "object", properties: Object.assign({}, ...parts.map((p) => p.properties ?? {})), required: [...new Set(parts.flatMap((p) => p.required ?? []))] };
    }
    return parts[0] ?? null;
  }
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) return null; // alternatives aren't expressible

  let type = s.type as unknown;
  let nullable = s.nullable === true;
  if (Array.isArray(type)) {
    nullable = nullable || type.includes("null");
    const rest = type.filter((t) => t !== "null");
    if (rest.length !== 1) return null;
    type = rest[0];
  }
  if (type === undefined) type = s.properties ? "object" : s.items ? "array" : undefined;
  if (typeof type !== "string" || !CONTRACT_TYPES.has(type)) return null;

  const c: JsonContract = { type: type as JsonContract["type"] };
  if (nullable) c.nullable = true;
  if (Array.isArray(s.enum)) {
    const values = s.enum.filter((v) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 50) as Array<string | number | boolean>;
    if (values.length) c.enum = values.map((v) => (typeof v === "string" ? v.slice(0, 200) : v));
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (typeof s[key] === "number" && Number.isFinite(s[key])) c[key] = s[key] as number;
  }
  if (typeof s.format === "string" && FORMATS.has(s.format)) c.format = s.format as JsonContract["format"];
  if (c.type === "object" && s.properties && typeof s.properties === "object") {
    const properties: Record<string, JsonContract> = {};
    for (const [name, child] of Object.entries(s.properties as Schema).slice(0, 100)) {
      const converted = toContract(spec, child, depth + 1, seen);
      if (converted) properties[name.slice(0, 100)] = converted;
    }
    c.properties = properties;
    if (Array.isArray(s.required)) c.required = s.required.filter((r): r is string => typeof r === "string").slice(0, 100);
    if (s.additionalProperties === false) c.additionalProperties = false;
  }
  if (c.type === "array" && s.items) {
    const items = toContract(spec, s.items, depth + 1, seen);
    if (items) c.items = items;
  }
  return contractTooLarge(c) ? { type: c.type, ...(nullable ? { nullable: true } : {}) } : c;
}

function basePath(spec: Schema): string {
  if (typeof spec.basePath === "string") return spec.basePath;
  const server = Array.isArray(spec.servers) ? (spec.servers[0] as Schema | undefined) : undefined;
  if (typeof server?.url !== "string") return "";
  try {
    return new URL(server.url, "http://placeholder.invalid").pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

const stringArray = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

export function analyzeOpenApi(text: string, ref = "openapi"): ExtractedItem[] {
  const spec = parseSpecText(text);
  const prefix = basePath(spec);
  const globalSecurity = Array.isArray(spec.security) ? spec.security : [];
  const items: ExtractedItem[] = [];
  const roles = new Set<string>();
  let operations = 0;

  for (const [rawPath, pathItemRaw] of Object.entries(spec.paths as Schema)) {
    const pathItem = (resolveRef(spec, (pathItemRaw as Schema)?.$ref) ?? pathItemRaw) as Schema;
    if (!pathItem || typeof pathItem !== "object") continue;
    const path = normalizeRoutePath(`${prefix}${rawPath}`);
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method.toLowerCase()] as Schema | undefined;
      if (!op || typeof op !== "object") continue;
      if (++operations > MAX_OPERATIONS) throw new SpecError(`The specification has more than ${MAX_OPERATIONS} operations.`);

      const parameters = [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => (resolveRef(spec, (p as Schema)?.$ref) ?? p) as Schema)
        .filter((p) => p && typeof p.name === "string")
        .slice(0, 50)
        .map((p) => {
          const schema = (p.schema as Schema | undefined) ?? p; // Swagger 2 keeps type on the parameter
          const contract = toContract(spec, schema);
          return { name: safeTitle(String(p.name)), in: String(p.in ?? "query"), required: p.required === true, ...(contract ? { schema: contract } : {}) };
        });

      const security = Array.isArray(op.security) ? op.security : globalSecurity;
      const scopes = [...new Set(security.flatMap((req) => (req && typeof req === "object" ? Object.values(req as Schema).flatMap(stringArray) : [])))];
      const opRoles = [...stringArray(op["x-roles"]), ...stringArray(op["x-required-roles"])].map(normalizeRole).filter((r): r is string => Boolean(r));
      opRoles.forEach((r) => roles.add(r));

      const responses: Record<string, { description: string | null; contract: JsonContract | null }> = {};
      for (const [status, resRaw] of Object.entries((op.responses as Schema) ?? {}).slice(0, 20)) {
        const res = (resRaw && (resolveRef(spec, (resRaw as Schema).$ref) ?? resRaw)) as Schema;
        const content = res?.content as Schema | undefined;
        const json = content ? (Object.entries(content).find(([type]) => type.includes("json"))?.[1] as Schema | undefined) : undefined;
        const schema = json?.schema ?? res?.schema;
        responses[status] = { description: typeof res?.description === "string" ? safeTitle(res.description) : null, contract: toContract(spec, schema) };
      }
      const body = op.requestBody ? ((resolveRef(spec, (op.requestBody as Schema).$ref) ?? op.requestBody) as Schema) : null;
      const bodyJson = body?.content ? (Object.entries(body.content as Schema).find(([type]) => type.includes("json"))?.[1] as Schema | undefined) : undefined;
      const swaggerBody = parameters.length ? (Array.isArray(op.parameters) ? (op.parameters as Schema[]).find((p) => p?.in === "body") : undefined) : undefined;

      const summary = typeof op.summary === "string" ? op.summary : typeof op.operationId === "string" ? op.operationId : `${method} ${path}`;
      items.push({
        kind: "API_ENDPOINT",
        key: endpointKey(method, path),
        title: safeTitle(summary),
        ref: `${ref}#/paths/${rawPath.replace(/~/g, "~0").replace(/\//g, "~1")}/${method.toLowerCase()}`,
        confidence: "HIGH",
        protected: security.length > 0 && !(security.length === 1 && Object.keys((security[0] as Schema) ?? {}).length === 0),
        roles: opRoles,
        details: {
          method,
          path,
          operationId: typeof op.operationId === "string" ? safeTitle(op.operationId) : null,
          tags: stringArray(op.tags).slice(0, 10).map(safeTitle),
          parameters: parameters.filter((p) => p.in !== "body"),
          requestBody: toContract(spec, bodyJson?.schema ?? swaggerBody?.schema) ?? null,
          responses,
          scopes: scopes.slice(0, 20),
          deprecated: op.deprecated === true,
        },
      });
    }
  }
  for (const role of roles) items.push({ kind: "ROLE", key: role, title: role, ref: `${ref}#x-roles`, confidence: "HIGH" });
  return items;
}
