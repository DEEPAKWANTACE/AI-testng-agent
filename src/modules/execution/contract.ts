import { z } from "zod";

/**
 * API response contracts: a small, declarative subset of JSON Schema, checked by our own
 * validator. There are no regex patterns (no ReDoS from generated content), no $ref, and
 * nesting and sizes are bounded.
 */

export type JsonContract = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  nullable?: boolean;
  properties?: Record<string, JsonContract>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonContract;
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: "email" | "uri" | "date-time" | "date" | "uuid";
};

const MAX_DEPTH = 8;
const MAX_NODES = 300;
const PROPERTY_NAME = z.string().min(1).max(100);

export const jsonContractSchema: z.ZodType<JsonContract> = z.lazy(() =>
  z
    .object({
      type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]),
      nullable: z.boolean().optional(),
      properties: z.record(PROPERTY_NAME, jsonContractSchema).optional(),
      required: z.array(PROPERTY_NAME).max(100).optional(),
      additionalProperties: z.boolean().optional(),
      items: jsonContractSchema.optional(),
      enum: z.array(z.union([z.string().max(200), z.number(), z.boolean()])).min(1).max(50).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).optional(),
      minItems: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(0).optional(),
      format: z.enum(["email", "uri", "date-time", "date", "uuid"]).optional(),
    })
    .strict(),
);

/** Size/depth guard, applied on top of the structural schema. */
export function contractTooLarge(contract: JsonContract): string | null {
  let nodes = 0;
  const walk = (c: JsonContract, depth: number): string | null => {
    if (++nodes > MAX_NODES) return `Contracts are limited to ${MAX_NODES} nodes`;
    if (depth > MAX_DEPTH) return `Contracts are limited to ${MAX_DEPTH} levels of nesting`;
    for (const child of Object.values(c.properties ?? {})) {
      const issue = walk(child, depth + 1);
      if (issue) return issue;
    }
    return c.items ? walk(c.items, depth + 1) : null;
  };
  return walk(contract, 0);
}

const FORMATS: Record<NonNullable<JsonContract["format"]>, (s: string) => boolean> = {
  email: (s) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/.test(s),
  uri: (s) => {
    try {
      return Boolean(new URL(s).protocol);
    } catch {
      return false;
    }
  },
  "date-time": (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s) && !Number.isNaN(Date.parse(s)),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
};

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const escapePointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Returns contract violations as "<json pointer>: <problem>" (at most `limit`). */
export function checkContract(value: unknown, contract: JsonContract, limit = 20): string[] {
  const issues: string[] = [];
  const add = (path: string, message: string) => {
    if (issues.length < limit) issues.push(`${path || "/"}: ${message}`);
  };
  const walk = (v: unknown, c: JsonContract, path: string) => {
    if (issues.length >= limit) return;
    if (v === null && c.nullable) return;
    const actual = typeOf(v);
    const typeOk = c.type === "integer" ? typeof v === "number" && Number.isInteger(v) : c.type === "number" ? typeof v === "number" && Number.isFinite(v) : actual === c.type;
    if (!typeOk) return add(path, `expected ${c.type}${c.nullable ? " or null" : ""}, got ${actual}`);
    if (c.enum && !c.enum.some((e) => e === v)) add(path, `expected one of ${c.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    if (typeof v === "number") {
      if (c.minimum !== undefined && v < c.minimum) add(path, `expected ≥ ${c.minimum}, got ${v}`);
      if (c.maximum !== undefined && v > c.maximum) add(path, `expected ≤ ${c.maximum}, got ${v}`);
    }
    if (typeof v === "string") {
      if (c.minLength !== undefined && v.length < c.minLength) add(path, `expected at least ${c.minLength} characters`);
      if (c.maxLength !== undefined && v.length > c.maxLength) add(path, `expected at most ${c.maxLength} characters`);
      if (c.format && !FORMATS[c.format](v)) add(path, `expected format ${c.format}`);
    }
    if (Array.isArray(v)) {
      if (c.minItems !== undefined && v.length < c.minItems) add(path, `expected at least ${c.minItems} items, got ${v.length}`);
      if (c.maxItems !== undefined && v.length > c.maxItems) add(path, `expected at most ${c.maxItems} items, got ${v.length}`);
      if (c.items) v.slice(0, 200).forEach((item, i) => walk(item, c.items!, `${path}/${i}`));
    }
    if (actual === "object") {
      const obj = v as Record<string, unknown>;
      for (const key of c.required ?? []) if (!(key in obj)) add(`${path}/${escapePointer(key)}`, "required property is missing");
      for (const [key, child] of Object.entries(c.properties ?? {})) if (key in obj) walk(obj[key], child, `${path}/${escapePointer(key)}`);
      if (c.additionalProperties === false) {
        for (const key of Object.keys(obj)) if (!(key in (c.properties ?? {}))) add(`${path}/${escapePointer(key)}`, "unexpected property");
      }
    }
  };
  walk(value, contract, "");
  return issues;
}

export const jsonPointerSchema = z
  .string()
  .max(300)
  .regex(/^(?:\/[^/]*)*$/, "Use a JSON pointer such as /items/0/price");

/** Resolves an RFC 6901 JSON pointer; undefined if the path doesn't exist. */
export function resolvePointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (current && typeof current === "object" && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}
