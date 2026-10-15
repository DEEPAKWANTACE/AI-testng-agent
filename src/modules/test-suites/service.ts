import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import type { Permission } from "@/modules/access/policy";
import { assertApplicationPermission, NotFoundError } from "@/modules/access/service";
import { audit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/auth/service";
import type { TestCaseInput, TestSuiteInput } from "./schemas";
import { buildPlanSnapshot, snapshotHash, type PlanSnapshot } from "./snapshot";

type Client = Prisma.TransactionClient | ReturnType<typeof db>;

async function suiteContext(actor: Actor, suiteId: string, permission: Permission) {
  const suite = await db().testSuite.findUnique({
    where: { id: suiteId },
    select: { id: true, applicationId: true, application: { select: { projectId: true } } },
  });
  if (!suite) throw new NotFoundError("Test suite");
  try {
    await assertApplicationPermission(actor, suite.applicationId, permission);
  } catch (error) {
    throw error instanceof NotFoundError ? new NotFoundError("Test suite") : error;
  }
  return { suiteId: suite.id, applicationId: suite.applicationId, projectId: suite.application.projectId };
}

/** Editable while active and not under review; submitted versions are immutable snapshots. */
async function assertSuiteEditable(client: Client, suiteId: string) {
  const suite = await client.testSuite.findUniqueOrThrow({
    where: { id: suiteId },
    select: { status: true, _count: { select: { planVersions: { where: { status: "PENDING_APPROVAL" } } } } },
  });
  if (suite.status !== "ACTIVE") throw new DomainError("Archived suites can't be changed.");
  if (suite._count.planVersions > 0) throw new DomainError("This suite is awaiting review and can't be changed.");
}

const snapshotInclude = {
  testCases: {
    where: { status: "ACTIVE", reviewState: "ACCEPTED" },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: { steps: { orderBy: { position: "asc" } }, feature: { select: { name: true } } },
  },
} satisfies Prisma.TestSuiteInclude;

/** The snapshot that submitting now would produce (accepted, active cases only). */
export async function workingSnapshot(client: Client, suiteId: string): Promise<PlanSnapshot> {
  const suite = await client.testSuite.findUniqueOrThrow({ where: { id: suiteId }, include: snapshotInclude });
  return buildPlanSnapshot(suite);
}

// ─── Suites ─────────────────────────────────────────────────────────────────

export async function createSuite(actor: Actor, input: TestSuiteInput) {
  await assertApplicationPermission(actor, input.applicationId, "suite.edit");
  return db().testSuite.create({ data: { ...input, createdById: actor.id }, select: { id: true } });
}

export async function updateSuite(actor: Actor, suiteId: string, input: { name: string; description: string | null }) {
  await suiteContext(actor, suiteId, "suite.edit");
  await assertSuiteEditable(db(), suiteId);
  await db().testSuite.update({ where: { id: suiteId }, data: input });
}

/** Suites with run history are kept for traceability: archive them instead. */
export async function deleteSuite(actor: Actor, suiteId: string) {
  await suiteContext(actor, suiteId, "suite.delete");
  const runs = await db().testRun.count({ where: { planVersion: { suiteId } } });
  if (runs > 0) throw new DomainError("This suite has test runs. Archive it instead, so its history is preserved.");
  await db().testSuite.delete({ where: { id: suiteId } });
}

export async function archiveSuite(actor: Actor, suiteId: string) {
  await suiteContext(actor, suiteId, "suite.delete");
  await db().testSuite.update({ where: { id: suiteId }, data: { status: "ARCHIVED" } });
}

// ─── Cases ──────────────────────────────────────────────────────────────────

function caseData(input: TestCaseInput) {
  return {
    title: input.title,
    expectedResult: input.expectedResult,
    priority: input.priority,
    type: input.type,
    prerequisites: input.prerequisites,
    requirementRefs: input.requirementRefs,
  };
}

function stepRows(steps: TestCaseInput["steps"]) {
  return steps.map((step, position) => ({
    position,
    action: step.action,
    expectedResult: step.expectedResult,
    kind: step.kind,
    params: (step.params ?? undefined) as Prisma.InputJsonValue | undefined,
  }));
}

export async function addCase(actor: Actor, suiteId: string, input: TestCaseInput) {
  const ctx = await suiteContext(actor, suiteId, "suite.edit");
  const created = await db().$transaction(async (tx) => {
    await assertSuiteEditable(tx, suiteId);
    const last = await tx.testCase.aggregate({ where: { suiteId }, _max: { position: true } });
    const testCase = await tx.testCase.create({
      data: {
        ...caseData(input),
        suiteId,
        reviewState: "ACCEPTED",
        position: (last._max.position ?? -1) + 1,
        createdById: actor.id,
        steps: { create: stepRows(input.steps) },
      },
      select: { id: true },
    });
    await audit({ actor, action: "case.created", entityType: "TestCase", entityId: testCase.id, projectId: ctx.projectId, data: { suiteId } }, tx);
    return testCase;
  });
  return created;
}

/** Edits a case in the working copy. Any change to approved content needs a new version. */
export async function updateCase(actor: Actor, caseId: string, input: TestCaseInput) {
  const existing = await db().testCase.findUnique({ where: { id: caseId }, select: { suiteId: true, status: true } });
  if (!existing || existing.status !== "ACTIVE") throw new NotFoundError("Test case");
  const ctx = await suiteContext(actor, existing.suiteId, "suite.edit");
  await db().$transaction(async (tx) => {
    await assertSuiteEditable(tx, existing.suiteId);
    await tx.testStep.deleteMany({ where: { testCaseId: caseId } });
    await tx.testCase.update({ where: { id: caseId }, data: { ...caseData(input), steps: { create: stepRows(input.steps) } } });
    await audit({ actor, action: "case.edited", entityType: "TestCase", entityId: caseId, projectId: ctx.projectId, data: { suiteId: existing.suiteId, title: input.title } }, tx);
  });
}

/** Accept, reject or re-open a set of cases (bulk selection in the review UI). */
export async function reviewCases(actor: Actor, suiteId: string, caseIds: string[], decision: "ACCEPTED" | "REJECTED" | "PROPOSED") {
  const ctx = await suiteContext(actor, suiteId, "suite.edit");
  return db().$transaction(async (tx) => {
    await assertSuiteEditable(tx, suiteId);
    const { count } = await tx.testCase.updateMany({ where: { id: { in: caseIds }, suiteId, status: "ACTIVE" }, data: { reviewState: decision } });
    if (count !== caseIds.length) throw new DomainError("Some selected cases don't belong to this suite.");
    await audit({ actor, action: "case.reviewed", entityType: "TestSuite", entityId: suiteId, projectId: ctx.projectId, data: { decision, caseIds } }, tx);
    return count;
  });
}

/** Archives rather than deletes, so results from earlier runs keep their link to the case. */
export async function archiveCase(actor: Actor, caseId: string) {
  const existing = await db().testCase.findUnique({ where: { id: caseId }, select: { suiteId: true } });
  if (!existing) throw new NotFoundError("Test case");
  const ctx = await suiteContext(actor, existing.suiteId, "suite.edit");
  await db().$transaction(async (tx) => {
    await assertSuiteEditable(tx, existing.suiteId);
    await tx.testCase.update({ where: { id: caseId }, data: { status: "ARCHIVED" } });
    await audit({ actor, action: "case.archived", entityType: "TestCase", entityId: caseId, projectId: ctx.projectId }, tx);
  });
}

// ─── Submission ─────────────────────────────────────────────────────────────

/**
 * Freezes the accepted cases into a new immutable PlanVersion and opens an approval request
 * bound to the version's content hash (computed by Postgres).
 */
export async function submitForApproval(actor: Actor, suiteId: string, changeSummary: string | null = null) {
  const ctx = await suiteContext(actor, suiteId, "suite.edit");
  return db().$transaction(async (tx) => {
    await assertSuiteEditable(tx, suiteId);
    const proposed = await tx.testCase.count({ where: { suiteId, status: "ACTIVE", reviewState: "PROPOSED" } });
    if (proposed > 0) throw new DomainError(`Review the ${proposed} proposed case${proposed === 1 ? "" : "s"} (accept or reject) before submitting.`);

    let snapshot: PlanSnapshot;
    try {
      snapshot = await workingSnapshot(tx, suiteId);
    } catch {
      throw new DomainError("A case has an invalid step. Fix it before submitting.");
    }
    if (snapshot.cases.length === 0) throw new DomainError("Accept at least one test case before submitting.");

    // Nothing to approve if the content matches the current approved/pending version.
    const hash = await snapshotHash(tx, snapshot);
    const latest = await tx.planVersion.findFirst({
      where: { suiteId, status: { in: ["APPROVED", "PENDING_APPROVAL"] } },
      orderBy: { version: "desc" },
      select: { version: true, contentHash: true },
    });
    if (latest?.contentHash === hash) throw new DomainError(`No changes since v${latest.version}; there's nothing new to approve.`);

    const top = await tx.planVersion.aggregate({ where: { suiteId }, _max: { version: true } });
    const version = await tx.planVersion.create({
      data: {
        suiteId,
        version: (top._max.version ?? 0) + 1,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        snapshotFormat: 2,
        caseCount: snapshot.cases.length,
        changeSummary,
        createdById: actor.id,
      },
      select: { id: true, version: true, contentHash: true },
    });
    if (version.contentHash !== hash) throw new Error("Snapshot hash mismatch"); // sanity: same function both sides
    await tx.approval.create({ data: { planVersionId: version.id, requestedById: actor.id, requestedHash: version.contentHash } });
    await audit(
      { actor, action: "plan.submitted", entityType: "PlanVersion", entityId: version.id, projectId: ctx.projectId, data: { suiteId, version: version.version, contentHash: version.contentHash, cases: snapshot.cases.length } },
      tx,
    );
    return version;
  });
}
