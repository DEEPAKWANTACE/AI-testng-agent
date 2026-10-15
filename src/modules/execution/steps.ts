import { z } from "zod";
import { isWithinAuthorizedUrl } from "@/modules/applications/authorized-url";

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
/** A literal value, or a reference to one of the application's secret references by name. */
export const fillValueSchema = z.union([
  z.object({ literal: z.string().max(1000) }).strict(),
  z.object({ secret: z.string().regex(SECRET_NAME, "Secret names are UPPER_SNAKE_CASE") }).strict(),
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
    })
    .strict()
    .refine((a) => (["urlContains", "titleContains"].includes(a.check) ? a.expected !== undefined : Boolean(a.target)), {
      message: "assertion needs a target (or an expected value for url/title checks)",
    })
    .refine((a) => (["visible", "hidden"].includes(a.check) ? true : a.expected !== undefined), { message: "assertion needs an expected value" }),
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
]);
export type ExecutableStep = z.infer<typeof executableStepSchema>;

export function parseStepParams(kind: StepKindName, params: unknown) {
  return stepParamsSchemas[kind].safeParse(params);
}

/** Resolves a NAVIGATE target against the authorized URL; null if it leaves the authorized scope. */
export function resolveNavigation(urlOrPathValue: string, authorizedUrl: string): string | null {
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
      return `Fill ${loc(p.target)} with ${"secret" in p.value ? `secret ${p.value.secret}` : JSON.stringify(p.value.literal)}`;
    }
    case "SELECT": { const p = params as { target: Locator; option: string }; return `Select "${p.option}" in ${loc(p.target)}`; }
    case "WAIT": { const p = params as { for: string; target?: Locator; urlContains?: string; ms?: number }; return `Wait for ${p.for}${p.target ? ` ${loc(p.target)}` : ""}${p.urlContains ? ` "${p.urlContains}"` : ""}${p.ms ? ` ${p.ms}ms` : ""}`; }
    case "ASSERT": { const p = params as { check: string; target?: Locator; expected?: string | number }; return `Assert ${p.check}${p.target ? ` ${loc(p.target)}` : ""}${p.expected !== undefined ? ` = ${JSON.stringify(p.expected)}` : ""}`; }
    default: return "Manual step";
  }
}
