import type { DemoFault } from "../../demo/target-app";
import type { ExecutableStep } from "@/modules/execution/steps";

/**
 * The benchmark corpus: the bundled Demo Shop, its seeded faults (ground truth) and the
 * reference test cases. Generated cases (from the Demo Shop's OpenAPI spec) are added at run
 * time, so the benchmark measures generation and execution together.
 *
 * Bump CORPUS_VERSION whenever cases, faults or expectations change: results from different
 * corpus versions aren't comparable.
 */
export const CORPUS_VERSION = "demo-shop-2026.10-v1";

export type CorpusCase = { title: string; steps: ExecutableStep[]; priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; refs?: string[] };

const NAV = (url: string): ExecutableStep => ({ kind: "NAVIGATE", description: `Open ${url}`, params: { url } });
const testId = (value: string) => ({ by: "testId" as const, value });
const extract = (name: string, id: string): ExecutableStep => ({ kind: "EXTRACT", description: `Read ${name}`, params: { name, from: { source: "element", target: testId(id), property: "text" }, as: "number" } });
const calc = (expression: string, description = expression): ExecutableStep => ({ kind: "ASSERT_CALC", description, params: { expression } });
const heading = (name: string): ExecutableStep => ({ kind: "ASSERT", description: `"${name}" heading is shown`, params: { check: "visible", target: { by: "role", role: "heading", name } } });
const signIn: ExecutableStep[] = [
  NAV("/login"),
  { kind: "FILL", description: "Email", params: { target: { by: "label", value: "Email" }, value: { secret: "DEMO_EMAIL" } } },
  { kind: "FILL", description: "Password", params: { target: { by: "label", value: "Password" }, value: { secret: "DEMO_PASSWORD" } } },
  { kind: "CLICK", description: "Sign in", params: { target: { by: "css", value: 'form[aria-label="Sign in"] button[type="submit"]' } } },
  { kind: "ASSERT", description: "Signed in", params: { check: "urlContains", expected: "/account" } },
];
const fillCart: ExecutableStep[] = [
  NAV("/products/1"),
  { kind: "FILL", description: "Quantity 2", params: { target: { by: "label", value: "Quantity" }, value: { literal: "2" } } },
  { kind: "CLICK", description: "Add to cart", params: { target: { by: "role", role: "button", name: "Add to cart" } } },
  NAV("/products/3"),
  { kind: "CLICK", description: "Add to cart", params: { target: { by: "role", role: "button", name: "Add to cart" } } },
  { kind: "FILL", description: "Coupon", params: { target: { by: "label", value: "Coupon code" }, value: { literal: "SPRING10" } } },
  { kind: "CLICK", description: "Apply coupon", params: { target: { by: "role", role: "button", name: "Apply" } } },
];

