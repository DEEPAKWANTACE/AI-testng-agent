import { describe, expect, it } from "vitest";
import { describeAction, executableStepSchema, referencedSecrets, resolveNavigation, stepParamsSchemas } from "@/modules/execution/steps";

const AUTH = "https://shop.example.com/app";
const ok = (step: unknown) => executableStepSchema.safeParse(step).success;

describe("executable step language", () => {
  it.each([
    { kind: "NAVIGATE", description: "Open cart", params: { url: "/app/cart" } },
    { kind: "NAVIGATE", description: "Open", params: { url: "https://shop.example.com/app" } },
    { kind: "CLICK", description: "Buy", params: { target: { by: "role", role: "button", name: "Buy now", exact: true } } },
    { kind: "CLICK", description: "Buy", params: { target: { by: "css", value: "form.checkout button[type=submit]" } } },
    { kind: "FILL", description: "Email", params: { target: { by: "label", value: "Email" }, value: { literal: "a@b.test" } } },
    { kind: "FILL", description: "Password", params: { target: { by: "css", value: "#pw" }, value: { secret: "TEST_PASSWORD" } } },
    { kind: "SELECT", description: "Sort", params: { target: { by: "label", value: "Sort by" }, option: "Price" } },
    { kind: "WAIT", description: "Wait", params: { for: "visible", target: { by: "testId", value: "results" } } },
    { kind: "WAIT", description: "Wait", params: { for: "time", ms: 500 } },
    { kind: "ASSERT", description: "Heading", params: { check: "visible", target: { by: "role", role: "heading", name: "Cart" } } },
    { kind: "ASSERT", description: "URL", params: { check: "urlContains", expected: "/cart" } },
    { kind: "ASSERT", description: "Count", params: { check: "count", target: { by: "css", value: "li.item" }, expected: 3 } },
  ])("accepts %j", (step) => {
    expect(ok(step)).toBe(true);
  });

  it.each([
    ["an unknown action", { kind: "EVALUATE", description: "x", params: { script: "alert(1)" } }],
    ["extra keys smuggling code", { kind: "CLICK", description: "x", params: { target: { by: "css", value: "a" }, script: "fetch('/')" } }],
    ["extra top-level keys", { kind: "CLICK", description: "x", code: "1", params: { target: { by: "css", value: "a" } } }],
    ["an unknown locator strategy", { kind: "CLICK", description: "x", params: { target: { by: "js", value: "document.body" } } }],
    ["an XPath engine selector", { kind: "CLICK", description: "x", params: { target: { by: "css", value: "xpath=//a" } } }],
    ["an auto-XPath selector", { kind: "CLICK", description: "x", params: { target: { by: "css", value: "//button" } } }],
    ["a chained selector", { kind: "CLICK", description: "x", params: { target: { by: "css", value: "div >> text=Buy" } } }],
    ["a javascript: URL", { kind: "NAVIGATE", description: "x", params: { url: "javascript:alert(1)" } }],
    ["a protocol-relative URL", { kind: "NAVIGATE", description: "x", params: { url: "//evil.example.com" } }],
    ["a data: URL", { kind: "NAVIGATE", description: "x", params: { url: "data:text/html,<script>1</script>" } }],
    ["an unknown ARIA role", { kind: "CLICK", description: "x", params: { target: { by: "role", role: "script" } } }],
    ["a lowercase secret name", { kind: "FILL", description: "x", params: { target: { by: "css", value: "#a" }, value: { secret: "password" } } }],
    ["a wait longer than 15s", { kind: "WAIT", description: "x", params: { for: "time", ms: 60_000 } }],
    ["a visibility wait without a target", { kind: "WAIT", description: "x", params: { for: "visible" } }],
    ["an assertion without an expected value", { kind: "ASSERT", description: "x", params: { check: "textEquals", target: { by: "css", value: "h1" } } }],
    ["a step without a description", { kind: "CLICK", description: "", params: { target: { by: "css", value: "a" } } }],
  ])("rejects %s", (_label, step) => {
    expect(ok(step)).toBe(false);
  });

  it("keeps navigation inside the authorized URL", () => {
    expect(resolveNavigation("/app/cart", AUTH)).toBe("https://shop.example.com/app/cart");
    expect(resolveNavigation("/admin", AUTH)).toBeNull();
    expect(resolveNavigation("https://evil.example.com/app", AUTH)).toBeNull();
    expect(resolveNavigation("https://u:p@shop.example.com/app", AUTH)).toBeNull();
    expect(resolveNavigation("/app/../admin", AUTH)).toBeNull();
  });

  it("lists referenced secrets and masks them in descriptions", () => {
    const steps = [
      { kind: "FILL", params: { target: { by: "css", value: "#u" }, value: { secret: "TEST_USER" } } },
      { kind: "FILL", params: { target: { by: "css", value: "#p" }, value: { secret: "TEST_PASSWORD" } } },
      { kind: "CLICK", params: { target: { by: "css", value: "button" } } },
    ];
    expect(referencedSecrets(steps).sort()).toEqual(["TEST_PASSWORD", "TEST_USER"]);
    expect(describeAction("FILL", steps[1].params)).toBe("Fill #p with secret TEST_PASSWORD");
  });

  it("validates params per kind", () => {
    expect(stepParamsSchemas.SELECT.safeParse({ target: { by: "label", value: "Size" }, option: "M" }).success).toBe(true);
    expect(stepParamsSchemas.SELECT.safeParse({ target: { by: "label", value: "Size" } }).success).toBe(false);
  });
});
