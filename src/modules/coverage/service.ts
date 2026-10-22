import { db } from "@/lib/db";
import { parsePlanSnapshot, type PlanSnapshot } from "@/modules/test-suites/snapshot";
import { computeCoverage, summarizeCoverage, type LatestResult, type PlannedCase } from "./mapping";

const FINISHED = ["PASSED", "FAILED", "BLOCKED", "INCONCLUSIVE", "ERROR"] as const;

/** Approved plan content of the application: the latest approved version of each active suite. */
export async function approvedPlans(applicationId: string, suiteIds?: string[]): Promise<PlannedCase[]> {
  const versions = await db().planVersion.findMany({
    where: { status: "APPROVED", snapshotFormat: 2, suite: { applicationId, status: "ACTIVE", ...(suiteIds ? { id: { in: suiteIds } } : {}) } },
    orderBy: { version: "desc" },
    distinct: ["suiteId"],
    select: { version: true, snapshot: true, snapshotFormat: true, suite: { select: { name: true } } },
  });
  return versions.flatMap((v) => {
    const { snapshot } = parsePlanSnapshot(v.snapshotFormat, v.snapshot) as { snapshot: PlanSnapshot };
    return snapshot.cases.map((testCase) => ({ suiteName: v.suite.name, version: v.version, testCase }));
  });
}

/** Most recent executed result per case key in this application. */
export async function latestResults(applicationId: string, caseKeys: string[]): Promise<Map<string, LatestResult>> {
  if (!caseKeys.length) return new Map();
  const results = await db().testResult.findMany({
    where: { caseKey: { in: caseKeys }, status: { not: "SKIPPED" }, testRun: { status: { in: [...FINISHED] }, planVersion: { suite: { applicationId } } } },
    orderBy: { testRun: { createdAt: "desc" } },
    distinct: ["caseKey"],
    select: { caseKey: true, status: true, testRunId: true, network: true },
  });
  return new Map(results.map((r) => [r.caseKey!, { status: r.status, runId: r.testRunId, network: (r.network as LatestResult["network"]) ?? [] }]));
}

/** Coverage of the application's known inventory by its approved plans and latest results. */
export async function applicationCoverage(applicationId: string) {
  const items = await db().inventoryItem.findMany({ where: { applicationId, active: true }, select: { id: true, kind: true, key: true, title: true }, orderBy: [{ kind: "asc" }, { key: "asc" }] });
  const planned = await approvedPlans(applicationId);
  const latest = await latestResults(applicationId, [...new Set(planned.map((p) => p.testCase.caseKey))]);
  const coverage = computeCoverage(items, planned, latest);
  return { items, coverage, summary: summarizeCoverage(items, coverage) };
}