export const REFERENCE_CASES: CorpusCase[] = [
  {
    title: "Cart totals follow the pricing rules",
    priority: "CRITICAL",
    refs: ["REQ-1", "REQ-2"],
    steps: [
      ...fillCart,
      extract("price_1", "price-1"), extract("qty_1", "qty-1"), extract("line_1", "line-total-1"), extract("line_3", "line-total-3"),
      extract("subtotal", "subtotal"), extract("discount", "discount"), extract("total", "total"),
      calc("line_1 == price_1 * qty_1", "Line total = price × quantity"),
      calc("subtotal == line_1 + line_3", "Subtotal = sum of line totals"),
      calc("discount == round(subtotal * 0.10, 2)", "SPRING10 takes 10% off the subtotal (REQ-2)"),
      calc("total == subtotal - discount", "Total = subtotal − discount"),
    ],
  },
  {
    title: "Cart API agrees with the cart page",
    priority: "HIGH",
    refs: ["GET /api/cart"],
    steps: [
      ...fillCart,
      extract("page_total", "total"),
      { kind: "API_GET", description: "Cart API", params: { url: "/api/cart", saveAs: "cart_api" } },
      { kind: "ASSERT_RESPONSE", description: "Total is a number", params: { response: "cart_api", status: 200, contract: { type: "object", required: ["total"], properties: { total: { type: "number", minimum: 0 } } } } },
      { kind: "EXTRACT", description: "API total", params: { name: "api_total", from: { source: "response", response: "cart_api", pointer: "/total" }, as: "number" } },
      calc("api_total == page_total", "API and page show the same total"),
    ],
  },
  { title: "Products page lists the catalogue", priority: "HIGH", steps: [NAV("/products"), heading("Products"), { kind: "ASSERT", description: "3 products", params: { check: "count", target: { by: "css", value: "main li" }, expected: 3 } }] },
  { title: "Products list looks as approved", priority: "MEDIUM", steps: [NAV("/products"), { kind: "ASSERT_VISUAL", description: "Matches the approved look", params: { name: "product-list", target: { by: "css", value: "main ul" } } }] },
  {
    title: "Signed-out visitors can't open My account",
    priority: "CRITICAL",
    refs: ["REQ-3"],
    steps: [NAV("/account"), { kind: "ASSERT", description: "Sent to sign in", params: { check: "urlContains", expected: "/login" } }],
  },
  {
    title: "Profile changes are saved",
    priority: "HIGH",
    refs: ["REQ-4"],
    steps: [
      ...signIn,
      { kind: "FILL", description: "New display name", params: { target: { by: "label", value: "Display name" }, value: { unique: "text", saveAs: "new_name" } } },
      { kind: "CLICK", description: "Save", params: { target: { by: "role", role: "button", name: "Save profile" } } },
      NAV("/account"),
      { kind: "ASSERT", description: "The new name is kept", params: { check: "valueEquals", target: { by: "label", value: "Display name" }, expectedVariable: "new_name" } },
    ],
  },
  { title: "Search shows a results page", priority: "MEDIUM", steps: [NAV("/search?q=shoes"), { kind: "ASSERT", description: "Results heading", params: { check: "textContains", target: { by: "role", role: "heading" }, expected: "Results for" } }] },
  // Deliberately flaky page: must be reported as flaky/inconclusive, never as a defect.
  { title: "Deal of the day is shown", priority: "LOW", steps: [NAV("/deals"), heading("Deal of the day")] },
];

export type FaultSpec = {
  fault: DemoFault;
  kind: string;
  description: string;
  /** Titles of cases expected to fail because of this fault (any other failure is a false positive). */
  affects: string[];
};

/** Ground truth: which cases a correct engine should fail for each seeded fault. */
export const SEEDED_FAULTS: FaultSpec[] = [
  { fault: "wrong-discount", kind: "business rule", description: "SPRING10 takes 15% instead of 10%", affects: ["Cart totals follow the pricing rules"] },
  { fault: "line-total-ignores-quantity", kind: "business rule", description: "Line totals ignore the quantity", affects: ["Cart totals follow the pricing rules"] },
  { fault: "cart-api-total-as-string", kind: "API contract", description: "The cart API returns the total as a string", affects: ["Cart API agrees with the cart page", "GET /api/cart returns 200 matching its documented schema"] },
  { fault: "products-page-500", kind: "server error", description: "The products page returns 500", affects: ["Products page lists the catalogue", "Products list looks as approved"] },
  { fault: "restyled-products", kind: "visual", description: "The product list's colours change", affects: ["Products list looks as approved"] },
  { fault: "account-unprotected", kind: "access control", description: "My account opens without signing in", affects: ["Signed-out visitors can't open My account"] },
  { fault: "profile-api-unprotected", kind: "access control (API)", description: "The profile API answers signed-out requests", affects: ["GET /api/profile refuses signed-out requests"] },
  { fault: "products-limit-unvalidated", kind: "boundary", description: "limit above 50 is accepted", affects: ["GET /api/products: limit above its maximum is refused"] },
  { fault: "profile-not-saved", kind: "persistence", description: "Profile changes are silently dropped", affects: ["Profile changes are saved"] },
  { fault: "search-500", kind: "server error", description: "Search returns 500", affects: ["Search shows a results page"] },
];

/** Variants that aren't defects: any FAILED verdict on them is a false positive. */
export const NOISE_VARIANTS: Array<{ fault: DemoFault; description: string }> = [{ fault: "slow-products", description: "The products page is 0.8s slower (correct, just slow)" }];

/** Cases known to be flaky on the clean app (expected: inconclusive/flaky, never failed). */
export const KNOWN_FLAKY = ["Deal of the day is shown"];

export const DEMO_REQUIREMENTS = `# Demo Shop requirements
Roles: customer
REQ-1: Customers can add products to the cart.
  - Line total is price times quantity
REQ-2: A coupon gives a discount.
  - SPRING10 takes 10% off the subtotal
REQ-3: Only signed-in customers can open My account.
REQ-4: Profile changes are saved.
`;
