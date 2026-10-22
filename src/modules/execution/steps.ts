import { z } from "zod";
import { isWithinAuthorizedUrl } from "@/modules/applications/authorized-url";
import { contractTooLarge, jsonContractSchema, jsonPointerSchema } from "./contract";
import { ExpressionError, expressionVariables, MAX_EXPRESSION_LENGTH, parseComparison, VARIABLE_NAME } from "./expression";

/**
 * The executable step language. This is the *only* thing the test runner executes: every
 * step maps to a fixed Playwright call, there is no `evaluate`/script action, and schemas are
 * strict (unknown keys are rejected), so generated content can never smuggle in code.
 */

const text = (max = 300) => z.string().trim().min(1).max(max);

/**
 * CSS only. Playwright engine prefixes (xpath=, text=, internal:…, js=) and the XPath/text
 * auto-detection forms (`//…`, `..`, quoted strings) are refused.
 */
export const NON_CSS_SELECTOR = /^\s*(?:[a-z_][\w-]*\s*=|internal:|_react|_vue|\/\/|\.\.|["'])/i;
export const cssSelector = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !NON_CSS_SELECTOR.test(value) && !/[\u0000-\u001f]/.test(value) && !/>>/.test(value), {
    message: "Use a plain CSS selector",
  });

export const ARIA_ROLES = [
  "alert", "button", "checkbox", "combobox", "dialog", "grid", "heading", "img", "link", "list",
  "listitem", "main", "menu", "menuitem", "navigation", "option", "progressbar", "radio",
  "region", "row", "search", "searchbox", "slider", "spinbutton", "status", "switch", "tab",
  "table", "tabpanel", "textbox", "tree", "banner", "contentinfo", "form", "cell", "columnheader",
] as const;

export const locatorSchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("css"), value: cssSelector }).strict(),
  z.object({ by: z.literal("role"), role: z.enum(ARIA_ROLES), name: text(200).optional(), exact: z.boolean().optional() }).strict(),
  z.object({ by: z.literal("label"), value: text(200), exact: z.boolean().optional() }).strict(),
  z.object({ by: z.literal("text"), value: text(200), exact: z.boolean().optional() }).strict(),
  z.object({ by: z.literal("placeholder"), value: text(200) }).strict(),
  z.object({ by: z.literal("testId"), value: z.string().regex(/^[\w.:-]{1,100}$/, "Invalid test id") }).strict(),
]);
export type Locator = z.infer<typeof locatorSchema>;

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Values extracted or generated earlier in the same case (lower_snake_case). */
export const variableName = z.string().regex(VARIABLE_NAME, "Variable names are lower_snake_case (max 40 characters)");

/**
 * A literal value, a secret reference (by name), a value captured earlier in the case, or a
 * fresh unique value (saved as a variable, so the case can later check it was persisted).
 */
export const fillValueSchema = z.union([
  z.object({ literal: z.string().max(1000) }).strict(),
  z.object({ secret: z.string().regex(SECRET_NAME, "Secret names are UPPER_SNAKE_CASE") }).strict(),
  z.object({ variable: variableName }).strict(),
  z.object({ unique: z.enum(["text", "email", "number"]), saveAs: variableName }).strict(),
]);
export type FillValue = z.infer<typeof fillValueSchema>;

/** Relative path ("/cart") or absolute http(s) URL; scope is checked against the authorized URL. */
const urlOrPath = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => value.startsWith("/") ? !value.startsWith("//") : /^https?:\/\//i.test(value), "Use a path like /cart or an http(s) URL");

const MAX_WAIT_MS = 15_000;

const comparisonExpression = z
  .string()
  .trim()
  .min(3)
  .max(MAX_EXPRESSION_LENGTH)
  .superRefine((value, ctx) => {
    try {
      parseComparison(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof ExpressionError ? error.message : "Invalid expression" });
    }
  });

const contract = jsonContractSchema.superRefine((value, ctx) => {
  const issue = contractTooLarge(value);
  if (issue) ctx.addIssue({ code: "custom", message: issue });
});

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const DEFAULT_MAX_DIFF_RATIO = 0.001;
export const DEFAULT_PIXEL_THRESHOLD = 0.1;

