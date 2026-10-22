import "server-only";
import { db } from "@/lib/db";
import { can } from "@/modules/access/policy";
import { getProjectRole, projectScope } from "@/modules/access/service";
import type { Actor } from "@/modules/auth/service";
import { workingSnapshot } from "./service";
import { diffSnapshots, parsePlanSnapshot, snapshotHash, type PlanSnapshot } from "./snapshot";

export function listTestSuites(actor: Actor) {
  return db().testSuite.findMany({
    where: { application: { project: projectScope(actor) } },
    orderBy: { updatedAt: "desc" },
    include: {
      application: { select: { id: true, name: true, project: { select: { name: true } } } },
      planVersions: { orderBy: { version: "desc" }, take: 1, select: { version: true, status: true } },
      _count: { select: { testCases: { where: { status: "ACTIVE" } } } },
    },
  });
}

/** Returns null when the suite doesn't exist or the actor can't see it. */
export async function getTestSuite(actor: Actor, id: string) {
  const suite = await db().testSuite.findFirst({
    where: { id, application: { project: projectScope(actor) } },
    include: {
      application: { select: { id: true, name: true, projectId: true, project: { select: { id: true, name: true } } } },
      feature: { select: { id: true, name: true } },
      testCases: {
        where: { status: "ACTIVE" },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        include: { steps: { orderBy: { position: "asc" } }, feature: { select: { name: true } }, generationJob: { select: { provider: true, model: true } } },
      },
      planVersions: {
        orderBy: { version: "desc" },
        include: {
          approvals: { orderBy: { requestedAt: "desc" }, include: { reviewer: { select: { name: true } }, requestedBy: { select: { name: true } } } },
          testRuns: { orderBy: { createdAt: "desc" }, take: 5, select: { id: true, status: true, createdAt: true } },
          mutationRuns: { orderBy: { createdAt: "desc" }, take: 3 },
        },
      },
    },
  });
  if (!suite) return null;
  const role = await getProjectRole(actor, suite.application.projectId);

  // Working copy vs. the latest approved version: any material change needs a new approval.
  const approved = suite.planVersions.find((v) => v.status === "APPROVED");
  let working: { hash: string; snapshot: PlanSnapshot } | null = null;
  try {
    const snapshot = await workingSnapshot(db(), suite.id);
    working = { snapshot, hash: snapshot.cases.length ? await snapshotHash(db(), snapshot) : "" };
  } catch {
    working = null; // an invalid step; surfaced when submitting
  }
  const approvedSnapshot = approved?.snapshotFormat === 2 ? (parsePlanSnapshot(2, approved.snapshot).snapshot as PlanSnapshot) : null;
  const changes = working ? diffSnapshots(approvedSnapshot, working.snapshot) : null;

  return {
    ...suite,
    review: {
      workingHash: working?.hash ?? null,
      approvedHash: approved?.contentHash ?? null,
      approvedVersion: approved?.version ?? null,
      changedSinceApproval: Boolean(approved && working && working.hash !== approved.contentHash),
      changes,
      proposed: suite.testCases.filter((c) => c.reviewState === "PROPOSED").length,
      accepted: suite.testCases.filter((c) => c.reviewState === "ACCEPTED").length,
      rejected: suite.testCases.filter((c) => c.reviewState === "REJECTED").length,
    },
    permissions: {
      edit: can(actor.role, role, "suite.edit"),
      delete: can(actor.role, role, "suite.delete"),
      run: can(actor.role, role, "run.manage"),
    },
  };
}

export async function getTestCase(actor: Actor, suiteId: string, caseId: string) {
  return db().testCase.findFirst({
    where: { id: caseId, suiteId, status: "ACTIVE", suite: { application: { project: projectScope(actor) } } },
    include: { steps: { orderBy: { position: "asc" } }, suite: { select: { id: true, name: true } } },
  });
}
