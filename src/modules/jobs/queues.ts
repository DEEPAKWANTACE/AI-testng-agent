import { Queue, type JobsOptions } from "bullmq";
import IORedis, { type RedisOptions } from "ioredis";
import { z } from "zod";

/**
 * BullMQ queues on Redis. Job ids are derived from database ids, so enqueueing the same run
 * twice is a no-op; the worker's database claim is the second line of defence against
 * duplicate execution.
 */

const envSchema = z.object({
  REDIS_URL: z.string().regex(/^rediss?:\/\//).default("redis://127.0.0.1:6379"),
  QUEUE_PREFIX: z.string().regex(/^[a-z0-9_-]{1,30}$/).default("qa"),
});

export const QUEUE_NAMES = { runs: "test-runs", generation: "test-generation" } as const;

export class QueueUnavailableError extends Error {
  constructor() {
    super("The job queue is unavailable. Check that Redis is running.");
  }
}

export function queueConfig() {
  return envSchema.parse(process.env);
}

/** Connection for producers (the web app): fails fast instead of queueing commands offline. */
export function producerConnection(): IORedis {
  const { REDIS_URL } = queueConfig();
  const options: RedisOptions = { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000, lazyConnect: true, retryStrategy: () => null };
  return new IORedis(REDIS_URL, options);
}

/** Connection for workers: BullMQ requires maxRetriesPerRequest = null for blocking commands. */
export function workerConnection(): IORedis {
  const { REDIS_URL } = queueConfig();
  return new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
}

type Queues = { runs: Queue; generation: Queue; connection: IORedis };
const globalForQueues = globalThis as unknown as { qaQueues?: Queues };

async function queues(): Promise<Queues> {
  if (globalForQueues.qaQueues && globalForQueues.qaQueues.connection.status === "ready") return globalForQueues.qaQueues;
  await globalForQueues.qaQueues?.connection.quit().catch(() => {});
  const { QUEUE_PREFIX } = queueConfig();
  const connection = producerConnection();
  try {
    await connection.connect();
  } catch {
    connection.disconnect();
    throw new QueueUnavailableError();
  }
  connection.on("error", () => {}); // surfaced via QueueUnavailableError on use
  globalForQueues.qaQueues = {
    connection,
    runs: new Queue(QUEUE_NAMES.runs, { connection, prefix: QUEUE_PREFIX }),
    generation: new Queue(QUEUE_NAMES.generation, { connection, prefix: QUEUE_PREFIX }),
  };
  return globalForQueues.qaQueues;
}

async function withTimeout<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QueueUnavailableError()), ms);
      }),
    ]);
  } catch (error) {
    throw error instanceof QueueUnavailableError ? error : new QueueUnavailableError();
  } finally {
    clearTimeout(timer);
  }
}

export const runJobId = (runId: string) => `run-${runId}`;
export const generationJobId = (jobId: string) => `gen-${jobId}`;

export function runJobOptions(runId: string, attempts: number): JobsOptions {
  return {
    jobId: runJobId(runId),
    attempts,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
    removeOnFail: { age: 30 * 24 * 3600 },
  };
}

export async function enqueueTestRun(runId: string, attempts: number): Promise<void> {
  const q = await queues();
  await withTimeout(q.runs.add("execute", { runId }, runJobOptions(runId, attempts)));
}

export async function enqueueGeneration(jobId: string): Promise<void> {
  const q = await queues();
  await withTimeout(
    q.generation.add("generate", { jobId }, { jobId: generationJobId(jobId), attempts: 3, backoff: { type: "exponential", delay: 10_000 }, removeOnComplete: { age: 7 * 24 * 3600 }, removeOnFail: { age: 30 * 24 * 3600 } }),
  );
}

/**
 * Re-enqueues a run (worker recovery). A finished job with the same id would make add() a
 * no-op, so it's removed first; an active or waiting job is left alone.
 */
export async function requeueTestRun(runId: string, attempts: number): Promise<"enqueued" | "already-queued"> {
  const q = await queues();
  const existing = await withTimeout(q.runs.getJob(runJobId(runId)));
  if (existing) {
    const state = await existing.getState();
    if (["waiting", "delayed", "prioritized", "active", "waiting-children"].includes(state)) return "already-queued";
    await existing.remove();
  }
  await withTimeout(q.runs.add("execute", { runId }, runJobOptions(runId, attempts)));
  return "enqueued";
}

/** Removes a not-yet-started run job (cancellation). Running jobs stop via the database flag. */
export async function removeWaitingRunJob(runId: string): Promise<void> {
  try {
    const q = await queues();
    const job = await withTimeout(q.runs.getJob(runJobId(runId)));
    if (job && ["waiting", "delayed", "prioritized"].includes(await job.getState())) await job.remove();
  } catch {
    // Best effort: the worker also refuses runs that are no longer QUEUED.
  }
}

/** For tests and shutdown. */
export async function closeQueues(): Promise<void> {
  const q = globalForQueues.qaQueues;
  globalForQueues.qaQueues = undefined;
  if (!q) return;
  await Promise.allSettled([q.runs.close(), q.generation.close()]);
  await q.connection.quit().catch(() => q.connection.disconnect());
}
