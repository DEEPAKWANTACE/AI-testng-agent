import { db } from "@/lib/db";
import { requeueTestRun } from "@/modules/jobs/queues";
import { audit } from "@/modules/audit/audit";

/**
 * Worker recovery. Runs whose worker died (stale heartbeat) are re-queued while they have
 * attempts left, otherwise marked ERROR; QUEUED runs whose job vanished from Redis (e.g. after
 * a Redis restart without persistence) are re-enqueued. Safe to run concurrently: the
 * worker's database claim prevents duplicate execution.
 */
export async function recoverRuns(options: { staleAfterMs: number; orphanAfterMs?: number }) {
  const now = Date.now();
  const stale = await db().testRun.findMany({
    where: { status: "RUNNING", heartbeatAt: { lt: new Date(now - options.staleAfterMs) } },
    select: { id: true, attempts: true, maxAttempts: true, planVersion: { select: { suite: { select: { application: { select: { projectId: true } } } } } } },
  });
  let requeued = 0;
  let failed = 0;
  for (const run of stale) {
    const projectId = run.planVersion.suite.application.projectId;
    if (run.attempts < run.maxAttempts) {
      const { count } = await db().testRun.updateMany({
        where: { id: run.id, status: "RUNNING", heartbeatAt: { lt: new Date(now - options.staleAfterMs) } },
        data: { status: "QUEUED", workerId: null, errorMessage: "The worker stopped responding; the run was re-queued." },
      });
      if (count) {
        await requeueTestRun(run.id, run.maxAttempts - run.attempts);
        await audit({ actor: null, action: "run.retry", entityType: "TestRun", entityId: run.id, projectId, data: { reason: "stale heartbeat", attempt: run.attempts } });
        requeued++;
      }
    } else {
      const { count } = await db().testRun.updateMany({
        where: { id: run.id, status: "RUNNING" },
        data: { status: "ERROR", errorMessage: `The worker stopped responding after ${run.attempts} attempts.`, finishedAt: new Date() },
      });
      failed += count;
    }
  }

  // QUEUED runs whose job is missing from Redis.
  const orphans = await db().testRun.findMany({
    where: { status: "QUEUED", updatedAt: { lt: new Date(now - (options.orphanAfterMs ?? 60_000)) } },
    select: { id: true, attempts: true, maxAttempts: true },
  });
  let reenqueued = 0;
  for (const run of orphans) {
    if ((await requeueTestRun(run.id, Math.max(1, run.maxAttempts - run.attempts))) === "enqueued") reenqueued++;
  }
  return { requeued, failed, reenqueued };
}
