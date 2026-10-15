import { describe, expect, it } from "vitest";
import { evaluateLink, normalizeUrl } from "@/modules/discovery/crawl-url";
import { deriveFeatures } from "@/modules/discovery/features";
import { discoveryAuthInputSchema } from "@/modules/discovery/auth-config";
import { EMPTY_PAGE_ELEMENTS, pageElementsSchema } from "@/modules/discovery/page-elements";

const SCOPE = "https://shop.example.com/app";

describe("URL normalisation", () => {
  it("drops fragments and credentials, sorts the query and trims trailing slashes", () => {
    expect(normalizeUrl("https://shop.example.com/app/cart/?b=2&a=1#top")).toBe("https://shop.example.com/app/cart?a=1&b=2");
    expect(normalizeUrl("https://SHOP.example.com:443/")).toBe("https://shop.example.com/");
  });
});

describe("link evaluation", () => {
  it.each([
    ["/app/products", true, null],
    ["products/1", true, null],
    ["https://shop.example.com/app?page=2#reviews", true, null],
    ["/application", false, "out-of-scope"],
    ["https://evil.example.com/app", false, "out-of-scope"],
    ["http://shop.example.com/app", false, "out-of-scope"],
    ["mailto:help@example.com", false, "unsupported-scheme"],
    ["javascript:alert(1)", false, "unsupported-scheme"],
    ["/app/logout", false, "excluded"],
    ["/app/sign-out", false, "excluded"],
    ["/app/users/5/delete", false, "excluded"],
    ["/app/files/report.pdf", false, "download"],
    ["https://user:pw@shop.example.com/app", false, "invalid"],
  ])("%s → crawl=%s (%s)", (href, ok, reason) => {
    const result = evaluateLink(href, "https://shop.example.com/app/", SCOPE);
    expect(result.ok).toBe(ok);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("doesn't exclude words that merely contain a keyword", () => {
    expect(evaluateLink("/app/catalogue", SCOPE, SCOPE).ok).toBe(true);
    expect(evaluateLink("/app/resets-guide", SCOPE, SCOPE).ok).toBe(true);
  });
});

describe("feature derivation", () => {
  const page = (url: string, extra: Partial<typeof EMPTY_PAGE_ELEMENTS> = {}) => ({
    url,
    title: null,
    elements: { ...EMPTY_PAGE_ELEMENTS, ...extra },
  });
  const nav = {
    navigation: [
      {
        label: "Main",
        links: [
          { href: "https://shop.example.com/app/products", text: "Shop" },
          { href: "https://shop.example.com/app/account", text: "My account" },
        ],
      },
    ],
  };

  it("groups pages by section and names them from navigation labels", () => {
    const features = deriveFeatures(
      [
        page("https://shop.example.com/app", nav),
        page("https://shop.example.com/app/products"),
        page("https://shop.example.com/app/products/1", {
          forms: [{ name: null, action: null, method: "POST", fields: [{ tag: "input", type: "number", name: "qty", label: null, placeholder: null, required: true }], submitLabels: ["Add"] }],
        }),
        page("https://shop.example.com/app/account"),
        page("https://shop.example.com/app/order-history"),
      ],
      SCOPE,
    );
    expect(features.map((f) => f.name)).toEqual(["Home", "My account", "Order history", "Shop"]);
    const shop = features.find((f) => f.name === "Shop")!;
    expect(shop).toMatchObject({ url: "https://shop.example.com/app/products", description: "2 pages · 1 form · 1 input · 0 buttons" });
    expect(shop.pageUrls).toHaveLength(2);
  });

  it("keeps names unique", () => {
    const features = deriveFeatures(
      [page("https://shop.example.com/app/a", { navigation: [{ label: "M", links: [{ href: "/app/a", text: "Same" }, { href: "/app/b", text: "Same" }] }] }), page("https://shop.example.com/app/b")],
      SCOPE,
    );
    expect(new Set(features.map((f) => f.name)).size).toBe(features.length);
  });
});

describe("page element validation", () => {
  it("rejects oversized or malformed data from untrusted pages", () => {
    expect(pageElementsSchema.safeParse({ ...EMPTY_PAGE_ELEMENTS, headings: ["x".repeat(201)] }).success).toBe(false);
    expect(pageElementsSchema.safeParse({ ...EMPTY_PAGE_ELEMENTS, links: Array(301).fill({ href: "/", text: "", inNavigation: false }) }).success).toBe(false);
    expect(pageElementsSchema.safeParse({ ...EMPTY_PAGE_ELEMENTS, forms: [{ method: "PUT" }] }).success).toBe(false);
  });
});

describe("discovery login settings", () => {
  const base = { mode: "FORM_LOGIN", loginUrl: "https://shop.example.com/app/login", usernameSecretId: "cjld2cjxh0000qzrmn831i7rn", passwordSecretId: "cjld2cjxh0001qzrmn831i7rn" };

  it("requires a login URL and both secrets for form login", () => {
    const result = discoveryAuthInputSchema.safeParse({ mode: "FORM_LOGIN" });
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual(["loginUrl", "passwordSecretId", "usernameSecretId"]);
    expect(discoveryAuthInputSchema.safeParse({ mode: "NONE" }).success).toBe(true);
  });

  it.each(["#email", "form.login button[type=submit]", "input:not([type=hidden])", "[data-testid=login]"])("accepts CSS selector %s", (selector) => {
    expect(discoveryAuthInputSchema.safeParse({ ...base, submitSelector: selector }).success).toBe(true);
  });

  it.each(["xpath=//button", "//button", "..", "text=Sign in", '"Sign in"', "internal:role=button", "css=button\nx"])("refuses non-CSS selector %s", (selector) => {
    expect(discoveryAuthInputSchema.safeParse({ ...base, submitSelector: selector }).success).toBe(false);
  });
});
