/**
 * Job worker process (BullMQ on Redis): executes approved test runs and generation jobs.
 *
 *   docker compose up -d redis
 *   npm run worker:jobs
 *
 * Isolated from the web app: it shares only the database and Redis. Generated content is
 * treated as data — test steps are executed through a fixed set of Playwright actions.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { UnrecoverableError, Worker } from "bullmq";
import { db } from "@/lib/db";
import { processGeneration } from "@/modules/generation/service";
import { QUEUE_NAMES, queueConfig, workerConnection, closeQueues } from "@/modules/jobs/queues";
import { processRun, runnerConfigFromEnv } from "@/worker/execution/runner";
import { InfrastructureError } from "@/worker/execution/executor";
import { recoverRuns } from "./recovery";

const workerId = `jobs-${process.pid}-${randomBytes(3).toString("hex")}`;
const config = runnerConfigFromEnv(workerId);
const { QUEUE_PREFIX } = queueConfig();
const log = (message: string) => console.log(`[${new Date().toISOString()}] [${workerId}] ${message}`);

const runs = new Worker(
  QUEUE_NAMES.runs,
  async (job) => {
    const runId = String(job.data.runId);
    try {
      const outcome = await processRun(runId, config, { onProgress: (done, total) => job.updateProgress({ done, total }) });
      log(`run ${runId}: ${outcome}`);
      return outcome;
    } catch (error) {
      if (error instanceof InfrastructureError) log(`run ${runId}: infrastructure failure, will retry (${error.message})`);
      else if (error instanceof UnrecoverableError) log(`run ${runId}: giving up (${error.message})`);
      throw error;
    }
  },
  {
    connection: workerConnection(),
    prefix: QUEUE_PREFIX,
    concurrency: Number(process.env.EXECUTION_CONCURRENCY ?? 2),
    lockDuration: 60_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  },
);

const generation = new Worker(
  QUEUE_NAMES.generation,
  async (job) => {
    await processGeneration(String(job.data.jobId), undefined, job.attemptsMade + 1, job.opts.attempts ?? 3);
    log(`generation ${job.data.jobId}: done`);
  },
  { connection: workerConnection(), prefix: QUEUE_PREFIX, concurrency: 1, lockDuration: 300_000 },
);

for (const worker of [runs, generation]) worker.on("error", (error) => log(`worker error: ${error.message}`));

async function reconcile() {
  try {
    const result = await recoverRuns({ staleAfterMs: config.staleAfterMs });
    if (result.requeued || result.failed || result.reenqueued) log(`recovery: ${JSON.stringify(result)}`);
  } catch (error) {
    log(`recovery failed: ${(error as Error).message}`);
  }
}
void reconcile();
const recovery = setInterval(reconcile, 60_000);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log(`${signal}: finishing active jobs, then stopping`);
    clearInterval(recovery);
    await Promise.all([runs.close(), generation.close()]);
    await closeQueues();
    await db().$disconnect();
    process.exit(0);
  });
}

log(`started (concurrency ${runs.opts.concurrency}, step timeout ${config.stepTimeoutMs}ms, run timeout ${config.runTimeoutMs}ms)`);
