import type { Prisma } from "@/generated/prisma/client";
import type { DefectSeverity, Priority, ResultComparison, ResultStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { computeCoverage, COVERAGE_DISCLAIMER, summarizeCoverage, type LatestResult } from "@/modules/coverage/mapping";
import { flakeRate } from "@/modules/execution/reproduction";
import { parsePlanSnapshot, type PlanSnapshot } from "@/modules/test-suites/snapshot";

/** Severity suggested for a failure, from the case's priority. Shown as a suggestion. */
export const SEVERITY_FOR_PRIORITY: Record<Priority, DefectSeverity> = {
  CRITICAL: "CRITICAL",
  HIGH: "MAJOR",
  MEDIUM: "MINOR",
  LOW: "TRIVIAL",
};

/** Label that must accompany any suspected cause: it's a heuristic hint, never a finding. */
export const SUSPECTED_CAUSE_LABEL = "Suspected cause (AI/heuristic, unconfirmed)";

export function compareStatus(previous: ResultStatus | null, current: ResultStatus): ResultComparison {
  if (!previous) return "NEW";
  const ok = (s: ResultStatus) => s === "PASSED";
  const bad = (s: ResultStatus) => s === "FAILED" || s === "ERROR";
  if (ok(previous) && bad(current)) return "REGRESSED";
  if (bad(previous) && ok(current)) return "FIXED";
  if (bad(previous) && bad(current)) return "STILL_FAILING";
  return "UNCHANGED";
}

/** Number of most recent runs of a case considered for its flake rate. */
const FLAKE_WINDOW = 10;

const FINISHED_RUN = { in: ["PASSED", "FAILED", "BLOCKED", "INCONCLUSIVE", "ERROR"] as Array<"PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "ERROR"> };

/**
 * Compares each result with the most recent earlier result for the same case (by caseKey)
 * in the same application, across suites and versions, and stores the comparison.
 */
export async function compareWithHistory(runId: string) {
  const run = await db().testRun.findUniqueOrThrow({
    where: { id: runId },
    select: { createdAt: true, planVersion: { select: { suite: { select: { applicationId: true } } } }, results: { select: { id: true, caseKey: true, status: true } } },
  });
  const applicationId = run.planVersion.suite.applicationId;
  const priorRuns = new Map<string, number>();
  let regressions = 0;
  let fixed = 0;

  for (const result of run.results) {
    if (!result.caseKey) continue;
    const previous = await db().testResult.findFirst({
      where: {
        caseKey: result.caseKey,
        testRunId: { not: runId },
        status: { not: "SKIPPED" },
        testRun: { status: FINISHED_RUN, createdAt: { lt: run.createdAt }, planVersion: { suite: { applicationId } } },
      },
      orderBy: { testRun: { createdAt: "desc" } },
      select: { status: true, testRunId: true },
    });
    const comparison = compareStatus(previous?.status ?? null, result.status);
    // Recent executed history of the same case (oldest first, ending with this run).
    const history = await db().testResult.findMany({
      where: {
        caseKey: result.caseKey,
        testRunId: { not: runId },
        status: { in: ["PASSED", "FAILED", "INCONCLUSIVE", "ERROR"] },
        testRun: { status: FINISHED_RUN, createdAt: { lt: run.createdAt }, planVersion: { suite: { applicationId } } },
      },
      orderBy: { testRun: { createdAt: "desc" } },
      take: FLAKE_WINDOW - 1,
      select: { status: true },
    });
    if (comparison === "REGRESSED") regressions++;
    if (comparison === "FIXED") fixed++;
    if (previous) priorRuns.set(previous.testRunId, (priorRuns.get(previous.testRunId) ?? 0) + 1);
    await db().testResult.update({
      where: { id: result.id },
      data: { comparison, previousStatus: previous?.status ?? null, flakeRate: flakeRate([...history.map((h) => h.status).reverse(), result.status]) },
    });
  }

  const comparedToRunId = [...priorRuns.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  await db().testRun.update({ where: { id: runId }, data: { comparedToRunId } });
  return { regressions, fixed };
}

export type FeatureCoverage = { feature: string; total: number; passed: number; failed: number; blocked: number; inconclusive: number; skipped: number; passRate: number | null };

/** Counts, per-feature coverage and regression totals; stored on the Report row. */
export async function buildReport(runId: string) {
  const { regressions, fixed } = await compareWithHistory(runId);
  const run = await db().testRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      status: true,
      planVersion: { select: { version: true, snapshot: true, snapshotFormat: true, suite: { select: { name: true, applicationId: true } } } },
      results: { select: { status: true, featureName: true, failureClass: true, flaky: true, caseKey: true, testRunId: true, network: true } },
    },
  });
  const count = (s: ResultStatus) => run.results.filter((r) => r.status === s).length;

  const byFeature = new Map<string, FeatureCoverage>();
  for (const r of run.results) {
    const key = r.featureName ?? "(no feature)";
    const entry = byFeature.get(key) ?? { feature: key, total: 0, passed: 0, failed: 0, blocked: 0, inconclusive: 0, skipped: 0, passRate: null };
    entry.total++;
    if (r.status === "PASSED") entry.passed++;
    else if (r.status === "FAILED") entry.failed++;
    else if (r.status === "INCONCLUSIVE" || r.status === "ERROR") entry.inconclusive++;
    else if (r.status === "BLOCKED") entry.blocked++;
    else entry.skipped++;
    byFeature.set(key, entry);
  }
  for (const entry of byFeature.values()) {
    const executed = entry.passed + entry.failed;
    entry.passRate = executed ? Math.round((entry.passed / executed) * 100) : null;
  }
  const appFeatures = await db().feature.findMany({ where: { applicationId: run.planVersion.suite.applicationId, status: "ACTIVE" }, select: { name: true } });
  const uncovered = appFeatures.map((f) => f.name).filter((name) => !byFeature.has(name));

  const totals = {
    passed: count("PASSED"),
    failed: count("FAILED") ,
    errored: count("ERROR"),
    blocked: count("BLOCKED"),
    inconclusive: count("INCONCLUSIVE"),
    skipped: count("SKIPPED"),
    flaky: run.results.filter((r) => r.flaky).length,
  };
  const failureClasses: Record<string, number> = {};
  for (const r of run.results) if (r.failureClass) failureClasses[r.failureClass] = (failureClasses[r.failureClass] ?? 0) + 1;
  const coverage = {
    features: [...byFeature.values()].sort((a, b) => a.feature.localeCompare(b.feature)),
    uncovered,
    inventory: await runInventoryCoverage(run),
  } as unknown as Prisma.InputJsonValue;
  const summary = `${totals.passed} passed, ${totals.failed} failed, ${totals.blocked} blocked, ${totals.inconclusive + totals.errored} inconclusive, ${totals.skipped} skipped` + (regressions ? ` · ${regressions} regression${regressions === 1 ? "" : "s"}` : "") + (fixed ? ` · ${fixed} fixed` : "") + (totals.flaky ? ` · ${totals.flaky} flaky` : "");
  const title = `${run.planVersion.suite.name} v${run.planVersion.version} — ${run.status.toLowerCase()}`;

  await db().report.upsert({
    where: { testRunId: runId },
    create: { testRunId: runId, title, summary, ...totals, regressions, fixed, coverage, failureClasses },
    update: { title, summary, ...totals, regressions, fixed, coverage, failureClasses },
  });
  return { ...totals, regressions, fixed };
}

