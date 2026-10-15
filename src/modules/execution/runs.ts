import "server-only";
import type { TestRunTrigger } from "@/generated/prisma/enums";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import { assertApplicationPermission, NotFoundError } from "@/modules/access/service";
import { audit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/auth/service";
import { enqueueTestRun, QueueUnavailableError, removeWaitingRunJob } from "@/modules/jobs/queues";

/**
 * Queues an approved plan version for execution. The worker re-verifies everything before it
 * runs; this check just gives the user immediate feedback.
 */
export async function queueRun(actor: Actor, planVersionId: string, trigger: TestRunTrigger = "MANUAL") {
  const version = await db().planVersion.findUnique({
    where: { id: planVersionId },
    select: {
      status: true,
      contentHash: true,
      caseCount: true,
      snapshotFormat: true,
      suite: { select: { status: true, applicationId: true, application: { select: { authorizedUrl: true, environment: true, projectId: true } } } },
    },
  });
  if (!version) throw new NotFoundError("Plan version");
  await assertApplicationPermission(actor, version.suite.applicationId, "run.manage");
  if (version.status !== "APPROVED") throw new DomainError("Only the current approved version of a plan can be run.");
  if (version.suite.status !== "ACTIVE") throw new DomainError("Archived suites can't be run.");
  if (version.snapshotFormat !== 2) throw new DomainError("This version predates executable steps. Submit a new version to run it.");

  const { application } = version.suite;
  const run = await db().testRun.create({
    data: {
      planVersionId,
      trigger,
      baseUrl: application.authorizedUrl,
      environment: application.environment,
      contentHash: version.contentHash,
      progressTotal: version.caseCount,
      triggeredById: actor.id,
    },
    select: { id: true, maxAttempts: true },
  });
  await audit({ actor, action: "run.queued", entityType: "TestRun", entityId: run.id, projectId: application.projectId, data: { planVersionId, contentHash: version.contentHash, environment: application.environment } });

  try {
    await enqueueTestRun(run.id, run.maxAttempts);
  } catch (error) {
    const message = error instanceof QueueUnavailableError ? error.message : "Couldn't queue the run.";
    await db().testRun.update({ where: { id: run.id }, data: { status: "ERROR", errorMessage: message, finishedAt: new Date() } });
    throw new DomainError(`${message} The run was not started.`);
  }
  return run;
}

/** Queued runs are removed from the queue; running runs stop after the current step. */
export async function cancelRun(actor: Actor, runId: string) {
  const run = await db().testRun.findUnique({
    where: { id: runId },
    select: { status: true, planVersion: { select: { suite: { select: { applicationId: true, application: { select: { projectId: true } } } } } } },
  });
  if (!run) throw new NotFoundError("Test run");
  await assertApplicationPermission(actor, run.planVersion.suite.applicationId, "run.manage");

  const queued = await db().testRun.updateMany({ where: { id: runId, status: "QUEUED" }, data: { status: "CANCELLED", finishedAt: new Date() } });
  const running = await db().testRun.updateMany({ where: { id: runId, status: "RUNNING" }, data: { status: "CANCELLED" } });
  if (queued.count + running.count === 0) throw new DomainError("Only queued or running test runs can be cancelled.");
  if (queued.count) await removeWaitingRunJob(runId);
  await audit({ actor, action: "run.cancelled", entityType: "TestRun", entityId: runId, projectId: run.planVersion.suite.application.projectId, data: { wasRunning: running.count > 0 } });
}
