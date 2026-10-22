import type { FailureClass, ResultStatus, TestRunStatus } from "@/generated/prisma/enums";

/**
 * Verdict rules. A FAILED verdict is reserved for evidence that the application itself
 * misbehaved: a deterministic assertion that didn't hold, or the server answering with a
 * 5xx while the step was waiting for the page. Everything else that stops a case (a locator
 * that matches nothing or too much, a slow or unreachable target, a scope violation) is not
 * evidence of an application defect, and is reported as INCONCLUSIVE or BLOCKED with the
 * reason, so infrastructure and test problems never inflate the defect count.
 */

export type StepErrorKind =
  /** An ASSERT step's condition did not hold before its timeout. */
  | "assertion"
  /** A locator matched nothing (or never reached the wanted state) in time. */
  | "locator-timeout"
  /** A locator matched several elements where one was required. */
  | "locator-ambiguous"
  /** The step itself points outside the authorized URL. */
  | "out-of-scope-step"
  /** The application redirected outside the authorized URL; the sandbox stopped it. */
  | "redirected-out-of-scope"
  /** The target refused the connection, didn't resolve, reset, or TLS failed. */
  | "network"
  /** A navigation didn't finish loading in time. */
  | "navigation-timeout"
  /** A secret or other precondition couldn't be resolved. */
  | "precondition"
  /** The step can't be carried out as written (missing variable, non-numeric value, wrong page). */
  | "test-definition"
  /** A visual check has no reviewer-approved baseline yet. */
  | "no-baseline"
  | "other";

export type StepVerdict = { status: Extract<ResultStatus, "FAILED" | "INCONCLUSIVE" | "BLOCKED">; failureClass: FailureClass; cause: string };

/** Classifies why a step didn't pass. `documentStatus` is the last main-document HTTP status. */
export function classifyStepError(kind: StepErrorKind, context: { documentStatus: number | null }): StepVerdict {
  const serverError = context.documentStatus !== null && context.documentStatus >= 500;
  switch (kind) {
    case "assertion":
      return {
        status: "FAILED",
        failureClass: "APPLICATION",
        cause: serverError
          ? `The page returned HTTP ${context.documentStatus}, and the expected result didn't appear.`
          : "The application's behaviour differs from the expected result.",
      };
    case "locator-timeout":
      return serverError
        ? { status: "FAILED", failureClass: "APPLICATION", cause: `The page returned HTTP ${context.documentStatus}, so the element the step needed never appeared.` }
        : { status: "INCONCLUSIVE", failureClass: "TEST_DEFINITION", cause: "The element wasn't found in time. Either the application changed or the test's locator is outdated; review before treating it as a defect." };
    case "locator-ambiguous":
      return { status: "INCONCLUSIVE", failureClass: "TEST_DEFINITION", cause: "The locator matches more than one element; the test needs a more specific locator." };
    case "out-of-scope-step":
      return { status: "BLOCKED", failureClass: "TEST_DEFINITION", cause: "The step points outside the authorized URL, so it wasn't executed." };
    case "redirected-out-of-scope":
      return { status: "BLOCKED", failureClass: "ENVIRONMENT", cause: "The application redirected outside the authorized URL; the sandbox stopped the navigation." };
    case "network":
      return { status: "INCONCLUSIVE", failureClass: "INFRASTRUCTURE", cause: "The target couldn't be reached (connection, DNS or TLS failure)." };
    case "navigation-timeout":
      return { status: "INCONCLUSIVE", failureClass: "INFRASTRUCTURE", cause: "The page didn't finish loading in time." };
    case "precondition":
      return { status: "BLOCKED", failureClass: "ENVIRONMENT", cause: "A precondition (such as a secret) couldn't be satisfied." };
    case "no-baseline":
      return { status: "INCONCLUSIVE", failureClass: "TEST_DEFINITION", cause: "There's no approved visual baseline for this check yet. The capture was saved as a candidate; a reviewer must approve it before visual results count." };
    case "test-definition":
      return { status: "INCONCLUSIVE", failureClass: "TEST_DEFINITION", cause: "The step couldn't be carried out as written (for example a value it needs wasn't captured, or isn't a number); review the test." };
    case "other":
      return { status: "INCONCLUSIVE", failureClass: "UNKNOWN", cause: "The step raised an unexpected error." };
  }
}

const NETWORK_ERROR = /net::ERR_(?:CONNECTION_(?:REFUSED|RESET|CLOSED|FAILED|TIMED_OUT)|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|SSL_\w+|CERT_\w+|EMPTY_RESPONSE|TIMED_OUT)/;

/** Maps a raw Playwright/step error to a kind, given which step kind raised it. */
export function errorKindOf(error: unknown, stepKind: string, flags: { assertion: boolean; timeout: boolean; precondition: boolean; definition?: boolean; noBaseline?: boolean }): StepErrorKind {
  const text = String(error instanceof Error ? error.message : error);
  if (flags.assertion) return "assertion";
  if (flags.precondition) return "precondition";
  if (flags.noBaseline) return "no-baseline";
  if (flags.definition) return "test-definition";
  if (/outside the authorized URL/.test(text)) return /redirected/.test(text) ? "redirected-out-of-scope" : "out-of-scope-step";
  if (/strict mode violation/.test(text)) return "locator-ambiguous";
  if (NETWORK_ERROR.test(text)) return "network";
  if (flags.timeout) return stepKind === "NAVIGATE" ? "navigation-timeout" : "locator-timeout";
  return "other";
}

/** A run passes only if every case passed; any FAILED fails it; otherwise inconclusive or blocked. */
export function overallStatus(statuses: ResultStatus[]): TestRunStatus {
  if (statuses.some((s) => s === "FAILED")) return "FAILED";
  if (statuses.length > 0 && statuses.every((s) => s === "PASSED")) return "PASSED";
  if (statuses.some((s) => s === "INCONCLUSIVE" || s === "ERROR")) return "INCONCLUSIVE";
  return "BLOCKED";
}

export const FAILURE_CLASS_LABELS: Record<FailureClass, string> = {
  APPLICATION: "Application behaviour",
  TEST_DEFINITION: "Test definition",
  INFRASTRUCTURE: "Infrastructure",
  ENVIRONMENT: "Environment / precondition",
  UNKNOWN: "Unknown",
};
