import type { Prisma } from "@/generated/prisma/client";
import type { DefectSeverity, Priority, ResultComparison, ResultStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

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

const FINISHED_RUN = { in: ["PASSED", "FAILED", "BLOCKED", "ERROR"] as Array<"PASSED" | "FAILED" | "BLOCKED" | "ERROR"> };

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
    if (comparison === "REGRESSED") regressions++;
    if (comparison === "FIXED") fixed++;
    if (previous) priorRuns.set(previous.testRunId, (priorRuns.get(previous.testRunId) ?? 0) + 1);
    await db().testResult.update({ where: { id: result.id }, data: { comparison, previousStatus: previous?.status ?? null } });
  }

  const comparedToRunId = [...priorRuns.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  await db().testRun.update({ where: { id: runId }, data: { comparedToRunId } });
  return { regressions, fixed };
}

export type FeatureCoverage = { feature: string; total: number; passed: number; failed: number; blocked: number; skipped: number; passRate: number | null };

/** Counts, per-feature coverage and regression totals; stored on the Report row. */
export async function buildReport(runId: string) {
  const { regressions, fixed } = await compareWithHistory(runId);
  const run = await db().testRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      status: true,
      planVersion: { select: { version: true, suite: { select: { name: true, applicationId: true } } } },
      results: { select: { status: true, featureName: true } },
    },
  });
  const count = (s: ResultStatus) => run.results.filter((r) => r.status === s).length;

  const byFeature = new Map<string, FeatureCoverage>();
  for (const r of run.results) {
    const key = r.featureName ?? "(no feature)";
    const entry = byFeature.get(key) ?? { feature: key, total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, passRate: null };
    entry.total++;
    if (r.status === "PASSED") entry.passed++;
    else if (r.status === "FAILED" || r.status === "ERROR") entry.failed++;
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
    skipped: count("SKIPPED"),
  };
  const coverage = { features: [...byFeature.values()].sort((a, b) => a.feature.localeCompare(b.feature)), uncovered } as unknown as Prisma.InputJsonValue;
  const summary = `${totals.passed} passed, ${totals.failed + totals.errored} failed, ${totals.blocked} blocked, ${totals.skipped} skipped` + (regressions ? ` · ${regressions} regression${regressions === 1 ? "" : "s"}` : "") + (fixed ? ` · ${fixed} fixed` : "");
  const title = `${run.planVersion.suite.name} v${run.planVersion.version} — ${run.status.toLowerCase()}`;

  await db().report.upsert({
    where: { testRunId: runId },
    create: { testRunId: runId, title, summary, ...totals, regressions, fixed, coverage },
    update: { title, summary, ...totals, regressions, fixed, coverage },
  });
  return { ...totals, regressions, fixed };
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
          defects: { select: { id: true, severity: true, status: true } },
        },
      },
    },
  });
  if (!run) return null;
  return {
    ...run,
    results: run.results.map((r) => ({
      ...r,
      suggestedSeverity: r.status === "FAILED" || r.status === "ERROR" ? SEVERITY_FOR_PRIORITY[r.casePriority] : null,
      reproduction: r.stepResults.filter((s) => s.status !== "SKIPPED").map((s) => s.action),
      failedStep: r.stepResults.find((s) => s.status === "FAILED") ?? null,
    })),
  };
}

export type ReportData = NonNullable<Awaited<ReturnType<typeof loadReportData>>>;
