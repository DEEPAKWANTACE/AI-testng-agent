import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { writeArtifact } from "@/modules/artifacts/storage";
import { deriveFeatures } from "@/modules/discovery/features";
import { pageElementsSchema } from "@/modules/discovery/page-elements";
import { queueAutoGeneration } from "@/modules/auto-test/generate";
import { syncDiscoveryInventory } from "@/modules/inventory/service";
import { resolveSecret } from "@/modules/secrets/resolver";
import { crawl, CrawlError, type CrawlCredentials, type CrawlStats } from "./crawler";

const flag = z.enum(["true", "false"]).default("false").transform((value) => value === "true");
const configSchema = z.object({
  DISCOVERY_PAGE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  DISCOVERY_RUN_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(300_000),
  DISCOVERY_STALE_AFTER_MS: z.coerce.number().int().min(10_000).default(120_000),
  DISCOVERY_POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(3_000),
  DISCOVERY_ALLOW_EXTERNAL_ASSETS: flag,
});

export type WorkerConfig = {
  workerId: string;
  pageTimeoutMs: number;
  runTimeoutMs: number;
  staleAfterMs: number;
  pollIntervalMs: number;
  allowExternalAssets: boolean;
  /** Set when the process is shutting down; in-flight runs stop at the next page. */
  isStopping: () => boolean;
};

export function workerConfigFromEnv(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const env = configSchema.parse(process.env);
  return {
    workerId: `discovery-${process.pid}-${randomBytes(3).toString("hex")}`,
    pageTimeoutMs: env.DISCOVERY_PAGE_TIMEOUT_MS,
    runTimeoutMs: env.DISCOVERY_RUN_TIMEOUT_MS,
    staleAfterMs: env.DISCOVERY_STALE_AFTER_MS,
    pollIntervalMs: env.DISCOVERY_POLL_INTERVAL_MS,
    allowExternalAssets: env.DISCOVERY_ALLOW_EXTERNAL_ASSETS,
    isStopping: () => false,
    ...overrides,
  };
}

/** Fails runs whose worker stopped sending heartbeats (crash, kill -9, lost host). */
export async function recoverStaleRuns(config: WorkerConfig): Promise<number> {
  const { count } = await db().discoveryRun.updateMany({
    where: { status: "RUNNING", heartbeatAt: { lt: new Date(Date.now() - config.staleAfterMs) } },
    data: { status: "FAILED", finishedAt: new Date(), errorMessage: "The discovery worker stopped responding. Queue a new run." },
  });
  return count;
}

/** Atomically claims the oldest queued run; concurrent workers never get the same run. */
export async function claimNextRun(workerId: string): Promise<string | null> {
  const rows = await db().$queryRaw<{ id: string }[]>`
    UPDATE "DiscoveryRun"
    SET "status" = 'RUNNING', "workerId" = ${workerId},
        -- Columns are timestamp without time zone holding UTC (as Prisma writes them), so
        -- convert explicitly: plain now() would store the session's local time.
        "startedAt" = now() AT TIME ZONE 'UTC', "heartbeatAt" = now() AT TIME ZONE 'UTC', "updatedAt" = now() AT TIME ZONE 'UTC'
    WHERE "id" = (
      SELECT "id" FROM "DiscoveryRun" WHERE "status" = 'QUEUED' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING "id"`;
  return rows[0]?.id ?? null;
}

async function loadCredentials(runId: string): Promise<CrawlCredentials | undefined> {
  const run = await db().discoveryRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      application: {
        select: {
          discoveryAuth: {
            include: { usernameSecret: { select: { name: true, reference: true } }, passwordSecret: { select: { name: true, reference: true } } },
          },
        },
      },
    },
  });
  const auth = run.application.discoveryAuth;
  if (!auth || auth.mode !== "FORM_LOGIN") return undefined;
  if (!auth.loginUrl || !auth.usernameSecret || !auth.passwordSecret) {
    throw new CrawlError("Discovery login is enabled but incomplete. Set the login URL and both credential secrets.");
  }

  const resolve = async (secret: { name: string; reference: string }) => {
    try {
      return await resolveSecret(secret.reference);
    } catch (error) {
      // Resolver messages name the reference, never a value.
      throw new CrawlError(`Couldn't resolve secret ${secret.name}: ${(error as Error).message}`);
    }
  };
  return {
    loginUrl: auth.loginUrl,
    username: await resolve(auth.usernameSecret),
    password: await resolve(auth.passwordSecret),
    usernameSelector: auth.usernameSelector,
    passwordSelector: auth.passwordSelector,
    submitSelector: auth.submitSelector,
    successSelector: auth.successSelector,
  };
}

