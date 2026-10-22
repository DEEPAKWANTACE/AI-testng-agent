import type { FailureClass, ResultStatus } from "@/generated/prisma/enums";
import type { CoverageSummary } from "@/modules/coverage/mapping";
import type { FaultSpec } from "./corpus";

/**
 * Benchmark metrics. Definitions (also shown on the benchmark page):
 *
 * - Bug recall: seeded faults for which at least one expected case FAILED (an application
 *   failure reproduced on every attempt) ÷ seeded faults. A failure only in an unrelated case
 *   doesn't count as detecting the fault.
 * - Case recall: expected (fault, case) failures observed ÷ all expected (fault, case) pairs.
 * - Report precision: correct FAILED reports ÷ all FAILED reports, where a FAILED report is
 *   correct only if the case is listed for the fault active in that variant. Every FAILED on
 *   the clean application or a noise variant is a false positive.
 * - Execution reliability: share of deterministic cases (known-flaky ones excluded) whose
 *   verdict was identical across the repeated clean runs; infrastructure rate: executions
 *   ending in an infrastructure problem.
 * - Flaky handling: known-flaky cases were never reported FAILED, and every time they didn't
 *   pass they were flagged flaky or inconclusive. (A flaky case that happens to pass on its
 *   first attempt can't be recognised within that run; the cross-run flake rate covers it.)
 */

export type CaseVerdict = { status: ResultStatus; failureClass: FailureClass | null; flaky: boolean };
export type RunVerdicts = { runStatus: string; cases: Record<string, CaseVerdict> };

export type BenchmarkInput = {
  faults: FaultSpec[];
  cleanRuns: RunVerdicts[];
  faultRuns: Array<{ fault: string; run: RunVerdicts }>;
  noiseRuns: Array<{ fault: string; run: RunVerdicts }>;
  knownFlaky: string[];
  coverage: CoverageSummary | null;
  mutationScore: number | null;
};

const failedCases = (run: RunVerdicts) => Object.entries(run.cases).filter(([, v]) => v.status === "FAILED").map(([title]) => title);
const ratio = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 1000);

export function computeMetrics(input: BenchmarkInput) {
  const perFault = input.faults.map((spec) => {
    const run = input.faultRuns.find((r) => r.fault === spec.fault)?.run;
    const failed = run ? failedCases(run) : [];
    const truePositives = failed.filter((t) => spec.affects.includes(t));
    const falsePositives = failed.filter((t) => !spec.affects.includes(t));
    const missed = spec.affects.filter((t) => !failed.includes(t));
    return { fault: spec.fault, kind: spec.kind, description: spec.description, ran: Boolean(run), detected: truePositives.length > 0, truePositives, falsePositives, missed, runStatus: run?.runStatus ?? null };
  });
  const evaluated = perFault.filter((f) => f.ran);

  const cleanFalsePositives = input.cleanRuns.flatMap((run, i) => failedCases(run).map((title) => ({ run: i + 1, title })));
  const noiseFalsePositives = input.noiseRuns.flatMap((r) => failedCases(r.run).map((title) => ({ variant: r.fault, title })));
  const tp = evaluated.reduce((n, f) => n + f.truePositives.length, 0);
  const fp = evaluated.reduce((n, f) => n + f.falsePositives.length, 0) + cleanFalsePositives.length + noiseFalsePositives.length;
  const expectedPairs = evaluated.reduce((n, f) => n + f.truePositives.length + f.missed.length, 0);

  // Reliability across the repeated clean runs.
  const titles = [...new Set(input.cleanRuns.flatMap((r) => Object.keys(r.cases)))].filter((t) => !input.knownFlaky.includes(t));
  const consistent = titles.filter((t) => new Set(input.cleanRuns.map((r) => r.cases[t]?.status ?? "MISSING")).size === 1);
  const allRuns = [...input.cleanRuns, ...input.faultRuns.map((r) => r.run), ...input.noiseRuns.map((r) => r.run)];
  const executions = allRuns.reduce((n, r) => n + Object.keys(r.cases).length, 0);
  const infrastructure = allRuns.reduce((n, r) => n + Object.values(r.cases).filter((v) => v.failureClass === "INFRASTRUCTURE" || v.status === "ERROR").length, 0) + allRuns.filter((r) => r.runStatus === "ERROR").length;
  const flakyOk = input.knownFlaky.map((title) => ({
    title,
    neverFailed: allRuns.every((r) => r.cases[title]?.status !== "FAILED"),
    nonPassesFlagged: allRuns.every((r) => !r.cases[title] || r.cases[title].status === "PASSED" || r.cases[title].flaky || r.cases[title].status === "INCONCLUSIVE"),
    verdicts: input.cleanRuns.map((r) => r.cases[title]?.status ?? "MISSING"),
  }));
  const inconsistent = titles.filter((t) => !consistent.includes(t)).map((t) => ({ title: t, verdicts: input.cleanRuns.map((r) => r.cases[t]?.status ?? "MISSING") }));

  return {
    metrics: {
      bugRecall: ratio(evaluated.filter((f) => f.detected).length, evaluated.length),
      caseRecall: ratio(tp, expectedPairs),
      reportPrecision: ratio(tp, tp + fp),
      falseAlarmsOnCleanApp: cleanFalsePositives.length,
      executionReliability: ratio(consistent.length, titles.length),
      infrastructureRate: ratio(infrastructure, executions),
      flakyHandled: flakyOk.every((f) => f.neverFailed && f.nonPassesFlagged),
      inventoryVerified: input.coverage ? ratio(input.coverage.byLevel.VERIFIED, input.coverage.known) : null,
      inventoryPlanned: input.coverage ? ratio(input.coverage.known - input.coverage.byLevel.NOT_PLANNED, input.coverage.known) : null,
      mutationScore: input.mutationScore,
      faultsEvaluated: evaluated.length,
      faultsDetected: evaluated.filter((f) => f.detected).length,
      cleanRuns: input.cleanRuns.length,
      caseExecutions: executions,
    },
    details: { perFault, cleanFalsePositives, noiseFalsePositives, inconsistent, flaky: flakyOk, coverage: input.coverage },
  };
}

export type BenchmarkMetrics = ReturnType<typeof computeMetrics>["metrics"];

export const BENCHMARK_DISCLAIMER =
  "Measured on the bundled Demo Shop corpus with known, seeded faults. These numbers describe how the agent performs on this corpus; they don't predict or guarantee accuracy on other applications, and the corpus can't contain every kind of defect.";