export const stepParamsSchemas = {
  NAVIGATE: z.object({ url: urlOrPath }).strict(),
  CLICK: z.object({ target: locatorSchema }).strict(),
  FILL: z.object({ target: locatorSchema, value: fillValueSchema }).strict(),
  SELECT: z.object({ target: locatorSchema, option: z.string().max(200) }).strict(),
  WAIT: z
    .object({
      for: z.enum(["visible", "hidden", "url", "time"]),
      target: locatorSchema.optional(),
      urlContains: z.string().max(500).optional(),
      ms: z.number().int().min(50).max(MAX_WAIT_MS).optional(),
    })
    .strict()
    .refine((w) => (w.for === "visible" || w.for === "hidden" ? Boolean(w.target) : w.for === "url" ? Boolean(w.urlContains) : Boolean(w.ms)), {
      message: "wait needs a target (visible/hidden), urlContains (url) or ms (time)",
    }),
  ASSERT: z
    .object({
      check: z.enum(["visible", "hidden", "textContains", "textEquals", "valueEquals", "urlContains", "titleContains", "count"]),
      target: locatorSchema.optional(),
      expected: z.union([z.string().max(1000), z.number().int().min(0).max(10_000)]).optional(),
      /** Compare with a value captured earlier in the case instead of a literal. */
      expectedVariable: variableName.optional(),
    })
    .strict()
    .refine((a) => (["urlContains", "titleContains"].includes(a.check) ? a.expected !== undefined || a.expectedVariable !== undefined : Boolean(a.target)), {
      message: "assertion needs a target (or an expected value for url/title checks)",
    })
    .refine((a) => (["visible", "hidden"].includes(a.check) ? true : (a.expected !== undefined) !== (a.expectedVariable !== undefined)), {
      message: "assertion needs exactly one of expected or expectedVariable",
    }),
  /** Reloads the current page: checks that state survives a reload (i.e. was persisted). */
  RELOAD: z.object({}).strict(),
  /** Captures a value into a variable: element text/value, a JSON field of a response, or the URL. */
  EXTRACT: z
    .object({
      name: variableName,
      from: z.discriminatedUnion("source", [
        z.object({ source: z.literal("element"), target: locatorSchema, property: z.enum(["text", "value"]) }).strict(),
        z.object({ source: z.literal("response"), response: variableName, pointer: jsonPointerSchema }).strict(),
        z.object({ source: z.literal("url"), part: z.enum(["path", "query"]), param: z.string().min(1).max(100).optional() }).strict(),
      ]),
      as: z.enum(["text", "number"]),
      /** Decimal separator of displayed numbers ("1.234,50" uses ","). */
      decimal: z.enum([".", ","]).optional(),
    })
    .strict(),
  /** Business rule: an independent calculation over captured values, e.g. `round(subtotal * 0.9, 2) == total`. */
  ASSERT_CALC: z.object({ expression: comparisonExpression, tolerance: z.number().min(0).max(1_000_000).optional() }).strict(),
  /** Read-only request from the signed-in page to the application (same origin, GET only). */
  API_GET: z.object({ url: urlOrPath, saveAs: variableName }).strict(),
  /** API contract check on a response fetched with API_GET, or one the page made itself. */
  ASSERT_RESPONSE: z
    .object({
      response: variableName.optional(),
      match: z.object({ method: z.enum(HTTP_METHODS).optional(), urlContains: z.string().trim().min(1).max(500) }).strict().optional(),
      /** Saves a matched page response for later EXTRACT steps. */
      saveAs: variableName.optional(),
      status: z.union([z.number().int().min(100).max(599), z.object({ min: z.number().int().min(100).max(599), max: z.number().int().min(100).max(599) }).strict()]).optional(),
      contentType: z.string().trim().min(1).max(100).optional(),
      contract: contract.optional(),
      equals: z.array(z.object({ pointer: jsonPointerSchema, value: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]) }).strict()).min(1).max(20).optional(),
    })
    .strict()
    .refine((a) => (a.response === undefined) !== (a.match === undefined), { message: "check needs exactly one of response or match" })
    .refine((a) => !(a.saveAs && a.response), { message: "saveAs only applies to matched page responses" })
    .refine((a) => a.status !== undefined || a.contentType !== undefined || a.contract !== undefined || a.equals !== undefined, {
      message: "check needs at least one of status, contentType, contract or equals",
    }),
  /**
   * Visual check against the reviewer-approved baseline named `name` (per case). Without an
   * approved baseline the capture becomes a candidate for review and the step is inconclusive.
   */
  ASSERT_VISUAL: z
    .object({
      name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/, "Baseline names are lowercase letters, digits, - and _"),
      /** Element to capture; the viewport when omitted. */
      target: locatorSchema.optional(),
      /** Dynamic regions (dates, ads, avatars) painted over before comparing. */
      mask: z.array(locatorSchema).max(10).optional(),
      /** Share of pixels allowed to differ (default 0.001 = 0.1%). */
      maxDiffRatio: z.number().min(0).max(0.2).optional(),
      /** Per-pixel colour tolerance, 0–1 (default 0.1). */
      threshold: z.number().min(0).max(1).optional(),
    })
    .strict(),
} as const;

