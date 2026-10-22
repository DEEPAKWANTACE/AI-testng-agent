import { errors } from "playwright";
import { describe, expect, it } from "vitest";
import { classifyStepError, errorKindOf, type StepErrorKind } from "@/modules/execution/verdict";

const flags = (f: Partial<{ assertion: boolean; timeout: boolean; precondition: boolean }> = {}) => ({ assertion: false, timeout: false, precondition: false, ...f });

describe("failure classification", () => {
  it.each([
    ["assertion", null, "FAILED", "APPLICATION"],
    ["assertion", 500, "FAILED", "APPLICATION"],
    ["locator-timeout", null, "INCONCLUSIVE", "TEST_DEFINITION"],
    ["locator-timeout", 200, "INCONCLUSIVE", "TEST_DEFINITION"],
    ["locator-timeout", 404, "INCONCLUSIVE", "TEST_DEFINITION"],
    ["locator-timeout", 503, "FAILED", "APPLICATION"],
    ["locator-ambiguous", 500, "INCONCLUSIVE", "TEST_DEFINITION"],
    ["out-of-scope-step", null, "BLOCKED", "TEST_DEFINITION"],
    ["redirected-out-of-scope", null, "BLOCKED", "ENVIRONMENT"],
    ["network", null, "INCONCLUSIVE", "INFRASTRUCTURE"],
    ["navigation-timeout", null, "INCONCLUSIVE", "INFRASTRUCTURE"],
    ["precondition", null, "BLOCKED", "ENVIRONMENT"],
    ["other", null, "INCONCLUSIVE", "UNKNOWN"],
  ] as Array<[StepErrorKind, number | null, string, string]>)("%s (document %s) → %s / %s", (kind, documentStatus, status, failureClass) => {
    expect(classifyStepError(kind, { documentStatus })).toMatchObject({ status, failureClass });
  });

  it("never turns non-assertion problems into application failures without a server error", () => {
    const kinds: StepErrorKind[] = ["locator-timeout", "locator-ambiguous", "out-of-scope-step", "redirected-out-of-scope", "network", "navigation-timeout", "precondition", "other"];
    for (const kind of kinds) for (const documentStatus of [null, 200, 302, 401, 404]) {
      expect(classifyStepError(kind, { documentStatus }).status).not.toBe("FAILED");
    }
  });

  it("maps raw errors to kinds", () => {
    const timeout = new errors.TimeoutError("locator.click: Timeout 3000ms exceeded");
    expect(errorKindOf(new Error("x"), "ASSERT", flags({ assertion: true }))).toBe("assertion");
    expect(errorKindOf(timeout, "CLICK", flags({ timeout: true }))).toBe("locator-timeout");
    expect(errorKindOf(new errors.TimeoutError("page.goto: Timeout 3000ms exceeded"), "NAVIGATE", flags({ timeout: true }))).toBe("navigation-timeout");
    expect(errorKindOf(new Error("strict mode violation: getByRole('link') resolved to 3 elements"), "CLICK", flags())).toBe("locator-ambiguous");
    expect(errorKindOf(new Error("Navigation target is outside the authorized URL"), "NAVIGATE", flags())).toBe("out-of-scope-step");
    expect(errorKindOf(new Error("Navigation was redirected outside the authorized URL"), "NAVIGATE", flags())).toBe("redirected-out-of-scope");
    expect(errorKindOf(new Error("page.goto: net::ERR_CONNECTION_REFUSED at http://x"), "NAVIGATE", flags())).toBe("network");
    expect(errorKindOf(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED"), "NAVIGATE", flags())).toBe("network");
    expect(errorKindOf(new Error("Secret X couldn't be resolved"), "FILL", flags({ precondition: true }))).toBe("precondition");
    expect(errorKindOf(new Error("something odd"), "CLICK", flags())).toBe("other");
  });
});