/** How much of the known inventory this run's plan targets, and what this run verified. */
async function runInventoryCoverage(run: {
  planVersion: { snapshot: unknown; snapshotFormat: number; suite: { name: string; applicationId: string }; version: number };
  results: Array<{ caseKey: string | null; status: ResultStatus; testRunId: string; network: unknown }>;
}) {
  if (run.planVersion.snapshotFormat !== 2) return null;
  const items = await db().inventoryItem.findMany({ where: { applicationId: run.planVersion.suite.applicationId, active: true }, select: { id: true, kind: true, key: true, title: true } });
  if (!items.length) return null;
  const { snapshot } = parsePlanSnapshot(2, run.planVersion.snapshot) as { snapshot: PlanSnapshot };
  const planned = snapshot.cases.map((testCase) => ({ suiteName: run.planVersion.suite.name, version: run.planVersion.version, testCase }));
  const latest = new Map<string, LatestResult>(
    run.results.filter((r) => r.caseKey && r.status !== "SKIPPED").map((r) => [r.caseKey!, { status: r.status, runId: r.testRunId, network: (r.network as LatestResult["network"]) ?? [] }]),
  );
  const coverage = computeCoverage(items, planned, latest);
  return {
    ...summarizeCoverage(items, coverage),
    notVerified: coverage.filter((c) => c.level !== "VERIFIED").slice(0, 50).map((c) => items.find((i) => i.id === c.itemId)!.key),
    disclaimer: COVERAGE_DISCLAIMER,
  };
}

/** Everything a report view or download needs, already scoped to one run. */
export async function loadReportData(runId: string) {
  const run = await db().testRun.findUnique({
    where: { id: runId },
    include: {
      report: true,
      triggeredBy: { select: { name: true } },
      comparedToRun: { select: { id: true, createdAt: true, status: true } },
      planVersion: {
        select: {
          id: true,
          version: true,
          contentHash: true,
          approvedAt: true,
          approvals: { where: { status: "APPROVED" }, select: { reviewer: { select: { name: true } }, decidedAt: true, decidedHash: true } },
          suite: { select: { id: true, name: true, kind: true, application: { select: { id: true, name: true, authorizedUrl: true, projectId: true, project: { select: { name: true } } } } } },
        },
      },
      results: {
        orderBy: { createdAt: "asc" },
        include: {
          stepResults: { orderBy: { position: "asc" }, include: { artifacts: { select: { id: true, kind: true } } } },
          artifacts: { select: { id: true, kind: true, name: true } },
          defects: { select: { id: true, severity: true, status: true, verification: true, verifiedAt: true, verificationNote: true, verifiedBy: { select: { name: true } } } },
        },
      },
    },
  });
  if (!run) return null;
  return {
    ...run,
    results: run.results.map((r) => ({
      ...r,
      suggestedSeverity: r.status === "FAILED" && r.failureClass !== "TEST_DEFINITION" ? SEVERITY_FOR_PRIORITY[r.casePriority] : null,
      reproduction: r.stepResults.filter((s) => s.status !== "SKIPPED").map((s) => s.action),
      failedStep: r.stepResults.find((s) => s.status === "FAILED" || s.status === "INCONCLUSIVE" || s.status === "BLOCKED" || s.status === "ERROR") ?? null,
    })),
  };
}

export type ReportData = NonNullable<Awaited<ReturnType<typeof loadReportData>>>;
