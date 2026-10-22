/**
 * Discovery worker process. Runs separately from the web app:
 *
 *   npm run worker:discovery          # poll for queued runs until stopped
 *   npm run worker:discovery -- --once  # process at most one run, then exit
 */
import "dotenv/config";
import { db } from "@/lib/db";
import { processNextAnalysis, recoverStaleAnalyses } from "@/worker/analysis/worker";
import { processNextMutationRun, recoverStaleMutationRuns } from "@/worker/mutation/worker";
import { processNextRun, recoverStaleRuns, workerConfigFromEnv } from "./worker";

let stopping = false;
const config = workerConfigFromEnv({ isStopping: () => stopping });
const once = process.argv.includes("--once");
const log = (message: string) => console.log(`[${new Date().toISOString()}] [${config.workerId}] ${message}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    log(`${signal} received; finishing the current page, then stopping.`);
  });
}

async function main() {
  log(`started (page timeout ${config.pageTimeoutMs}ms, run timeout ${config.runTimeoutMs}ms, external assets ${config.allowExternalAssets ? "allowed" : "blocked"})`);
  const recovered = await recoverStaleRuns(config);
  if (recovered) log(`marked ${recovered} stale run(s) as failed`);
  const staleAnalyses = await recoverStaleAnalyses();
  if (staleAnalyses) log(`marked ${staleAnalyses} stale source analysis(es) as failed`);
  const staleMutations = await recoverStaleMutationRuns();
  if (staleMutations) log(`marked ${staleMutations} stale mutation analysis(es) as failed`);

  let failures = 0;
  while (!stopping) {
    let runId: string | null;
    try {
      runId = await processNextRun(config);
      if (runId) {
        const run = await db().discoveryRun.findUnique({ where: { id: runId }, select: { status: true, summary: true, errorMessage: true } });
        log(`run ${runId}: ${run?.status} — ${run?.summary ?? run?.errorMessage ?? ""}`);
      } else {
        // No crawl waiting: static source analysis jobs share this worker.
        runId = await processNextAnalysis(config.workerId);
        if (runId) {
          const analysis = await db().sourceAnalysis.findUnique({ where: { id: runId }, select: { status: true, errorMessage: true, commitSha: true } });
          log(`source analysis ${runId}: ${analysis?.status}${analysis?.commitSha ? ` @ ${analysis.commitSha.slice(0, 12)}` : ""}${analysis?.errorMessage ? ` — ${analysis.errorMessage}` : ""}`);
        } else {
          runId = await processNextMutationRun(config.workerId);
          if (runId) {
            const m = await db().mutationRun.findUnique({ where: { id: runId }, select: { status: true, killed: true, survived: true, unclear: true, score: true, blockedReason: true, errorMessage: true } });
            log(`mutation analysis ${runId}: ${m?.status}${m?.score !== null && m?.score !== undefined ? ` score ${m.score} (${m.killed} killed, ${m.survived} survived, ${m.unclear} unclear)` : ""}${m?.blockedReason ?? m?.errorMessage ? ` — ${m?.blockedReason ?? m?.errorMessage}` : ""}`);
          }
        }
      }
      failures = 0;
    } catch (error) {
      // Transient infrastructure errors (database socket timeouts, pooler restarts) must not
      // kill the worker; a run claimed before the error is reclaimed by stale-run recovery.
      if (once) throw error;
      failures += 1;
      const delay = Math.min(config.pollIntervalMs * 2 ** failures, 60_000);
      log(`poll failed (${failures} in a row), retrying in ${delay}ms: ${error instanceof Error ? error.message.split("\n").at(-1) : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    if (runId) {
      if (once) break;
      continue;
    }
    if (once) {
      log("no queued runs");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
  await db().$disconnect();
  log("stopped");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
