import { describe, expect, it } from "vitest";
import { caseTargets, computeCoverage, matchesRoute, summarizeCoverage, type CoverageItem, type LatestResult } from "@/modules/coverage/mapping";
import type { SnapshotCase } from "@/modules/test-suites/snapshot";

const step = (position: number, kind: SnapshotCase["steps"][number]["kind"], params: unknown) => ({ position, action: String(kind), expectedResult: null, kind, params });
const testCase = (caseKey: string, steps: SnapshotCase["steps"], refs: string[] = []): SnapshotCase => ({
  caseKey,
  caseId: `id-${caseKey}`,
  title: `Case ${caseKey}`,
  description: null,
  prerequisites: [],
  expectedResult: null,
  priority: "MEDIUM",
  type: "FUNCTIONAL",
  featureName: null,
  requirementRefs: refs,
  steps,
});

describe("route matching", () => {
  it.each([
    ["/products/:id", "/products/3", true],
    ["/products/:id", "/products", false],
    ["/products/:id", "/products/3/reviews", false],
    ["/docs/:slug*", "/docs/a/b/c", true],
    ["/docs/:slug*", "/docs", true],
    ["/", "/", true],
    ["/cart", "/cart/", true],
    ["/cart", "/carts", false],
  ])("%s ~ %s → %s", (pattern, path, expected) => expect(matchesRoute(pattern, path)).toBe(expected));
});

describe("case targets", () => {
  it("reads navigations, API requests, response matches and assertions from the snapshot", () => {
    const t = caseTargets(
      testCase("a", [
        step(0, "NAVIGATE", { url: "/products/3?x=1" }),
        step(1, "API_GET", { url: "https://shop.test/api/cart?debug=1", saveAs: "r" }),
        step(2, "ASSERT_RESPONSE", { match: { method: "GET", urlContains: "/api/products" }, status: 200 }),
        step(3, "ASSERT_RESPONSE", { match: { urlContains: "products?page" }, status: 200 }),
      ], [" REQ-2 "]),
    );
    expect(t).toEqual({ refs: ["req-2"], navigations: ["/products/3"], requests: [{ method: "GET", path: "/api/cart" }, { method: "GET", path: "/api/products" }], asserts: true });
    expect(caseTargets(testCase("b", [step(0, "NAVIGATE", { url: "/" }), step(1, "CLICK", { target: { by: "css", value: "a" } })])).asserts).toBe(false);
  });
});

describe("coverage levels", () => {
  const items: CoverageItem[] = [
    { id: "1", kind: "REQUIREMENT", key: "REQ-2", title: "Coupons" },
    { id: "2", kind: "ROUTE", key: "/products/:id", title: "Product" },
    { id: "3", kind: "API_ENDPOINT", key: "GET /api/cart", title: "Cart" },
    { id: "4", kind: "API_ENDPOINT", key: "POST /api/orders", title: "Order" },
    { id: "5", kind: "ROUTE", key: "/checkout", title: "Checkout" },
    { id: "6", kind: "ROUTE", key: "/account", title: "Account" },
  ];
  const planned = [
    { suiteName: "S", version: 1, testCase: testCase("rule", [step(0, "NAVIGATE", { url: "/cart" }), step(1, "ASSERT_CALC", { expression: "a == b" })], ["REQ-2: coupon discount"]) },
    { suiteName: "S", version: 1, testCase: testCase("product", [step(0, "NAVIGATE", { url: "/products/1" }), step(1, "ASSERT", { check: "visible", target: { by: "css", value: "h1" } })]) },
    { suiteName: "S", version: 1, testCase: testCase("walk", [step(0, "NAVIGATE", { url: "/" }), step(1, "CLICK", { target: { by: "css", value: "a" } })]) },
    { suiteName: "S", version: 1, testCase: testCase("checkout", [step(0, "NAVIGATE", { url: "/checkout" }), step(1, "ASSERT", { check: "visible", target: { by: "css", value: "h1" } })]) },
    { suiteName: "S", version: 1, testCase: testCase("account", [step(0, "NAVIGATE", { url: "/account" }), step(1, "ASSERT", { check: "visible", target: { by: "css", value: "h1" } })]) },
  ];
  const latest = new Map<string, LatestResult>([
    ["rule", { status: "PASSED", runId: "r", network: [] }],
    ["product", { status: "FAILED", runId: "r", network: [] }],
    // The walk reached the cart API without any case targeting it.
    ["walk", { status: "PASSED", runId: "r", network: [{ type: "page", method: "GET", path: "/" }, { type: "api", method: "GET", path: "/api/cart" }] }],
    ["checkout", { status: "BLOCKED", runId: "r", network: [] }],
  ]);
  const coverage = computeCoverage(items, planned, latest);
  const level = (id: string) => coverage.find((c) => c.itemId === id)!.level;

  it("assigns each level by its rule", () => {
    expect(level("1")).toBe("VERIFIED"); // named in refs, asserting case passed
    expect(level("2")).toBe("EXECUTED"); // targeted, ran, failed
    expect(level("3")).toBe("EXERCISED"); // only reached at runtime
    expect(level("4")).toBe("NOT_PLANNED");
    expect(level("5")).toBe("PLANNED"); // targeted, but its only run was blocked
    expect(level("6")).toBe("PLANNED"); // targeted, not run yet
    expect(coverage.find((c) => c.itemId === "3")!.exercisedBy).toEqual(["Case walk"]);
  });

  it("never verifies through a case without assertions", () => {
    const [only] = computeCoverage([{ id: "x", kind: "ROUTE", key: "/", title: "Home" }], [planned[2]], latest);
    expect(only.level).toBe("EXECUTED");
  });

  it("summarizes against the known inventory", () => {
    expect(summarizeCoverage(items, coverage)).toEqual({
      known: 6,
      byLevel: { NOT_PLANNED: 1, PLANNED: 2, EXERCISED: 1, EXECUTED: 1, VERIFIED: 1 },
      byKind: { REQUIREMENT: { known: 1, verified: 1, planned: 1 }, ROUTE: { known: 3, verified: 0, planned: 3 }, API_ENDPOINT: { known: 2, verified: 0, planned: 0 } },
    });
  });
});