export type StepKindName = keyof typeof stepParamsSchemas;
export const STEP_KINDS = Object.keys(stepParamsSchemas) as StepKindName[];

/** A step as authored/generated: human description + executable action. */
export const executableStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NAVIGATE"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.NAVIGATE }).strict(),
  z.object({ kind: z.literal("CLICK"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.CLICK }).strict(),
  z.object({ kind: z.literal("FILL"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.FILL }).strict(),
  z.object({ kind: z.literal("SELECT"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.SELECT }).strict(),
  z.object({ kind: z.literal("WAIT"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.WAIT }).strict(),
  z.object({ kind: z.literal("ASSERT"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.ASSERT }).strict(),
  z.object({ kind: z.literal("RELOAD"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.RELOAD }).strict(),
  z.object({ kind: z.literal("EXTRACT"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.EXTRACT }).strict(),
  z.object({ kind: z.literal("ASSERT_CALC"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.ASSERT_CALC }).strict(),
  z.object({ kind: z.literal("API_GET"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.API_GET }).strict(),
  z.object({ kind: z.literal("ASSERT_RESPONSE"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.ASSERT_RESPONSE }).strict(),
  z.object({ kind: z.literal("ASSERT_VISUAL"), description: text(300), expected: z.string().max(500).optional(), params: stepParamsSchemas.ASSERT_VISUAL }).strict(),
]);
export type ExecutableStep = z.infer<typeof executableStepSchema>;

export function parseStepParams(kind: StepKindName, params: unknown) {
  return stepParamsSchemas[kind].safeParse(params);
}

/**
 * Checks data flow inside a case: every variable or response is defined before it's used,
 * names aren't reused for different kinds of data, and values are numbers/text as needed.
 * Returns readable problems (empty when the sequence is sound).
 */
export function stepSequenceIssues(steps: Array<{ kind: string | null; params: unknown }>): string[] {
  const values = new Set<string>();
  const responses = new Set<string>();
  const baselines = new Set<string>();
  const issues: string[] = [];
  const define = (n: number, name: string, as: "value" | "response") => {
    if ((as === "value" ? responses : values).has(name)) issues.push(`Step ${n}: ${name} is already used for a ${as === "value" ? "response" : "value"}`);
    (as === "value" ? values : responses).add(name);
  };
  const needValue = (n: number, name: string) => {
    if (!values.has(name)) issues.push(`Step ${n}: variable ${name} is used before a step defines it`);
  };
  const needResponse = (n: number, name: string) => {
    if (!responses.has(name)) issues.push(`Step ${n}: response ${name} is used before an API_GET or ASSERT_RESPONSE step saves it`);
  };
  steps.forEach((step, i) => {
    const n = i + 1;
    if (!step.kind || !(step.kind in stepParamsSchemas)) return;
    const parsed = stepParamsSchemas[step.kind as StepKindName].safeParse(step.params);
    if (!parsed.success) return;
    const p = parsed.data as Record<string, unknown>;
    switch (step.kind) {
      case "FILL": {
        const value = p.value as FillValue;
        if ("variable" in value) needValue(n, value.variable);
        if ("unique" in value) define(n, value.saveAs, "value");
        break;
      }
      case "ASSERT":
        if (p.expectedVariable) needValue(n, p.expectedVariable as string);
        break;
      case "EXTRACT": {
        const from = p.from as { source: string; response?: string };
        if (from.source === "response") needResponse(n, from.response!);
        define(n, p.name as string, "value");
        break;
      }
      case "ASSERT_CALC":
        for (const name of expressionVariables(parseComparison(p.expression as string))) needValue(n, name);
        break;
      case "API_GET":
        define(n, p.saveAs as string, "response");
        break;
      case "ASSERT_VISUAL":
        if (baselines.has(p.name as string)) issues.push(`Step ${n}: visual baseline name ${p.name} is used twice in this case`);
        baselines.add(p.name as string);
        break;
      case "ASSERT_RESPONSE":
        if (p.response) needResponse(n, p.response as string);
        if (p.saveAs) define(n, p.saveAs as string, "response");
        break;
    }
  });
  return issues;
}

/** A whole case's executable steps, including the data-flow check. */
export const executableStepsSchema = z
  .array(executableStepSchema)
  .min(1)
  .max(50)
  .superRefine((steps, ctx) => {
    for (const message of stepSequenceIssues(steps)) ctx.addIssue({ code: "custom", message });
  });

/** Resolves a NAVIGATE target against the authorized URL; null if it leaves the authorized scope. */
export function resolveNavigation(urlOrPathValue: string, authorizedUrl: string): string | null {
  // (Also used for API_GET targets: same scope rules.)
  try {
    const base = new URL(authorizedUrl);
    const target = urlOrPathValue.startsWith("/") ? new URL(urlOrPathValue, base.origin) : new URL(urlOrPathValue);
    if (target.username || target.password) return null;
    return isWithinAuthorizedUrl(target.toString(), authorizedUrl) ? target.toString() : null;
  } catch {
    return null;
  }
}

/** Secret names a step list depends on (to verify they exist before running). */
export function referencedSecrets(steps: Array<{ kind: string | null; params: unknown }>): string[] {
  const names = new Set<string>();
  for (const step of steps) {
    if (step.kind === "FILL") {
      const parsed = stepParamsSchemas.FILL.safeParse(step.params);
      if (parsed.success && "secret" in parsed.data.value) names.add(parsed.data.value.secret);
    }
  }
  return [...names];
}

/** Human-readable rendering of a step's action (used in reports; secrets are masked). */
export function describeAction(kind: string | null, params: unknown): string {
  const loc = (l: Locator) =>
    l.by === "role" ? `role=${l.role}${l.name ? ` "${l.name}"` : ""}` : l.by === "css" ? l.value : `${l.by} "${l.value}"`;
  switch (kind) {
    case "NAVIGATE": return `Go to ${(params as { url: string }).url}`;
    case "CLICK": return `Click ${loc((params as { target: Locator }).target)}`;
    case "FILL": {
      const p = params as { target: Locator; value: FillValue };
      const v = p.value;
      return `Fill ${loc(p.target)} with ${"secret" in v ? `secret ${v.secret}` : "variable" in v ? `{${v.variable}}` : "unique" in v ? `a unique ${v.unique} {${v.saveAs}}` : JSON.stringify(v.literal)}`;
    }
    case "SELECT": { const p = params as { target: Locator; option: string }; return `Select "${p.option}" in ${loc(p.target)}`; }
    case "WAIT": { const p = params as { for: string; target?: Locator; urlContains?: string; ms?: number }; return `Wait for ${p.for}${p.target ? ` ${loc(p.target)}` : ""}${p.urlContains ? ` "${p.urlContains}"` : ""}${p.ms ? ` ${p.ms}ms` : ""}`; }
    case "ASSERT": { const p = params as { check: string; target?: Locator; expected?: string | number; expectedVariable?: string }; return `Assert ${p.check}${p.target ? ` ${loc(p.target)}` : ""}${p.expected !== undefined ? ` = ${JSON.stringify(p.expected)}` : ""}${p.expectedVariable ? ` = {${p.expectedVariable}}` : ""}`; }
    case "RELOAD": return "Reload the page";
    case "EXTRACT": {
      const p = params as { name: string; as: string; from: { source: string; target?: Locator; property?: string; response?: string; pointer?: string; part?: string; param?: string } };
      const from = p.from.source === "element" ? `${p.from.property} of ${loc(p.from.target!)}` : p.from.source === "response" ? `${p.from.response}${p.from.pointer || "/"}` : `URL ${p.from.part}${p.from.param ? ` "${p.from.param}"` : ""}`;
      return `Save ${from} as ${p.as} {${p.name}}`;
    }
    case "ASSERT_CALC": return `Check ${(params as { expression: string }).expression}`;
    case "API_GET": { const p = params as { url: string; saveAs: string }; return `GET ${p.url} as {${p.saveAs}}`; }
    case "ASSERT_RESPONSE": {
      const p = params as { response?: string; match?: { method?: string; urlContains: string }; status?: number | { min: number; max: number }; contract?: unknown; equals?: unknown[]; contentType?: string };
      const which = p.response ? `{${p.response}}` : `${p.match!.method ?? "any"} request containing "${p.match!.urlContains}"`;
      const checks = [
        p.status !== undefined ? `status ${typeof p.status === "number" ? p.status : `${p.status.min}–${p.status.max}`}` : null,
        p.contentType ? `type ${p.contentType}` : null,
        p.contract ? "matches contract" : null,
        p.equals ? `${p.equals.length} field value${p.equals.length === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      return `Check response ${which}: ${checks.join(", ")}`;
    }
    case "ASSERT_VISUAL": {
      const p = params as { name: string; target?: Locator; mask?: Locator[]; maxDiffRatio?: number };
      return `Compare ${p.target ? loc(p.target) : "the viewport"} with baseline "${p.name}"${p.mask?.length ? ` (${p.mask.length} masked)` : ""} within ${((p.maxDiffRatio ?? DEFAULT_MAX_DIFF_RATIO) * 100).toFixed(2)}%`;
    }
    default: return "Manual step";
  }
}
