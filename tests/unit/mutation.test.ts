import { describe, expect, it } from "vitest";
import { applyMutant, enumerateMutants, mutateNumber, type ObservedSample } from "@/modules/mutation/operators";

const api = (path: string, body: unknown): ObservedSample => ({ type: "api", method: "GET", path, status: 200, contentType: "application/json", body: JSON.stringify(body) });
const page = (path: string, body: string): ObservedSample => ({ type: "document", method: "GET", path, status: 200, contentType: "text/html; charset=utf-8", body });
const HTML = '<html><head><title>Shop 2026</title><script>var x = 42;</script></head><body><h1>Products</h1><ul><li>Shoes — $89</li><li>Bottle — $19.50</li></ul></body></html>';

describe("mutant enumeration", () => {
  const samples = [api("/api/cart", { items: [{ price: 89, qty: 2 }], total: 178, currency: "USD" }), page("/products", HTML), { ...api("/api/broken", {}), status: 500 }];

  it("derives stable, bounded mutants from successful responses only", () => {
    const all = enumerateMutants(samples, 100);
    expect(all.map((m) => m.id)).toEqual([
      "NUMBER_CHANGED:api:GET /api/cart:/total",
      "HEADING_REMOVED:document:GET /products:0",
      "NUMBER_CHANGED:api:GET /api/cart:/items/0/price",
      "TEXT_NUMBER_CHANGED:document:GET /products:0",
      "NUMBER_CHANGED:api:GET /api/cart:/items/0/qty",
      "TEXT_NUMBER_CHANGED:document:GET /products:1",
      "FIELD_REMOVED:api:GET /api/cart:/items",
      "SERVER_ERROR:document:GET /products:",
      "FIELD_REMOVED:api:GET /api/cart:/total",
      "SERVER_ERROR:api:GET /api/cart:",
    ]);
    expect(enumerateMutants(samples, 100)).toEqual(all);
    expect(enumerateMutants(samples, 3).map((m) => m.operator)).toEqual(["NUMBER_CHANGED", "HEADING_REMOVED", "NUMBER_CHANGED"]); // spread across responses
  });
});

describe("applying mutants", () => {
  const cart = { type: "api" as const, method: "GET", path: "/api/cart", status: 200, contentType: "application/json", body: JSON.stringify({ items: [{ price: 89 }], total: 17.8 }) };
  const products = { type: "document" as const, method: "GET", path: "/products", status: 200, contentType: "text/html", body: HTML };
  const byId = (id: string) => enumerateMutants([api("/api/cart", JSON.parse(cart.body)), page("/products", HTML)], 100).find((m) => m.id === id)!;

  it("changes numbers detectably", () => {
    expect(mutateNumber(89)).toBe(90);
    expect(mutateNumber(17.8)).toBe(19.59);
    expect(mutateNumber(0)).toBe(1);
    expect(JSON.parse(applyMutant(byId("NUMBER_CHANGED:api:GET /api/cart:/total"), cart)!.body)).toEqual({ items: [{ price: 89 }], total: 19.59 });
    expect(JSON.parse(applyMutant(byId("NUMBER_CHANGED:api:GET /api/cart:/items/0/price"), cart)!.body).items[0].price).toBe(90);
  });

  it("removes fields and turns responses into server errors", () => {
    expect(JSON.parse(applyMutant(byId("FIELD_REMOVED:api:GET /api/cart:/items"), cart)!.body)).toEqual({ total: 17.8 });
    expect(applyMutant(byId("SERVER_ERROR:api:GET /api/cart:"), cart)).toMatchObject({ status: 500, contentType: "application/json" });
    expect(applyMutant(byId("SERVER_ERROR:document:GET /products:"), products)).toMatchObject({ status: 500, contentType: "text/html; charset=utf-8" });
  });

  it("edits visible HTML only: headings and displayed numbers, never scripts or titles", () => {
    expect(applyMutant(byId("HEADING_REMOVED:document:GET /products:0"), products)!.body).not.toContain("<h1>");
    const first = applyMutant(byId("TEXT_NUMBER_CHANGED:document:GET /products:0"), products)!.body;
    expect(first).toContain("Shoes — $90");
    expect(first).toContain("var x = 42");
    expect(first).toContain("Shop 2026");
    expect(applyMutant(byId("TEXT_NUMBER_CHANGED:document:GET /products:1"), products)!.body).toContain("Bottle — $21.46");
  });

  it("doesn't apply to other responses, failed responses or missing locations", () => {
    const total = byId("NUMBER_CHANGED:api:GET /api/cart:/total");
    expect(applyMutant(total, { ...cart, path: "/api/other" })).toBeNull();
    expect(applyMutant(total, { ...cart, method: "POST" })).toBeNull();
    expect(applyMutant(total, { ...cart, status: 404 })).toBeNull();
    expect(applyMutant(total, { ...cart, body: JSON.stringify({ total: "17.80" }) })).toBeNull();
    expect(applyMutant(total, { ...cart, body: "not json" })).toBeNull();
    expect(applyMutant(byId("HEADING_REMOVED:document:GET /products:0"), { ...products, body: "<p>no heading</p>" })).toBeNull();
  });
});
