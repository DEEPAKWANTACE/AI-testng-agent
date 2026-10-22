import { describe, expect, it } from "vitest";
import { checkContract } from "@/modules/execution/contract";
import { analyzeOpenApi, SpecError } from "@/modules/inventory/openapi";
import { analyzeRequirements } from "@/modules/inventory/requirements";
import { analyzeSourceFiles } from "@/modules/inventory/source";
import { normalizeRole, normalizeRoutePath } from "@/modules/inventory/types";

describe("route normalization", () => {
  it.each([
    ["/products/{id}", "/products/:id"],
    ["products/[id]/", "/products/:id"],
    ["/docs/[...slug]", "/docs/:slug*"],
    ["/shop/[[...slug]]", "/shop/:slug*"],
    ["/users/<int:user_id>", "/users/:user_id"],
    ["^orders/(?P<pk>[0-9]+)/$", "/orders/:pk"],
    ["//a//b?x=1#y", "/a/b"],
    ["", "/"],
  ])("%s → %s", (raw, expected) => expect(normalizeRoutePath(raw)).toBe(expected));

  it("normalizes role names", () => {
    expect(normalizeRole("an Administrator")).toBe("administrator");
    expect(normalizeRole("QA_LEAD")).toBe("qa_lead");
    expect(normalizeRole("x")).toBeNull();
  });
});

const SPEC_YAML = `
openapi: 3.0.3
servers: [{ url: https://shop.example.com/api/v1 }]
security: [{ session: [] }]
paths:
  /cart:
    get:
      summary: Get the cart
      x-roles: [customer, admin]
      responses:
        "200":
          description: The cart
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Cart" }
        "401": { description: Not signed in }
  /products/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: integer, minimum: 1 } }
    get:
      operationId: getProduct
      security: []
      parameters:
        - { name: fields, in: query, schema: { type: string, maxLength: 50 } }
      responses:
        "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/Product" } } } }
components:
  schemas:
    Cart:
      type: object
      required: [items, total]
      properties:
        items: { type: array, items: { $ref: "#/components/schemas/Line" } }
        total: { type: number, minimum: 0 }
        coupon: { type: string, nullable: true }
        meta: { oneOf: [{ type: string }, { type: integer }] }
    Line:
      allOf:
        - { type: object, required: [productId], properties: { productId: { type: integer } } }
        - { type: object, properties: { quantity: { type: integer, minimum: 1, maximum: 99 } } }
    Product:
      type: object
      properties:
        id: { type: integer }
        related: { type: array, items: { $ref: "#/components/schemas/Product" } }
`;

