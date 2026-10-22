import { describe, expect, it } from "vitest";
import { checkContract, contractTooLarge, resolvePointer, type JsonContract } from "@/modules/execution/contract";
import { evaluateComparison, ExpressionError, expressionVariables, parseComparison, parseDisplayedNumber } from "@/modules/execution/expression";
import { describeAction, executableStepSchema, executableStepsSchema, stepSequenceIssues } from "@/modules/execution/steps";
import { GENERATION_JSON_SCHEMA, generatedCaseSchema } from "@/modules/generation/schema";

const vars = new Map<string, number | string>([["subtotal", 108], ["total", 97.2], ["price", 89], ["qty", 2], ["name", "Sam"]]);
const check = (source: string, tolerance?: number) => evaluateComparison(parseComparison(source), vars, tolerance);

describe("business-rule expressions", () => {
  it.each([
    ["round(subtotal * 0.9, 2) == total", true],
    ["subtotal - subtotal * 10 / 100 == total", true],
    ["price * qty == subtotal", false],
    ["price * qty == 178", true],
    ["-price + 100 == 11", true],
    ["(price + 1) * qty >= 180", true],
    ["max(price, qty, 5) == 89", true],
    ["min(price, qty) < 3", true],
    ["abs(total - subtotal) > 10", true],
    ["floor(total) == 97", true],
    ["ceil(total) != 97", true],
    ["subtotal % 10 == 8", true],
    ['name == "Sam"', true],
    ['name != "Alex"', true],
  ])("%s → %s", (source, ok) => {
    expect(check(source).ok).toBe(ok);
  });

  it("compares money within half a cent by default, and with a custom tolerance", () => {
    expect(evaluateComparison(parseComparison("0.1 + 0.2 == 0.3"), vars).ok).toBe(true);
    expect(check("total == 97.204").ok).toBe(true);
    expect(check("total == 97.21").ok).toBe(false);
    expect(check("total == 97.5", 0.5).ok).toBe(true);
    expect(check("total < 97.204").ok).toBe(false); // equal within tolerance is not "less"
  });

  it("reports the evaluated sides", () => {
    expect(check("price * qty == subtotal")).toMatchObject({ ok: false, left: 178, right: 108, op: "==" });
  });

  it.each([
    ["subtotal", /exactly one comparison/],
    ["a == b == c", /Unexpected text/],
    ["constructor == 1", null], // just a (missing) variable name, never a property lookup
    ["process.exit() == 1", /Unexpected character/],
    ["alert(1) == 1", /Unknown function alert/],
    ["round() == 1", /takes 1–2 arguments/],
    ["`x` == 1", /Unexpected character/],
    ["x[0] == 1", /Unexpected character/],
    ["x = 1", /Unexpected character|exactly one comparison/],
    ['"abc == 1', /Unterminated string/],
    ["Total == 1", /Unexpected character/],
    ["(".repeat(20) + "1" + ")".repeat(20) + " == 1", /nested too deeply/],
    ["1 + ".repeat(80) + "1 == 1", /limited to 300 characters/],
    ["1+".repeat(70) + "1==1", /too long/],
  ])("rejects %s", (source, message) => {
    if (message) expect(() => parseComparison(source)).toThrow(message);
    else expect(() => check(source)).toThrow(/has no value/);
  });

  it("refuses arithmetic on text, ordering of text, and division by zero", () => {
    expect(() => check("name + 1 == 2")).toThrow(ExpressionError);
    expect(() => check('name < "Z"')).toThrow(/needs numbers/);
    expect(() => check("price / 0 == 1")).toThrow(/Division by zero/);
  });

  it("lists the variables an expression reads", () => {
    expect(expressionVariables(parseComparison("round(subtotal * (1 - discount_rate), 2) == total")).sort()).toEqual(["discount_rate", "subtotal", "total"]);
  });
});

describe("reading displayed numbers", () => {
  it.each([
    ["$1,234.50", ".", 1234.5],
    ["Total: $108.00", ".", 108],
    ["2 items", ".", 2],
    ["108 3 items", ".", 108],
    ["1234.5", ".", 1234.5],
    ["€ 1.234,50", ",", 1234.5],
    ["1 234 567 kr", ".", 1234567],
    ["-12.5%", ".", -12.5],
    ["Price on request", ".", null],
  ] as Array<[string, "." | ",", number | null]>)("%s (%s) → %s", (text, decimal, expected) => {
    expect(parseDisplayedNumber(text, decimal)).toBe(expected);
  });
});

