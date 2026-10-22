import type { FailureClass, ResultStatus } from "@/generated/prisma/enums";

/**
 * Reproduction rules. A case that doesn't pass is executed again in fresh, isolated browser
 * contexts. Only a failure that recurs with the same signature on every attempt counts as
 * reproduced, and only a reproduced application failure can open a defect. A case that both
 * passes and fails is flaky: its verdict is INCONCLUSIVE and it never opens a defect.
 */

export type AttemptOutcome = {
  status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "SKIPPED";
  failureClass: FailureClass | null;
  /** `action` is the step's static description (from the approved plan); `expected` may hold run-time values. */
  steps: Array<{ position: number; status: string; expected: string | null; kind: string | null; action?: string }>;
  error: string | null;
};

export type AttemptSummary = {
  attempt: number;
  status: AttemptOutcome["status"];
  failureClass: FailureClass | null;
  failedStep: number | null;
  signature: string | null;
  error: string | null;
  durationMs: number;
};

/**
 * Identifies *how* a case failed: verdict, class, failing step and that step's definition.
 * The definition comes from the approved plan, not from run-time values (a unique value
 * generated per attempt must not make identical failures look different).
 */
export function failureSignature(outcome: AttemptOutcome): string | null {
  if (outcome.status === "PASSED" || outcome.status === "SKIPPED") return null;
  const step = outcome.steps.find((s) => s.status !== "PASSED" && s.status !== "SKIPPED");
  return [outcome.status, outcome.failureClass ?? "-", step ? `step ${step.position + 1}` : "case", step?.kind ?? "-", step?.action ?? step?.expected ?? "-"].join(" | ");
}

export function summarizeAttempt(attempt: number, outcome: AttemptOutcome, durationMs: number): AttemptSummary {
  const failed = outcome.steps.find((s) => s.status !== "PASSED" && s.status !== "SKIPPED");
  return {
    attempt,
    status: outcome.status,
    failureClass: outcome.failureClass,
    failedStep: failed ? failed.position : null,
    signature: failureSignature(outcome),
    error: outcome.error,
    durationMs,
  };
}

/** Only executed failures are worth repeating; blocked/skipped cases can't change on retry. */
export function needsReproduction(outcome: Pick<AttemptOutcome, "status">): boolean {
  return outcome.status === "FAILED" || outcome.status === "INCONCLUSIVE";
}

export type Reconciled = {
  status: AttemptOutcome["status"];
  failureClass: FailureClass | null;
  flaky: boolean;
  /** The first attempt's failure recurred, identically, on every attempt. */
  reproduced: boolean;
  /** Replaces the case's explanation when attempts disagree; appended otherwise. */
  note: string | null;
};

export function reconcileAttempts(attempts: AttemptSummary[]): Reconciled {
  const [first] = attempts;
  if (!first) throw new Error("No attempts to reconcile");
  const n = attempts.length;
  if (first.status === "PASSED" || !needsReproduction(first)) {
    return { status: first.status, failureClass: first.failureClass, flaky: false, reproduced: false, note: null };
  }
  const passes = attempts.filter((a) => a.status === "PASSED").length;
  if (passes > 0) {
    return {
      status: "INCONCLUSIVE",
      failureClass: first.failureClass,
      flaky: true,
      reproduced: false,
      note: `Flaky: passed in ${passes} of ${n} attempts and failed in the others, so no defect is reported. Investigate timing, test data or environment stability.`,
    };
  }
  if (attempts.every((a) => a.signature === first.signature)) {
    return {
      status: first.status,
      failureClass: first.failureClass,
      flaky: false,
      reproduced: n > 1,
      note: n > 1 ? `Reproduced identically in ${n} of ${n} attempts.` : null,
    };
  }
  return {
    status: "INCONCLUSIVE",
    failureClass: first.failureClass,
    flaky: false,
    reproduced: false,
    note: `Didn't pass in any of ${n} attempts, but failed differently across attempts, so the failure isn't reproducible as reported.`,
  };
}

/**
 * Heuristic flakiness of a case across runs (oldest → newest): the share of interior runs whose
 * pass/not-pass outcome differs from *both* neighbours (an isolated blip). A sustained change, a
 * regression or a fix, doesn't count. Null with fewer than three executed runs.
 */
export function flakeRate(history: ResultStatus[]): number | null {
  const passed = history.filter((s) => s === "PASSED" || s === "FAILED" || s === "INCONCLUSIVE" || s === "ERROR").map((s) => s === "PASSED");
  if (passed.length < 3) return null;
  let blips = 0;
  for (let i = 1; i < passed.length - 1; i++) if (passed[i] !== passed[i - 1] && passed[i] !== passed[i + 1]) blips++;
  return Math.round((blips / (passed.length - 2)) * 100) / 100;
}
