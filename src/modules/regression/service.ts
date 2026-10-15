import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import { assertApplicationPermission } from "@/modules/access/service";
import { audit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/auth/service";
import { parsePlanSnapshot, type SnapshotCase } from "@/modules/test-suites/snapshot";

/** Approved cases available for regression suites: the latest approved version of each suite. */
export async function listApprovedCases(applicationId: string) {
  const versions = await db().planVersion.findMany({
    where: { status: "APPROVED", snapshotFormat: 2, suite: { applicationId, status: "ACTIVE" } },
    orderBy: { approvedAt: "desc" },
    select: { id: true, version: true, snapshot: true, snapshotFormat: true, contentHash: true, suite: { select: { id: true, name: true, kind: true } } },
  });
  return versions.flatMap((v) => {
    const parsed = parsePlanSnapshot(v.snapshotFormat, v.snapshot);
    if (parsed.format !== 2) return [];
    return parsed.snapshot.cases.map((c) => ({ versionId: v.id, version: v.version, suiteName: v.suite.name, contentHash: v.contentHash, case: c }));
  });
}

/**
 * Creates a REGRESSION suite from approved cases (selected by `versionId:caseKey`). Cases are
 * copied from the approved snapshot, keep their caseKey for run-to-run comparison, and the
 * new suite must itself be submitted and approved before it can run.
 */
export async function createRegressionSuite(actor: Actor, input: { applicationId: string; name: string; selections: string[] }) {
  await assertApplicationPermission(actor, input.applicationId, "suite.edit");
  if (input.selections.length === 0) throw new DomainError("Select at least one approved case.");

  const available = await listApprovedCases(input.applicationId);
  const byKey = new Map(available.map((a) => [`${a.versionId}:${a.case.caseKey}`, a]));
  const chosen: SnapshotCase[] = [];
  const seenKeys = new Set<string>();
  for (const selection of input.selections) {
    const entry = byKey.get(selection);
    if (!entry) throw new DomainError("A selected case is no longer part of an approved plan. Reload and try again.");
    if (seenKeys.has(entry.case.caseKey)) continue;
    seenKeys.add(entry.case.caseKey);
    chosen.push(entry.case);
  }

  const app = await db().application.findUniqueOrThrow({ where: { id: input.applicationId }, select: { projectId: true, features: { select: { id: true, name: true } } } });
  const featureIds = new Map(app.features.map((f) => [f.name, f.id]));

  const suite = await db().$transaction(async (tx) => {
    const created = await tx.testSuite.create({
      data: { applicationId: input.applicationId, name: input.name, kind: "REGRESSION", description: `Regression suite of ${chosen.length} approved case${chosen.length === 1 ? "" : "s"}.`, createdById: actor.id },
      select: { id: true },
    });
    for (const [position, c] of chosen.entries()) {
      await tx.testCase.create({
        data: {
          suiteId: created.id,
          caseKey: c.caseKey,
          featureId: c.featureName ? featureIds.get(c.featureName) ?? null : null,
          title: c.title,
          description: c.description,
          prerequisites: c.prerequisites,
          expectedResult: c.expectedResult,
          priority: c.priority,
          type: c.type,
          requirementRefs: c.requirementRefs,
          reviewState: "ACCEPTED",
          position,
          createdById: actor.id,
          steps: {
            create: c.steps.map((s) => ({
              position: s.position,
              action: s.action,
              expectedResult: s.expectedResult,
              kind: s.kind,
              params: (s.params ?? undefined) as Prisma.InputJsonValue | undefined,
            })),
          },
        },
      });
    }
    await audit({ actor, action: "regression.created", entityType: "TestSuite", entityId: created.id, projectId: app.projectId, data: { cases: chosen.map((c) => c.caseKey) } }, tx);
    return created;
  });
  return suite;
}