describe("API contracts", () => {
  const cart: JsonContract = {
    type: "object",
    required: ["items", "total", "currency"],
    additionalProperties: false,
    properties: {
      items: { type: "array", minItems: 1, items: { type: "object", required: ["productId", "quantity"], properties: { productId: { type: "integer" }, quantity: { type: "integer", minimum: 1, maximum: 99 } } } },
      total: { type: "number", minimum: 0 },
      currency: { type: "string", enum: ["USD", "EUR"] },
      coupon: { type: "string", nullable: true },
    },
  };

  it("accepts a conforming body", () => {
    expect(checkContract({ items: [{ productId: 1, quantity: 2 }], total: 178, currency: "USD", coupon: null }, cart)).toEqual([]);
  });

  it("reports each violation with its JSON pointer", () => {
    expect(checkContract({ items: [{ productId: 1.5, quantity: 0 }], total: -1, currency: "GBP", extra: true }, cart)).toEqual([
      "/items/0/productId: expected integer, got number",
      "/items/0/quantity: expected ≥ 1, got 0",
      "/total: expected ≥ 0, got -1",
      '/currency: expected one of "USD", "EUR"',
      "/extra: unexpected property",
    ]);
    expect(checkContract({ items: [] }, cart)).toEqual(["/total: required property is missing", "/currency: required property is missing", "/items: expected at least 1 items, got 0"]);
    expect(checkContract([], cart)).toEqual(["/: expected object, got array"]);
  });

  it("checks formats without user-supplied regexes", () => {
    const c: JsonContract = { type: "object", properties: { email: { type: "string", format: "email" }, at: { type: "string", format: "date-time" }, id: { type: "string", format: "uuid" } } };
    expect(checkContract({ email: "a@b.co", at: "2026-10-16T08:00:00Z", id: "123e4567-e89b-12d3-a456-426614174000" }, c)).toEqual([]);
    expect(checkContract({ email: "nope", at: "yesterday", id: "1" }, c)).toHaveLength(3);
  });

  it("bounds contract size and depth, and rejects unknown keywords", () => {
    let deep: JsonContract = { type: "string" };
    for (let i = 0; i < 10; i++) deep = { type: "array", items: deep };
    expect(contractTooLarge(deep)).toMatch(/levels of nesting/);
    expect(executableStepSchema.safeParse({ kind: "ASSERT_RESPONSE", description: "x", params: { response: "r", contract: { type: "string", pattern: "(a+)+$" } } }).success).toBe(false);
    expect(executableStepSchema.safeParse({ kind: "ASSERT_RESPONSE", description: "x", params: { response: "r", contract: deep } }).success).toBe(false);
  });

  it("resolves JSON pointers", () => {
    const doc = { items: [{ price: 89 }], "a/b": { "c~d": 1 } };
    expect(resolvePointer(doc, "/items/0/price")).toBe(89);
    expect(resolvePointer(doc, "/a~1b/c~0d")).toBe(1);
    expect(resolvePointer(doc, "/items/5/price")).toBeUndefined();
    expect(resolvePointer(doc, "/items/x")).toBeUndefined();
    expect(resolvePointer(doc, "/constructor")).toBeUndefined();
    expect(resolvePointer(doc, "")).toBe(doc);
  });
});

