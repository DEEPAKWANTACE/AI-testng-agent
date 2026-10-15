import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { decideApproval } from "@/modules/approvals/service";
import { verifyAuditChain } from "@/modules/audit/audit";
import type { Actor } from "@/modules/auth/service";
import { HeuristicProvider } from "@/modules/generation/providers";
import { processGeneration } from "@/modules/generation/service";
import { queueRun } from "@/modules/execution/runs";
import { reviewCases, submitForApproval, updateCase, workingSnapshot } from "@/modules/test-suites/service";
import { snapshotHash } from "@/modules/test-suites/snapshot";
import { closeQueues } from "@/modules/jobs/queues";
import { createProject, createUser, resetDatabase } from "../helpers/fixtures";
import { approve, createSuiteWithCases } from "../helpers/plans";
import { afterAll } from "vitest";

let engineer: Actor, lead: Actor, otherLead: Actor, viewerLead: Actor;
let applicationId: string;

const NAV = (url: string) => ({ kind: "NAVIGATE" as const, description: `Open ${url}`, params: { url } });
const SEE = (name: string) => ({ kind: "ASSERT" as const, description: `See ${name}`, params: { check: "visible" as const, target: { by: "role" as const, role: "heading" as const, name } } });

beforeEach(async () => {
  await resetDatabase();
  [engineer, lead, otherLead, viewerLead] = await Promise.all([createUser("QA_ENGINEER"), createUser("QA_LEAD"), createUser("QA_LEAD"), createUser("QA_LEAD")]);
  const project = await createProject([[engineer, "EDITOR"], [lead, "EDITOR"], [otherLead, "EDITOR"], [viewerLead, "VIEWER"]]);
  const app = await db().application.create({ data: { projectId: project.id, name: "Shop", authorizedUrl: "https://shop.example.com", environment: "STAGING" } });
  applicationId = app.id;
});

afterAll(closeQueues);