describe("OpenAPI analysis", () => {
  const items = analyzeOpenApi(SPEC_YAML, "openapi.yaml");
  const byKey = (key: string) => items.find((i) => i.key === key)!;

  it("extracts endpoints under the server base path, with auth, roles and parameters", () => {
    expect(items.filter((i) => i.kind === "API_ENDPOINT").map((i) => i.key).sort()).toEqual(["GET /api/v1/cart", "GET /api/v1/products/:id"]);
    expect(byKey("GET /api/v1/cart")).toMatchObject({ protected: true, roles: ["customer", "admin"], confidence: "HIGH", ref: "openapi.yaml#/paths/~1cart/get" });
    expect(byKey("GET /api/v1/products/:id")).toMatchObject({ protected: false, title: "getProduct" });
    const params = byKey("GET /api/v1/products/:id").details!.parameters as Array<{ name: string; required: boolean; schema: unknown }>;
    expect(params).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
      { name: "fields", in: "query", required: false, schema: { type: "string", maxLength: 50 } },
    ]);
    expect(items.filter((i) => i.kind === "ROLE").map((i) => i.key)).toEqual(["customer", "admin"]);
  });

  it("converts response schemas into contracts: refs, allOf, nullable, recursion; skips oneOf", () => {
    const responses = byKey("GET /api/v1/cart").details!.responses as Record<string, { contract: unknown }>;
    const contract = responses["200"].contract as Parameters<typeof checkContract>[1];
    expect(contract).toMatchObject({ type: "object", required: ["items", "total"] });
    expect(Object.keys(contract.properties!)).toEqual(["items", "total", "coupon"]); // oneOf "meta" left out
    expect(checkContract({ items: [{ productId: 1, quantity: 2 }], total: 10, coupon: null, meta: 5 }, contract)).toEqual([]);
    expect(checkContract({ items: [{ quantity: 0 }], total: -1 }, contract)).toEqual(["/items/0/productId: required property is missing", "/items/0/quantity: expected ≥ 1, got 0", "/total: expected ≥ 0, got -1"]);
    expect(responses["401"].contract).toBeNull();
    const product = (byKey("GET /api/v1/products/:id").details!.responses as Record<string, { contract: { properties: Record<string, { items: unknown }> } }>)["200"].contract;
    expect(product.properties.related.items).toEqual({ type: "object" }); // cycle cut
  });

  it("accepts JSON and Swagger 2.0", () => {
    const swagger = JSON.stringify({ swagger: "2.0", basePath: "/api", paths: { "/orders": { post: { summary: "Create order", parameters: [{ in: "body", name: "body", schema: { type: "object", required: ["sku"], properties: { sku: { type: "string" } } } }], responses: { 201: { description: "created", schema: { type: "object" } } } } } } });
    const [order] = analyzeOpenApi(swagger);
    expect(order).toMatchObject({ key: "POST /api/orders", protected: false });
    expect(order.details!.requestBody).toEqual({ type: "object", required: ["sku"], properties: { sku: { type: "string" } } });
  });

  it.each([
    ["not: [valid", /isn't valid JSON or YAML/],
    ["title: x", /Not an OpenAPI/],
    ["openapi: 3.0.0", /no `paths`/],
    ["- a\n- b", /must be an object/],
    ["openapi: 3.0.0\npaths: !!js/function 'function(){}'", /isn't valid|Not an OpenAPI|no `paths`/],
  ])("rejects %j", (text, message) => {
    expect(() => analyzeOpenApi(text)).toThrow(SpecError);
    expect(() => analyzeOpenApi(text)).toThrow(message);
  });

  it("refuses YAML alias bombs and oversized documents", () => {
    const bomb = ["openapi: 3.0.0", "a: &a [x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(9).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]`), "paths: {}"].join("\n");
    expect(() => analyzeOpenApi(bomb)).toThrow(SpecError);
    expect(() => analyzeOpenApi("x".repeat(2_000_001))).toThrow(/larger than 2 MB/);
  });
});

const REQUIREMENTS = `
# Shop requirements
Roles: customer, store manager and admin

## Cart
REQ-1: Customers can add products to the cart.
  - Quantity must be between 1 and 99
  - The cart shows the line total for each product
REQ-2: A coupon gives a discount.
  - SPRING10 takes 10% off the subtotal
  - Only one coupon per order

As a store manager, I want to edit prices so that sales are current.
- Price changes apply immediately

Only admins can delete products.

Scenario: Apply a coupon at checkout
  Given a cart with 2 trail runner shoes
  When I apply coupon "SPRING10"
  Then the total is $160.20
`;

describe("requirements analysis", () => {
  const items = analyzeRequirements(REQUIREMENTS, "reqs.md");

  it("extracts requirement ids with criteria, rules and section", () => {
    const req1 = items.find((i) => i.key === "REQ-1")!;
    expect(req1).toMatchObject({ kind: "REQUIREMENT", title: "Customers can add products to the cart.", ref: "reqs.md:6", confidence: "HIGH" });
    expect(req1.details).toMatchObject({ criteria: ["Quantity must be between 1 and 99", "The cart shows the line total for each product"], rules: ["Quantity must be between 1 and 99"], section: "Cart" });
    expect(items.find((i) => i.key === "REQ-2")!.details!.rules).toEqual(["SPRING10 takes 10% off the subtotal", "Only one coupon per order"]);
  });

  it("turns user stories without ids into stable requirements", () => {
    const story = items.find((i) => i.key.startsWith("STORY-"))!;
    expect(story).toMatchObject({ confidence: "MEDIUM", title: "As a store manager, I want to edit prices so that sales are current." });
    expect(analyzeRequirements(REQUIREMENTS).find((i) => i.key.startsWith("STORY-"))!.key).toBe(story.key);
  });

  it("collects roles from role lists, stories and access rules", () => {
    expect(items.filter((i) => i.kind === "ROLE").map((i) => i.key).sort()).toEqual(["admin", "customer", "store_manager"]);
  });

  it("extracts Gherkin workflows", () => {
    expect(items.find((i) => i.kind === "WORKFLOW")).toMatchObject({
      key: "apply-a-coupon-at-checkout",
      details: { steps: [{ keyword: "Given", text: "a cart with 2 trail runner shoes" }, { keyword: "When", text: 'I apply coupon "SPRING10"' }, { keyword: "Then", text: "the total is $160.20" }] },
    });
  });

  it("strips control characters and bounds lengths", () => {
    const [item] = analyzeRequirements(`REQ-9: ${"a".repeat(1000)}\u0007`);
    expect(item.title).toHaveLength(300);
    expect(item.title).not.toContain("\u0007");
  });
});

describe("source analysis", () => {
  const items = analyzeSourceFiles([
    { path: "src/app/(shop)/products/[id]/page.tsx", content: "export default function Page() {}" },
    { path: "src/app/account/page.tsx", content: "const actor = await requireActor();" },
    { path: "src/app/_lib/page.tsx", content: "" },
    { path: "src/app/api/cart/route.ts", content: "export async function GET() {}\nexport const POST = async () => {};" },
    { path: "pages/about.tsx", content: "" },
    { path: "pages/api/orders.ts", content: 'if (req.method === "POST") {}' },
    { path: "pages/_app.tsx", content: "" },
    { path: "server/routes.js", content: 'router.get("/health", h);\napp.post(`/api/login`, h);\nif (user.role === "admin") {}' },
    { path: "web/App.jsx", content: 'import { Route } from "react-router-dom";\n<Route path="/settings/:tab" element={<S/>} />' },
    { path: "api/views.py", content: '@app.route("/reports/<int:id>", methods=["GET", "DELETE"])\ndef r(): pass\n@router.post("/items")\ndef c(): pass' },
    { path: "shop/urls.py", content: 'urlpatterns = [path("checkout/", views.checkout)]' },
    { path: "prisma/schema.prisma", content: "enum UserRole {\n  ADMIN\n  QA_LEAD\n  VIEWER\n}" },
  ]);
  const keys = (kind: string) => items.filter((i) => i.kind === kind).map((i) => i.key).sort();

  it("finds routes across frameworks", () => {
    expect(keys("ROUTE")).toEqual(["/about", "/account", "/checkout", "/products/:id", "/settings/:tab"]);
    expect(items.find((i) => i.key === "/account")!.protected).toBe(true);
    expect(items.find((i) => i.key === "/products/:id")!.protected).toBeNull();
  });

  it("finds API endpoints with methods and file:line references", () => {
    expect(keys("API_ENDPOINT")).toEqual(["DELETE /reports/:id", "GET /api/cart", "GET /health", "GET /reports/:id", "POST /api/cart", "POST /api/login", "POST /api/orders", "POST /items"]);
    expect(items.find((i) => i.key === "POST /api/cart")!.ref).toBe("src/app/api/cart/route.ts:2");
    expect(items.find((i) => i.key === "POST /api/login")!.ref).toBe("server/routes.js:2");
  });

  it("finds roles in checks and enums", () => {
    expect([...new Set(keys("ROLE"))]).toEqual(["admin", "qa_lead", "viewer"]);
  });
});