function summarize(stats: CrawlStats, featureCount: number): string {
  const stop = {
    completed: "Crawl completed",
    "max-pages": "Stopped at the page limit",
    "time-limit": "Stopped at the time limit",
    cancelled: "Stopped early",
  }[stats.stoppedBy];
  const blocked = stats.blockedRequests.length + stats.redirectsBlocked.length;
  return [
    `${stop}: ${stats.pagesVisited} page${stats.pagesVisited === 1 ? "" : "s"} visited${stats.pagesFailed ? ` (${stats.pagesFailed} failed)` : ""}`,
    `${featureCount} feature${featureCount === 1 ? "" : "s"} found`,
    stats.authenticated ? "signed in" : null,
    blocked ? `${blocked} request${blocked === 1 ? "" : "s"} blocked by the egress policy` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Runs one claimed discovery run to completion. Never throws for crawl-level failures. */
export async function processRun(runId: string, config: WorkerConfig): Promise<void> {
  const owned = { id: runId, workerId: config.workerId };
  const run = await db().discoveryRun.findUniqueOrThrow({
    where: { id: runId },
    select: { startUrl: true, maxDepth: true, maxPages: true, autoGenerate: true, application: { select: { id: true, authorizedUrl: true } } },
  });
  let pageNumber = 0;

  try {
    const credentials = await loadCredentials(runId);
    const stats = await crawl({
      authorizedUrl: run.application.authorizedUrl,
      startUrl: run.startUrl,
      maxDepth: run.maxDepth,
      maxPages: run.maxPages,
      pageTimeoutMs: config.pageTimeoutMs,
      runTimeoutMs: config.runTimeoutMs,
      allowExternalAssets: config.allowExternalAssets,
      credentials,
      shouldContinue: async () => {
        if (config.isStopping()) return false;
        const { count } = await db().discoveryRun.updateMany({
          where: { ...owned, status: "RUNNING" },
          data: { heartbeatAt: new Date() },
        });
        return count === 1;
      },
      onPage: async (page) => {
        pageNumber++;
        const saved = await db().discoveredPage.upsert({
          where: { runId_url: { runId, url: page.url } },
          create: {
            runId,
            url: page.url,
            title: page.title,
            depth: page.depth,
            statusCode: page.statusCode,
            loadTimeMs: page.loadTimeMs,
            elements: page.elements,
            error: page.error,
          },
          update: {},
          select: { id: true },
        });
        if (page.screenshot) {
          const key = `discovery/${runId}/page-${String(pageNumber).padStart(3, "0")}.png`;
          const sizeBytes = await writeArtifact(key, page.screenshot, "image/png");
          await db().artifact.create({
            data: { kind: "SCREENSHOT", name: `Screenshot of ${page.url}`.slice(0, 500), storageKey: key, mimeType: "image/png", sizeBytes, discoveredPageId: saved.id },
          });
        }
        await db().discoveryRun.updateMany({ where: owned, data: { pagesVisited: { increment: 1 }, heartbeatAt: new Date() } });
      },
    });

    const featureCount = await saveFeatures(runId, run.application.id, run.application.authorizedUrl);

    const logKey = `discovery/${runId}/crawl-log.json`;
    const logSize = await writeArtifact(logKey, JSON.stringify({ runId, finishedAt: new Date().toISOString(), ...stats }, null, 2), "application/json");
    await db().artifact.create({
      data: { kind: "LOG", name: "Crawl log (blocked requests, skipped links, limits)", storageKey: logKey, mimeType: "application/json", sizeBytes: logSize, discoveryRunId: runId },
    });

    const statsJson = {
      ...stats,
      blockedRequests: stats.blockedRequests.slice(0, 100),
      redirectsBlocked: stats.redirectsBlocked.slice(0, 100),
    } as unknown as Prisma.InputJsonValue;

    if (config.isStopping()) {
      await db().discoveryRun.updateMany({
        where: { ...owned, status: "RUNNING" },
        data: { status: "FAILED", finishedAt: new Date(), stats: statsJson, errorMessage: "The worker shut down before the run finished. Partial results were kept." },
      });
      return;
    }
    // A run cancelled from the UI stays CANCELLED; otherwise it completed.
    await db().discoveryRun.updateMany({
      where: { ...owned, status: "RUNNING" },
      data: { status: "COMPLETED", finishedAt: new Date(), stats: statsJson, summary: summarize(stats, featureCount) },
    });
    // Discovered pages become ROUTE items of the application's inventory (best effort).
    await syncDiscoveryInventory(run.application.id).catch((error) => console.error(`[discovery] inventory sync for ${runId} failed`, error));
    const completed = run.autoGenerate && (await db().discoveryRun.findUnique({ where: { id: runId }, select: { status: true } }))?.status === "COMPLETED";
    if (completed) {
      const auto = await queueAutoGeneration(runId).catch((error) => ({ jobs: 0, features: 0, error: String(error?.message ?? error) }));
      const note = auto.error ? `Auto-generation not fully queued: ${auto.error}` : `Auto-generation queued: ${auto.jobs} job${auto.jobs === 1 ? "" : "s"} for ${auto.features} feature${auto.features === 1 ? "" : "s"}`;
      const done = await db().discoveryRun.findUnique({ where: { id: runId }, select: { summary: true } });
      await db().discoveryRun.update({ where: { id: runId }, data: { summary: [done?.summary, note].filter(Boolean).join(" · ") } });
    }
    await db().discoveryRun.updateMany({ where: { ...owned, status: "CANCELLED", finishedAt: null }, data: { finishedAt: new Date(), stats: statsJson } });
  } catch (error) {
    const expected = error instanceof CrawlError;
    if (!expected) console.error(`[discovery] run ${runId} failed`, error);
    await db().discoveryRun.updateMany({
      where: { ...owned, status: "RUNNING" },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: expected ? (error as Error).message : "Discovery failed unexpectedly. Check the worker logs.",
      },
    });
  }
}

/** Turns the run's pages into Feature records and links each page to its feature. */
async function saveFeatures(runId: string, applicationId: string, authorizedUrl: string): Promise<number> {
  const pages = await db().discoveredPage.findMany({ where: { runId, error: null }, select: { id: true, url: true, title: true, elements: true } });
  const derived = deriveFeatures(
    pages.map((page) => ({ url: page.url, title: page.title, elements: pageElementsSchema.parse(page.elements) })),
    authorizedUrl,
  );

  for (const feature of derived) {
    const existing = await db().feature.findUnique({
      where: { applicationId_name: { applicationId, name: feature.name } },
      select: { id: true, source: true },
    });
    // Don't overwrite features people wrote by hand; just link the pages to them.
    const saved =
      existing && existing.source !== "DISCOVERED"
        ? existing
        : await db().feature.upsert({
            where: { applicationId_name: { applicationId, name: feature.name } },
            create: { applicationId, name: feature.name, url: feature.url, description: feature.description, source: "DISCOVERED", discoveryRunId: runId },
            update: { url: feature.url, description: feature.description, discoveryRunId: runId, status: "ACTIVE" },
            select: { id: true, source: true },
          });
    await db().discoveredPage.updateMany({ where: { runId, url: { in: feature.pageUrls } }, data: { featureId: saved.id } });
  }
  return derived.length;
}

/** Claims and processes one queued run. Returns its id, or null if the queue was empty. */
export async function processNextRun(config: WorkerConfig): Promise<string | null> {
  const runId = await claimNextRun(config.workerId);
  if (runId) await processRun(runId, config);
  return runId;
}