describe("generation → review", () => {
  it("saves generated cases as PROPOSED drafts and blocks submission until every case is reviewed", async () => {
    const feature = await db().feature.create({ data: { applicationId, name: "Products", url: "https://shop.example.com/products", source: "DISCOVERED" } });
    const run = await db().discoveryRun.create({ data: { applicationId, startUrl: "https://shop.example.com", status: "COMPLETED" } });
    await db().discoveredPage.create({
      data: {
        runId: run.id,
        featureId: feature.id,
        url: "https://shop.example.com/products",
        title: "Products",
        depth: 1,
        elements: { headings: ["Products"], links: [], navigation: [], buttons: [], inputs: [], forms: [{ name: "Filter", action: "https://shop.example.com/products", method: "GET", fields: [{ tag: "input", type: "text", name: "q", label: "Filter", placeholder: null, required: false }], submitLabels: ["Go"] }] },
      },
    });
    const job = await db().generationJob.create({ data: { applicationId, featureIds: [feature.id], requirements: "Users can filter products", requestedById: engineer.id } });

    await processGeneration(job.id, new HeuristicProvider());
    const done = await db().generationJob.findUniqueOrThrow({ where: { id: job.id }, include: { testCases: { include: { steps: true } } } });
    expect(done).toMatchObject({ status: "SUCCEEDED", provider: "heuristic", rejectedCount: 0 });
    expect(done.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(done.testCases.length).toBeGreaterThanOrEqual(4);
    expect(done.testCases.every((c) => c.reviewState === "PROPOSED" && c.source === "AI_GENERATED" && c.featureId === feature.id)).toBe(true);
    expect(done.testCases.every((c) => c.steps.every((s) => s.kind !== null))).toBe(true);

    const suiteId = done.suiteId!;
    await expect(submitForApproval(engineer, suiteId)).rejects.toThrow(/Review the \d+ proposed cases/);

    const [keep, ...rest] = done.testCases;
    await reviewCases(engineer, suiteId, [keep.id], "ACCEPTED");
    await reviewCases(engineer, suiteId, rest.map((c) => c.id), "REJECTED");
    const version = await submitForApproval(engineer, suiteId);
    expect(version.version).toBe(1);
    const stored = await db().planVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(stored.caseCount).toBe(1); // only accepted cases are frozen
  });
});

describe("hash-bound approval", () => {
  async function submitted() {
    const suite = await createSuiteWithCases(applicationId, [{ title: "Home loads", steps: [NAV("/"), SEE("Welcome")] }]);
    const version = await submitForApproval(engineer, suite.id);
    const approval = await db().approval.findFirstOrThrow({ where: { planVersionId: version.id } });
    return { suite, version, approval };
  }

  it("stores a Postgres-computed hash of the exact snapshot", async () => {
    const { suite, version, approval } = await submitted();
    expect(version.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(approval.requestedHash).toBe(version.contentHash);
    const recomputed = await snapshotHash(db(), await workingSnapshot(db(), suite.id));
    expect(recomputed).toBe(version.contentHash);
  });

  it("binds the decision to the hash and the authorized reviewer", async () => {
    const { version, approval } = await submitted();
    const decide = (actor: Actor, expectedHash = version.contentHash) => decideApproval(actor, approval.id, { decision: "APPROVED", comment: null, expectedHash });

    await expect(decide(engineer)).rejects.toThrow(); // QA engineers can't review
    await expect(decide(viewerLead)).rejects.toThrow("permission"); // project viewer
    await expect(decide(lead, "0".repeat(64))).rejects.toThrow("doesn't match what you reviewed");

    await decide(lead);
    const decided = await db().approval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(decided).toMatchObject({ status: "APPROVED", reviewerId: lead.id, decidedHash: version.contentHash, reviewerRole: "QA_LEAD", reviewerProjectRole: "EDITOR" });
    await expect(decide(otherLead)).rejects.toThrow("already been decided");
  });

  it("refuses self-approval", async () => {
    const suite = await createSuiteWithCases(applicationId, [{ title: "Home loads", steps: [NAV("/")] }]);
    const version = await submitForApproval(lead, suite.id);
    const approval = await db().approval.findFirstOrThrow({ where: { planVersionId: version.id } });
    await expect(decideApproval(lead, approval.id, { decision: "APPROVED", comment: null, expectedHash: version.contentHash })).rejects.toThrow("your own submission");
  });

  it("requires a new approved version after any material change", async () => {
    const suite = await createSuiteWithCases(applicationId, [{ title: "Home loads", steps: [NAV("/"), SEE("Welcome")] }]);
    const v1 = await approve(suite.id, engineer, lead);
    await expect(submitForApproval(engineer, suite.id)).rejects.toThrow("No changes since v1");

    const testCase = await db().testCase.findFirstOrThrow({ where: { suiteId: suite.id } });
    await updateCase(engineer, testCase.id, {
      title: "Home loads",
      expectedResult: "Home works",
      priority: "HIGH", // material change
      type: "FUNCTIONAL",
      prerequisites: [],
      requirementRefs: [],
      steps: [
        { action: "Open /", expectedResult: null, kind: "NAVIGATE", params: { url: "/" } },
        { action: "See Welcome", expectedResult: null, kind: "ASSERT", params: { check: "visible", target: { by: "role", role: "heading", name: "Welcome" } } },
      ],
    });
    const working = await snapshotHash(db(), await workingSnapshot(db(), suite.id));
    expect(working).not.toBe(v1.contentHash);

    // v1 still runs (unchanged approved content); v2 must be approved before it can.
    const v2 = await submitForApproval(engineer, suite.id);
    expect(v2.contentHash).toBe(working);
    await expect(queueRun(engineer, v2.id)).rejects.toThrow("Only the current approved version");
    expect((await db().planVersion.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe("APPROVED");

    const approval = await db().approval.findFirstOrThrow({ where: { planVersionId: v2.id } });
    await decideApproval(lead, approval.id, { decision: "APPROVED", comment: null, expectedHash: v2.contentHash });
    expect((await db().planVersion.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe("SUPERSEDED");
  });

  it("locks the suite while a version awaits review", async () => {
    const { suite } = await submitted();
    const testCase = await db().testCase.findFirstOrThrow({ where: { suiteId: suite.id } });
    await expect(reviewCases(engineer, suite.id, [testCase.id], "REJECTED")).rejects.toThrow("awaiting review");
  });
});

describe("database-level immutability", () => {
  it("rejects changes to a submitted snapshot and its hash", async () => {
    const suite = await createSuiteWithCases(applicationId, [{ title: "Home loads", steps: [NAV("/")] }]);
    const version = await submitForApproval(engineer, suite.id);
    await expect(db().$executeRaw`UPDATE "PlanVersion" SET "snapshot" = '{"format":2,"cases":[]}'::jsonb WHERE "id" = ${version.id}`).rejects.toThrow(/immutable/);
    await expect(db().$executeRaw`UPDATE "PlanVersion" SET "contentHash" = 'x' WHERE "id" = ${version.id}`).rejects.toThrow(/generated column|can only be updated to DEFAULT/i);
    // Status transitions are still allowed.
    await db().planVersion.update({ where: { id: version.id }, data: { status: "REJECTED" } });
  });

  it("rejects changes to a decided approval", async () => {
    const suite = await createSuiteWithCases(applicationId, [{ title: "Home loads", steps: [NAV("/")] }]);
    const version = await approve(suite.id, engineer, lead);
    const approval = await db().approval.findFirstOrThrow({ where: { planVersionId: version.id } });
    await expect(db().approval.update({ where: { id: approval.id }, data: { decidedHash: "f".repeat(64) } })).rejects.toThrow(/immutable/);
    await expect(db().approval.update({ where: { id: approval.id }, data: { reviewerId: otherLead.id } })).rejects.toThrow(/immutable/);
  });

  it("keeps an append-only, verifiable audit chain", async () => {
    const suite = await createSuiteWithCases(applicationId, [{ title: "Home loads", steps: [NAV("/")] }]);
    await approve(suite.id, engineer, lead);
    const entries = await db().auditLog.findMany({ orderBy: { id: "asc" } });
    expect(entries.map((e) => e.action)).toEqual(["plan.submitted", "plan.approved"]);
    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(await verifyAuditChain()).toEqual({ ok: true, entries: 2 });

    await expect(db().auditLog.update({ where: { id: entries[0].id }, data: { action: "plan.rejected" } })).rejects.toThrow(/append-only/);
    await expect(db().auditLog.delete({ where: { id: entries[0].id } })).rejects.toThrow(/append-only/);

    // Simulated tampering by someone who bypasses the trigger is detected.
    await db().$executeRawUnsafe(`ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_append_only"`);
    try {
      await db().$executeRaw`UPDATE "AuditLog" SET "actorEmail" = 'someone@else', "data" = '{"comment":"changed"}'::jsonb WHERE "id" = ${entries[1].id}`;
    } finally {
      await db().$executeRawUnsafe(`ALTER TABLE "AuditLog" ENABLE TRIGGER "AuditLog_append_only"`);
    }
    expect(await verifyAuditChain()).toEqual({ ok: false, brokenAt: entries[1].id.toString() });
  });
});
