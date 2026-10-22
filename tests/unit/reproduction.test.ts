import { describe, expect, it } from "vitest";
import type { ResultStatus } from "@/generated/prisma/enums";
import { failureSignature, flakeRate, needsReproduction, reconcileAttempts, summarizeAttempt, type AttemptOutcome } from "@/modules/execution/reproduction";

const step = (position: number, status: string, expected: string | null = null) => ({ position, status, expected, kind: "ASSERT" });
const passed: AttemptOutcome = { status: "PASSED", failureClass: null, error: null, steps: [step(0, "PASSED"), step(1, "PASSED")] };
const failedAt = (position: number, expected = 'textEquals "Total: $108"'): AttemptOutcome => ({
  status: "FAILED",
  failureClass: "APPLICATION",
  error: "x",
  steps: [step(0, "PASSED"), ...(position === 1 ? [step(1, "FAILED", expected)] : [step(1, "PASSED"), step(2, "FAILED", expected)])],
});
const inconclusive: AttemptOutcome = { status: "INCONCLUSIVE", failureClass: "TEST_DEFINITION", error: "x", steps: [step(0, "INCONCLUSIVE")] };
const attempts = (...outcomes: AttemptOutcome[]) => outcomes.map((o, i) => summarizeAttempt(i + 1, o, 100));

describe("failure signatures", () => {
  it("identify the verdict, class, failing step and expectation; passes have none", () => {
    expect(failureSignature(passed)).toBeNull();
    expect(failureSignature(failedAt(1))).toBe('FAILED | APPLICATION | step 2 | ASSERT | textEquals "Total: $108"');
    expect(failureSignature(failedAt(1))).not.toBe(failureSignature(failedAt(2)));
    expect(failureSignature(failedAt(1))).not.toBe(failureSignature(failedAt(1, "other")));
  });

  it("only re-executes executed failures", () => {
    expect(needsReproduction({ status: "FAILED" })).toBe(true);
    expect(needsReproduction({ status: "INCONCLUSIVE" })).toBe(true);
    for (const status of ["PASSED", "BLOCKED", "SKIPPED"] as const) expect(needsReproduction({ status })).toBe(false);
  });
});

describe("reconciling attempts", () => {
  it("reports a failure as reproduced only when every attempt failed identically", () => {
    expect(reconcileAttempts(attempts(failedAt(1), failedAt(1), failedAt(1)))).toMatchObject({ status: "FAILED", failureClass: "APPLICATION", reproduced: true, flaky: false });
    expect(reconcileAttempts(attempts(failedAt(1), failedAt(1), failedAt(1))).note).toContain("3 of 3");
  });

  it("identifies failures by the step's definition, not by values generated at run time", () => {
    // Each attempt fills a fresh unique value, so the runtime expectation differs every time.
    const attempt = (value: string): AttemptOutcome => ({
      status: "FAILED",
      failureClass: "APPLICATION",
      error: "x",
      steps: [{ position: 0, status: "FAILED", expected: `valueEquals "${value}"`, kind: "ASSERT", action: 'Still there — Assert valueEquals label "Display name" = {new_name}' }],
    });
    expect(reconcileAttempts(attempts(attempt("qa-1a2b3c4d"), attempt("qa-9f8e7d6c"), attempt("qa-00ff00ff")))).toMatchObject({ status: "FAILED", reproduced: true });
  });

  it("never treats a single attempt as reproduced", () => {
    expect(reconcileAttempts(attempts(failedAt(1)))).toMatchObject({ status: "FAILED", reproduced: false });
  });

  it("marks a case that both failed and passed as flaky and inconclusive", () => {
    for (const run of [attempts(failedAt(1), passed), attempts(failedAt(1), failedAt(1), passed), attempts(inconclusive, passed)]) {
      expect(reconcileAttempts(run)).toMatchObject({ status: "INCONCLUSIVE", flaky: true, reproduced: false });
    }
  });

  it("doesn't call differing failures reproduced", () => {
    expect(reconcileAttempts(attempts(failedAt(1), failedAt(2)))).toMatchObject({ status: "INCONCLUSIVE", flaky: false, reproduced: false });
    expect(reconcileAttempts(attempts(failedAt(1), inconclusive))).toMatchObject({ status: "INCONCLUSIVE", reproduced: false });
  });

  it("keeps consistent inconclusive outcomes inconclusive", () => {
    expect(reconcileAttempts(attempts(inconclusive, inconclusive))).toMatchObject({ status: "INCONCLUSIVE", failureClass: "TEST_DEFINITION", reproduced: true });
  });

  it("leaves passes alone", () => {
    expect(reconcileAttempts(attempts(passed))).toMatchObject({ status: "PASSED", flaky: false, reproduced: false, note: null });
  });
});

describe("flake rate across runs", () => {
  it.each([
    [["PASSED", "PASSED"], null],
    [["PASSED", "PASSED", "PASSED", "PASSED"], 0],
    // A regression, a fix, or a regression that stays: sustained changes aren't flakiness.
    [["PASSED", "PASSED", "FAILED", "FAILED"], 0],
    [["FAILED", "FAILED", "PASSED", "PASSED"], 0],
    [["PASSED", "PASSED", "PASSED", "FAILED"], 0],
    // Isolated blips are.
    [["PASSED", "FAILED", "PASSED"], 1],
    [["PASSED", "FAILED", "PASSED", "FAILED", "PASSED"], 1],
    [["PASSED", "PASSED", "INCONCLUSIVE", "PASSED", "PASSED", "PASSED"], 0.25],
    // Blocked/skipped executions don't count.
    [["PASSED", "BLOCKED", "PASSED", "SKIPPED", "PASSED"], 0],
  ] as Array<[ResultStatus[], number | null]>)("%j → %s", (history, expected) => {
    expect(flakeRate(history)).toBe(expected);
  });
});
