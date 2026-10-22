/**
 * Mutation operators for black-box mutation testing. A mutant is one small, deliberate change
 * to a response the application sends (a number, a missing field, a server error, a missing
 * heading). If an approved plan still passes with the change in place, nothing in the plan
 * would notice that kind of defect there: a "surviving" mutant points at a gap.
 *
 * Mutants are derived only from responses observed during a passing baseline run, enumerated
 * in a stable order, and applied to responses only (requests are never altered).
 */

export type MutantTarget = { type: "document" | "api"; method: string; path: string };
export type MutationOperator = "NUMBER_CHANGED" | "FIELD_REMOVED" | "SERVER_ERROR" | "TEXT_NUMBER_CHANGED" | "HEADING_REMOVED";

export type Mutant = {
  id: string;
  operator: MutationOperator;
  target: MutantTarget;
  /** JSON pointer (API operators) or occurrence index (HTML operators). */
  location: string | null;
  description: string;
};

export type ObservedSample = MutantTarget & { status: number; contentType: string; body: string };

export const OPERATOR_LABELS: Record<MutationOperator, string> = {
  NUMBER_CHANGED: "A number in an API response changes",
  FIELD_REMOVED: "A field disappears from an API response",
  SERVER_ERROR: "The response becomes a 500 error",
  TEXT_NUMBER_CHANGED: "A number shown on the page changes",
  HEADING_REMOVED: "The page's main heading disappears",
};

const isJson = (s: ObservedSample) => /json/i.test(s.contentType);
const isHtml = (s: ObservedSample) => /html/i.test(s.contentType);
const escapePointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Numeric leaves and removable fields of a JSON document (breadth-first, bounded). */
function jsonSites(value: unknown): { numbers: string[]; fields: string[] } {
  const numbers: string[] = [];
  const fields: string[] = [];
  const queue: Array<[unknown, string, number]> = [[value, "", 0]];
  while (queue.length && numbers.length + fields.length < 200) {
    const [node, pointer, depth] = queue.shift()!;
    if (typeof node === "number" && Number.isFinite(node)) numbers.push(pointer);
    if (depth >= 6 || !node || typeof node !== "object") continue;
    if (Array.isArray(node)) node.slice(0, 3).forEach((child, i) => queue.push([child, `${pointer}/${i}`, depth + 1]));
    else
      for (const [key, child] of Object.entries(node)) {
        fields.push(`${pointer}/${escapePointer(key)}`);
        queue.push([child, `${pointer}/${escapePointer(key)}`, depth + 1]);
      }
  }
  return { numbers, fields };
}

/** Text segments between tags that contain digits, outside <script>/<style>/<title>. */
function htmlNumberSites(html: string): number {
  const visible = html.replace(/<(script|style|title)\b[\s\S]*?<\/\1>/gi, (m) => " ".repeat(m.length));
  return [...visible.matchAll(/>([^<]*\d[^<]*)</g)].length;
}

/** Stable, bounded list of mutants for the observed responses. */
export function enumerateMutants(samples: ObservedSample[], limit: number): Mutant[] {
  const mutants: Mutant[] = [];
  const seen = new Set<string>();
  const ordered = [...samples].filter((s) => s.status >= 200 && s.status < 300).sort((a, b) => `${a.type} ${a.method} ${a.path}`.localeCompare(`${b.type} ${b.method} ${b.path}`));
  // Round-robin across responses so a small limit still spreads mutants over the app.
  const perSample: Mutant[][] = [];
  for (const sample of ordered) {
    const target: MutantTarget = { type: sample.type, method: sample.method, path: sample.path };
    const where = `${sample.method} ${sample.path}`;
    const list: Mutant[] = [];
    const add = (operator: MutationOperator, location: string | null, description: string) => {
      const id = `${operator}:${sample.type}:${where}:${location ?? ""}`;
      if (!seen.has(id)) {
        seen.add(id);
        list.push({ id, operator, target, location, description });
      }
    };
    if (sample.type === "api" && isJson(sample)) {
      let json: unknown;
      try {
        json = JSON.parse(sample.body);
      } catch {
        json = undefined;
      }
      if (json !== undefined) {
        const { numbers, fields } = jsonSites(json);
        for (const pointer of numbers.slice(0, 3)) add("NUMBER_CHANGED", pointer, `${where}: the number at ${pointer} changes`);
        for (const pointer of fields.filter((f) => f.split("/").length === 2).slice(0, 2)) add("FIELD_REMOVED", pointer, `${where}: ${pointer} is missing`);
      }
    }
    if (sample.type === "document" && isHtml(sample)) {
      if (/<h1\b/i.test(sample.body)) add("HEADING_REMOVED", "0", `${where}: the <h1> heading is missing`);
      const sites = htmlNumberSites(sample.body);
      for (let i = 0; i < Math.min(sites, 2); i++) add("TEXT_NUMBER_CHANGED", String(i), `${where}: displayed number #${i + 1} changes`);
    }
    add("SERVER_ERROR", null, `${where} returns 500`);
    perSample.push(list);
  }
  for (let round = 0; mutants.length < limit && perSample.some((l) => l.length > round); round++) {
    for (const list of perSample) if (list[round] && mutants.length < limit) mutants.push(list[round]);
  }
  return mutants;
}

