/**
 * Discovery worker process. Runs separately from the web app:
 *
 *   npm run worker:discovery          # poll for queued runs until stopped
 *   npm run worker:discovery -- --once  # process at most one run, then exit
 */
import "dotenv/config";
import { db } from "@/lib/db";
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

  while (!stopping) {
    const runId = await processNextRun(config);
    if (runId) {
      const run = await db().discoveryRun.findUnique({ where: { id: runId }, select: { status: true, summary: true, errorMessage: true } });
      log(`run ${runId}: ${run?.status} — ${run?.summary ?? run?.errorMessage ?? ""}`);
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