describe("data-flow steps", () => {
  const steps = [
    { kind: "NAVIGATE", description: "Cart", params: { url: "/cart" } },
    { kind: "EXTRACT", description: "Subtotal", params: { name: "subtotal", from: { source: "element", target: { by: "testId", value: "subtotal" }, property: "text" }, as: "number" } },
    { kind: "API_GET", description: "Cart API", params: { url: "/api/cart", saveAs: "cart_api" } },
    { kind: "ASSERT_RESPONSE", description: "Contract", params: { response: "cart_api", status: 200, contract: { type: "object", required: ["total"] } } },
    { kind: "EXTRACT", description: "API total", params: { name: "api_total", from: { source: "response", response: "cart_api", pointer: "/total" }, as: "number" } },
    { kind: "ASSERT_CALC", description: "Totals agree", params: { expression: "round(subtotal, 2) >= api_total" } },
    { kind: "FILL", description: "Name", params: { target: { by: "label", value: "Name" }, value: { unique: "text", saveAs: "new_name" } } },
    { kind: "RELOAD", description: "Reload", params: {} },
    { kind: "ASSERT", description: "Persisted", params: { check: "valueEquals", target: { by: "label", value: "Name" }, expectedVariable: "new_name" } },
  ];

  it("accepts a sound sequence", () => {
    expect(executableStepsSchema.safeParse(steps).success).toBe(true);
    expect(stepSequenceIssues(steps)).toEqual([]);
  });

  it("rejects values and responses used before they're defined, or mixed up", () => {
    const issues = stepSequenceIssues([
      { kind: "ASSERT_CALC", params: { expression: "total == subtotal" } },
      { kind: "EXTRACT", params: { name: "x", from: { source: "response", response: "nope", pointer: "/a" }, as: "text" } },
      { kind: "API_GET", params: { url: "/api", saveAs: "x" } },
      { kind: "FILL", params: { target: { by: "label", value: "A" }, value: { variable: "later" } } },
      { kind: "ASSERT", params: { check: "textEquals", target: { by: "css", value: "h1" }, expectedVariable: "missing" } },
    ]);
    expect(issues).toEqual([
      "Step 1: variable total is used before a step defines it",
      "Step 1: variable subtotal is used before a step defines it",
      "Step 2: response nope is used before an API_GET or ASSERT_RESPONSE step saves it",
      "Step 3: x is already used for a value",
      "Step 4: variable later is used before a step defines it",
      "Step 5: variable missing is used before a step defines it",
    ]);
    expect(executableStepsSchema.safeParse([steps[5]]).success).toBe(false);
  });

  it("validates the new step parameters strictly", () => {
    const bad = [
      { kind: "ASSERT_CALC", description: "x", params: { expression: "total" } },
      { kind: "ASSERT_CALC", description: "x", params: { expression: "eval(1) == 1" } },
      { kind: "EXTRACT", description: "x", params: { name: "Bad-Name", from: { source: "url", part: "path" }, as: "text" } },
      { kind: "EXTRACT", description: "x", params: { name: "a", from: { source: "element", target: { by: "css", value: "h1" }, property: "innerHTML" }, as: "text" } },
      { kind: "API_GET", description: "x", params: { url: "javascript:alert(1)", saveAs: "r" } },
      { kind: "API_GET", description: "x", params: { url: "/api", saveAs: "r", method: "POST" } },
      { kind: "ASSERT_RESPONSE", description: "x", params: { response: "r" } },
      { kind: "ASSERT_RESPONSE", description: "x", params: { response: "r", match: { urlContains: "/api" }, status: 200 } },
      { kind: "ASSERT_RESPONSE", description: "x", params: { response: "r", saveAs: "s", status: 200 } },
      { kind: "RELOAD", description: "x", params: { hard: true } },
      { kind: "FILL", description: "x", params: { target: { by: "label", value: "A" }, value: { unique: "uuid", saveAs: "a" } } },
      { kind: "ASSERT", description: "x", params: { check: "textEquals", target: { by: "css", value: "h1" }, expected: "a", expectedVariable: "b" } },
    ];
    for (const step of bad) expect(executableStepSchema.safeParse(step).success, JSON.stringify(step)).toBe(false);
  });

  it("describes the new steps for reports", () => {
    expect(describeAction("ASSERT_CALC", { expression: "a == b" })).toBe("Check a == b");
    expect(describeAction("API_GET", { url: "/api/cart", saveAs: "cart" })).toBe("GET /api/cart as {cart}");
    expect(describeAction("ASSERT_RESPONSE", { match: { method: "GET", urlContains: "/api/cart" }, status: 200, contract: { type: "object" } })).toBe('Check response GET request containing "/api/cart": status 200, matches contract');
    expect(describeAction("FILL", { target: { by: "label", value: "Name" }, value: { unique: "email", saveAs: "email" } })).toBe('Fill label "Name" with a unique email {email}');
    expect(describeAction("EXTRACT", { name: "total", as: "number", from: { source: "element", target: { by: "testId", value: "total" }, property: "text" } })).toBe('Save text of testId "total" as number {total}');
  });

  it("applies the same rules to generated cases, and the provider schema still serializes", () => {
    const generated = { title: "Totals", feature: "Cart", category: "POSITIVE", priority: "HIGH", prerequisites: [], expectedResult: "Totals add up", coverage: { requirements: [] } };
    expect(generatedCaseSchema.safeParse({ ...generated, steps }).success).toBe(true);
    expect(generatedCaseSchema.safeParse({ ...generated, steps: [steps[5]] }).success).toBe(false);
    expect(JSON.stringify(GENERATION_JSON_SCHEMA)).toContain("ASSERT_CALC");
  });
});
