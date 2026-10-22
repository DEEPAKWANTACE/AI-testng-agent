import { describe, expect, it } from "vitest";
import { DEMO_OPENAPI } from "../../demo/target-app";
import { inventoryCases } from "@/modules/generation/heuristic";
import { INVENTORY_FEATURES, type InventoryContext } from "@/modules/generation/inventory-context";
import { buildPrompt, type GenerationContext } from "@/modules/generation/prompt";
import { generatedCaseSchema } from "@/modules/generation/schema";
import { validateGeneratedCases } from "@/modules/generation/service";
import { analyzeOpenApi } from "@/modules/inventory/openapi";

/** The inventory exactly as loadInventoryContext would build it from the Demo Shop spec. */
function demoInventory(extra: Partial<InventoryContext> = {}): InventoryContext {
  const items = analyzeOpenApi(JSON.stringify(DEMO_OPENAPI));
  return {
    endpoints: items
      .filter((i) => i.kind === "API_ENDPOINT")
      .map((i) => {
        const d = i.details as { method: string; path: string; parameters: never[]; responses: never };
        return { key: i.key, method: d.method, path: d.path, title: i.title, protected: i.protected ?? null, parameters: d.parameters, responses: d.responses };
      }),
    routes: [{ key: "/account", protected: true }, { key: "/products", protected: null }, { key: "/orders/:id", protected: true }],
    requirements: [{ key: "REQ-2", title: "A coupon gives a discount", criteria: ["SPRING10 takes 10% off the subtotal"], rules: ["SPRING10 takes 10% off the subtotal"] }],
    workflows: [],
    roles: ["customer"],
    ...extra,
  };
}

const base = (inventory: InventoryContext | null, login = true): GenerationContext => ({
  application: { name: "Demo Shop", authorizedUrl: "https://shop.example.com", environment: "STAGING" },
  requirements: null,
  secretNames: ["DEMO_EMAIL", "DEMO_PASSWORD"],
  login: login ? { path: "/login", usernameSelector: 'input[type="email"]', usernameSecret: "DEMO_EMAIL", passwordSecret: "DEMO_PASSWORD" } : null,
  features: [{ name: "Home", url: "https://shop.example.com/", pages: [] }],
  inventory,
});

describe("inventory-driven generation", () => {
  const cases = inventoryCases(base(demoInventory()));
  const titles = cases.map((c) => c.title);

  it("checks documented responses and schemas of read-only endpoints only", () => {
    expect(titles).toContain("GET /api/products returns 200 matching its documented schema");
    expect(titles).toContain("GET /api/cart returns 200 matching its documented schema");
    expect(titles.some((t) => t.startsWith("POST /cart"))).toBe(false); // never a mutating request
    const cart = cases.find((c) => c.title.startsWith("GET /api/cart returns"))!;
    expect(cart.steps.map((s) => s.kind)).toEqual(["NAVIGATE", "API_GET", "ASSERT_RESPONSE"]);
    expect(cart.steps[2].params).toMatchObject({ status: 200, contentType: "json", contract: { type: "object", required: expect.arrayContaining(["total", "currency"]) } });
    expect(cart.coverage.requirements).toEqual(["GET /api/cart"]);
    expect(cart.feature).toBe(INVENTORY_FEATURES.api);
  });

  it("signs in for protected endpoints and checks documented refusals when signed out", () => {
    const profile = cases.find((c) => c.title.startsWith("GET /api/profile returns"))!;
    expect(profile.steps[0]).toMatchObject({ kind: "NAVIGATE", params: { url: "/login" } });
    expect(profile.steps.some((s) => s.kind === "FILL" && "secret" in (s.params as { value: object }).value)).toBe(true);
    const denied = cases.find((c) => c.title === "GET /api/profile refuses signed-out requests")!;
    expect(denied).toMatchObject({ category: "PERMISSION", priority: "CRITICAL", feature: INVENTORY_FEATURES.access });
    expect(denied.steps.map((s) => s.kind)).toEqual(["NAVIGATE", "API_GET", "ASSERT_RESPONSE"]);
    // Without a configured login, protected endpoints get no positive case.
    expect(inventoryCases(base(demoInventory(), false)).some((c) => c.title.startsWith("GET /api/profile returns"))).toBe(false);
  });

  it("tests documented parameter limits on both sides, but only refusals the spec documents", () => {
    const limit = cases.filter((c) => c.title.startsWith("GET /api/products: limit"));
    expect(limit.map((c) => [c.title, c.category])).toEqual([
      ["GET /api/products: limit=50 (maximum) is accepted", "BOUNDARY"],
      ["GET /api/products: limit above its maximum is refused", "NEGATIVE"],
      ["GET /api/products: limit=1 (minimum) is accepted", "BOUNDARY"],
      ["GET /api/products: limit below its minimum is refused", "NEGATIVE"],
    ]);
    expect(limit[1].steps[1].params).toMatchObject({ url: "/api/products?limit=51" });
    const undocumented = demoInventory();
    delete undocumented.endpoints.find((e) => e.key === "GET /api/products")!.responses["400"];
    expect(inventoryCases(base(undocumented)).filter((c) => c.title.includes("is refused"))).toHaveLength(0);
  });

  it("checks that routes marked protected redirect signed-out visitors, skipping parameterized ones", () => {
    const routes = cases.filter((c) => c.title.startsWith("Signed-out visitors can't open"));
    expect(routes.map((c) => c.title)).toEqual(["Signed-out visitors can't open /account"]);
    expect(routes[0].steps[1].params).toEqual({ check: "urlContains", expected: "/login" });
  });

  it("doesn't turn prose requirements into assertions on its own", () => {
    expect(cases.some((c) => c.coverage.requirements.includes("REQ-2"))).toBe(false);
  });

  it("produces only valid cases, accepted with the inventory pseudo-features", () => {
    for (const c of cases) expect(generatedCaseSchema.safeParse(c).success, c.title).toBe(true);
    const context = base(demoInventory());
    expect(validateGeneratedCases({ cases }, context)).toEqual({ cases, rejected: 0 });
    expect(validateGeneratedCases({ cases }, base(null)).cases).toHaveLength(0); // pseudo-features need an inventory
  });

  it("rejects generated API requests outside the authorized URL", () => {
    const [first] = cases;
    const outside = { ...first, title: "Outside", steps: [first.steps[0], { kind: "API_GET", description: "x", params: { url: "https://evil.example.net/api", saveAs: "response" } }, first.steps[2]] };
    expect(validateGeneratedCases({ cases: [outside] }, base(demoInventory())).rejected).toBe(1);
  });

  it("gives an LLM the inventory as data, with the new step kinds and grounding rules", () => {
    const prompt = buildPrompt(base(demoInventory()));
    expect(prompt.system).toContain("ASSERT_CALC");
    expect(prompt.system).toContain("Never assert a number you computed yourself");
    expect(prompt.system).toContain("GET only");
    const data = prompt.user.slice(prompt.user.indexOf("<APPLICATION_DATA>"), prompt.user.indexOf("</APPLICATION_DATA>"));
    expect(data).toContain('"key":"REQ-2"');
    expect(data).toContain("GET /api/cart");
  });
});
