import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/modules/audit/audit";
import { analyzeSourceFiles } from "@/modules/inventory/source";
import { mergeInventory } from "@/modules/inventory/service";
import { resolveSecret } from "@/modules/secrets/resolver";
import { cloneRepository, readSourceTree, RepoError, DEFAULT_REPO_LIMITS, type RepoLimits } from "./repo";

/**
 * Source analysis jobs, polled from the database (no queue needed): claim one QUEUED analysis,
 * fetch the repository, read it as text, merge the findings, clean up.
 */

const STALE_AFTER_MS = 15 * 60_000;

export async function claimNextAnalysis(workerId: string): Promise<string | null> {
  const rows = await db().$queryRaw<{ id: string }[]>`
    UPDATE "SourceAnalysis" SET "status" = 'RUNNING', "workerId" = ${workerId}, "startedAt" = now() AT TIME ZONE 'UTC'
    WHERE "id" = (SELECT "id" FROM "SourceAnalysis" WHERE "status" = 'QUEUED' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING "id"`;
  return rows[0]?.id ?? null;
}

/** Analyses left RUNNING by a worker that died are failed (they can simply be requested again). */
export async function recoverStaleAnalyses(): Promise<number> {
  const { count } = await db().sourceAnalysis.updateMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
    data: { status: "FAILED", errorMessage: "The worker stopped before the analysis finished.", finishedAt: new Date() },
  });
  return count;
}

export async function processNextAnalysis(workerId: string, limits: RepoLimits = DEFAULT_REPO_LIMITS): Promise<string | null> {
  const id = await claimNextAnalysis(workerId);
  if (!id) return null;
  const analysis = await db().sourceAnalysis.findUniqueOrThrow({
    where: { id },
    select: { applicationId: true, repoUrl: true, repoBranch: true, tokenSecret: true, application: { select: { projectId: true, secrets: { select: { name: true, reference: true } } } } },
  });
  const fail = async (message: string) => {
    await db().sourceAnalysis.update({ where: { id }, data: { status: "FAILED", errorMessage: message.slice(0, 1000), finishedAt: new Date() } });
    await audit({ actor: null, action: "inventory.analysis.finished", entityType: "SourceAnalysis", entityId: id, projectId: analysis.application.projectId, data: { status: "FAILED", error: message.slice(0, 300) } });
  };

  let token: string | null = null;
  if (analysis.tokenSecret) {
    const ref = analysis.application.secrets.find((s) => s.name === analysis.tokenSecret)?.reference;
    try {
      token = ref ? await resolveSecret(ref) : null;
    } catch {
      token = null;
    }
    if (!token) {
      await fail(`The access token secret ${analysis.tokenSecret} couldn't be resolved.`);
      return id;
    }
  }

  let repo: Awaited<ReturnType<typeof cloneRepository>> | undefined;
  try {
    repo = await cloneRepository(analysis.repoUrl, analysis.repoBranch, token, limits);
    const tree = await readSourceTree(repo.dir, limits);
    const items = analyzeSourceFiles(tree.files);
    const counts = await mergeInventory(analysis.applicationId, "SOURCE_CODE", "SOURCE_CODE", items, { analysisId: id });
    const byKind: Record<string, number> = {};
    for (const item of items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    const stats = { files: tree.files.length, bytes: tree.bytes, skipped: tree.skipped, truncated: tree.truncated, items: byKind, ...counts };
    await db().sourceAnalysis.update({ where: { id }, data: { status: "SUCCEEDED", commitSha: repo.commitSha, stats: stats as Prisma.InputJsonValue, finishedAt: new Date() } });
    await audit({ actor: null, action: "inventory.analysis.finished", entityType: "SourceAnalysis", entityId: id, projectId: analysis.application.projectId, data: { status: "SUCCEEDED", commitSha: repo.commitSha, ...counts } });
  } catch (error) {
    if (!(error instanceof RepoError)) console.error(`[analysis] ${id} failed`, error);
    await fail(error instanceof RepoError ? error.message : "Analysis failed unexpectedly. Check the worker logs.");
  } finally {
    await repo?.cleanup();
  }
  return id;
}
