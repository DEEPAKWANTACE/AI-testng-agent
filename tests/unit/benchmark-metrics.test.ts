import { describe, expect, it } from "vitest";
import type { FaultSpec } from "@/benchmark/corpus";
import { computeMetrics, type RunVerdicts } from "@/benchmark/metrics";

const run = (cases: Record<string, "PASSED" | "FAILED" | "INCONCLUSIVE" | "BLOCKED">, flaky: string[] = [], runStatus = "PASSED"): RunVerdicts => ({
  runStatus,
  cases: Object.fromEntries(Object.entries(cases).map(([t, s]) => [t, { status: s, failureClass: s === "FAILED" ? "APPLICATION" : s === "INCONCLUSIVE" ? "TEST_DEFINITION" : null, flaky: flaky.includes(t) }])),
});
const faults: FaultSpec[] = [
  { fault: "wrong-discount", kind: "rule", description: "", affects: ["Totals"] },
  { fault: "search-500", kind: "error", description: "", affects: ["Search", "Search API"] },
  { fault: "account-unprotected", kind: "access", description: "", affects: ["Account"] },
];
const clean = { Totals: "PASSED", Search: "PASSED", "Search API": "PASSED", Account: "PASSED", Deal: "INCONCLUSIVE" } as const;

describe("benchmark metrics", () => {
  it("computes recall, precision, reliability and flaky handling from verdicts and ground truth", () => {
    const { metrics, details } = computeMetrics({
      faults,
      cleanRuns: [run(clean, ["Deal"], "INCONCLUSIVE"), run(clean, ["Deal"], "INCONCLUSIVE")],
      faultRuns: [
        { fault: "wrong-discount", run: run({ ...clean, Totals: "FAILED" }) },
        // Detected through one of two expected cases, plus a wrong-reason failure (false positive).
        { fault: "search-500", run: run({ ...clean, Search: "FAILED", Account: "FAILED" }) },
        // Missed: the expected case only went inconclusive.
        { fault: "account-unprotected", run: run({ ...clean, Account: "INCONCLUSIVE" }) },
      ],
      noiseRuns: [{ fault: "slow-products", run: run({ ...clean, Totals: "FAILED" }) }],
      knownFlaky: ["Deal"],
      coverage: { known: 10, byLevel: { VERIFIED: 6, EXECUTED: 1, EXERCISED: 0, PLANNED: 1, NOT_PLANNED: 2 }, byKind: {} },
      mutationScore: 0.75,
    });
    expect(metrics).toMatchObject({
      bugRecall: 0.667, // 2 of 3 faults
      caseRecall: 0.5, // Totals, Search of {Totals, Search, Search API, Account}
      reportPrecision: 0.5, // TP: Totals, Search · FP: Account (wrong reason), Totals (noise)
      falseAlarmsOnCleanApp: 0,
      executionReliability: 1,
      infrastructureRate: 0,
      flakyHandled: true,
      inventoryVerified: 0.6,
      inventoryPlanned: 0.8,
      mutationScore: 0.75,
      faultsEvaluated: 3,
      faultsDetected: 2,
    });
    expect(details.perFault.find((f) => f.fault === "search-500")).toMatchObject({ detected: true, truePositives: ["Search"], falsePositives: ["Account"], missed: ["Search API"] });
    expect(details.noiseFalsePositives).toEqual([{ variant: "slow-products", title: "Totals" }]);
  });

  it("counts clean-app failures as false alarms and flags unstable verdicts", () => {
    const { metrics, details } = computeMetrics({
      faults: [faults[0]],
      cleanRuns: [run({ ...clean, Search: "FAILED" }), run(clean), run({ ...clean, Deal: "FAILED" })],
      faultRuns: [{ fault: "wrong-discount", run: run({ ...clean, Totals: "FAILED" }) }],
      noiseRuns: [],
      knownFlaky: ["Deal"],
      coverage: null,
      mutationScore: null,
    });
    // Deal is known-flaky: excluded from reliability, but failing it breaks flaky handling.
    expect(metrics).toMatchObject({ bugRecall: 1, falseAlarmsOnCleanApp: 2, reportPrecision: 0.333, executionReliability: 0.75, flakyHandled: false, inventoryVerified: null });
    expect(details.inconsistent.map((i) => i.title)).toEqual(["Search"]);
  });

  it("accepts a flaky case that sometimes passes, as long as it's never reported as failed", () => {
    const { metrics } = computeMetrics({
      faults: [],
      cleanRuns: [run({ ...clean, Deal: "PASSED" }), run(clean, ["Deal"])],
      faultRuns: [],
      noiseRuns: [],
      knownFlaky: ["Deal"],
      coverage: null,
      mutationScore: null,
    });
    expect(metrics).toMatchObject({ executionReliability: 1, flakyHandled: true });
    const unflagged = computeMetrics({ faults: [], cleanRuns: [run({ ...clean, Deal: "BLOCKED" })], faultRuns: [], noiseRuns: [], knownFlaky: ["Deal"], coverage: null, mutationScore: null });
    expect(unflagged.metrics.flakyHandled).toBe(false);
  });

  it("reports nothing it can't measure", () => {
    const { metrics } = computeMetrics({ faults: [], cleanRuns: [], faultRuns: [], noiseRuns: [], knownFlaky: [], coverage: null, mutationScore: null });
    expect(metrics).toMatchObject({ bugRecall: null, caseRecall: null, reportPrecision: null, executionReliability: null, infrastructureRate: null });
  });
});