/** Changes a number in a way any correct check would notice. */
export function mutateNumber(value: number): number {
  if (Number.isInteger(value)) return value + 1;
  return Math.round((value * 1.1 + 0.01) * 100) / 100;
}

function setPointer(root: unknown, pointer: string, update: (parent: Record<string, unknown> | unknown[], key: string) => boolean): boolean {
  const parts = pointer.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (!node || typeof node !== "object") return false;
    node = (node as Record<string, unknown>)[part];
  }
  if (!node || typeof node !== "object") return false;
  return update(node as Record<string, unknown>, parts.at(-1)!);
}

export type ResponseLike = { status: number; contentType: string; body: string };

/** Applies a mutant to a matching response; null when it doesn't apply to this response. */
export function applyMutant(mutant: Mutant, response: ResponseLike & MutantTarget): ResponseLike | null {
  const { target } = mutant;
  if (response.type !== target.type || response.method !== target.method || response.path !== target.path) return null;
  if (response.status < 200 || response.status >= 300) return null;
  switch (mutant.operator) {
    case "SERVER_ERROR":
      return target.type === "api"
        ? { status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal Server Error" }) }
        : { status: 500, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>Error</title><p>Internal Server Error</p>" };
    case "NUMBER_CHANGED":
    case "FIELD_REMOVED": {
      let json: unknown;
      try {
        json = JSON.parse(response.body);
      } catch {
        return null;
      }
      const changed = setPointer(json, mutant.location!, (parent, key) => {
        if (Array.isArray(parent)) {
          const i = Number(key);
          if (mutant.operator !== "NUMBER_CHANGED" || typeof parent[i] !== "number") return false;
          parent[i] = mutateNumber(parent[i] as number);
          return true;
        }
        if (!Object.hasOwn(parent, key)) return false;
        if (mutant.operator === "FIELD_REMOVED") return delete parent[key];
        if (typeof parent[key] !== "number") return false;
        parent[key] = mutateNumber(parent[key] as number);
        return true;
      });
      return changed ? { ...response, body: JSON.stringify(json) } : null;
    }
    case "HEADING_REMOVED": {
      const body = response.body.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, "");
      return body === response.body ? null : { ...response, body };
    }
    case "TEXT_NUMBER_CHANGED": {
      const wanted = Number(mutant.location);
      const masked = response.body.replace(/<(script|style|title)\b[\s\S]*?<\/\1>/gi, (m) => " ".repeat(m.length));
      let index = 0;
      let result: string | null = null;
      for (const match of masked.matchAll(/>([^<]*\d[^<]*)</g)) {
        if (index++ !== wanted) continue;
        const start = match.index! + 1;
        const text = response.body.slice(start, start + match[1].length);
        const mutated = text.replace(/\d+(?:\.\d+)?/, (n) => String(mutateNumber(Number(n))));
        result = response.body.slice(0, start) + mutated + response.body.slice(start + match[1].length);
        break;
      }
      return result && result !== response.body ? { ...response, body: result } : null;
    }
  }
}
