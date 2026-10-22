/**
 * Accuracy benchmark (bundled Demo Shop corpus with seeded faults):
 *
 *   npm run benchmark                         # all faults, 3 clean runs
 *   npm run benchmark -- --repeats 5 --mutation
 *   npm run benchmark -- --faults wrong-discount,search-500
 *
 * Uses the database in DATABASE_URL (a scratch project is created and deleted); results are
 * stored as a BenchmarkRun and shown on the /benchmark page. Refuses to run in production.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { DEMO_FAULTS, type DemoFault } from "../demo/target-app";
import { BENCHMARK_DISCLAIMER } from "@/benchmark/metrics";
import { runBenchmark } from "@/benchmark/runner";
import { db } from "@/lib/db";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const faults = flag("faults")?.split(",").map((f) => f.trim()) as DemoFault[] | undefined;
const unknown = faults?.filter((f) => !(DEMO_FAULTS as readonly string[]).includes(f));
if (unknown?.length) {
  console.error(`Unknown fault(s): ${unknown.join(", ")}. Known: ${DEMO_FAULTS.join(", ")}`);
  process.exit(2);
}
let gitCommit: string | null = null;
try {
  gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const startedAt = Date.now();
runBenchmark({ faults, repeats: Number(flag("repeats") ?? 3), mutation: args.includes("--mutation"), mutantLimit: Number(flag("mutants") ?? 20), gitCommit, log: (m) => console.log(`[benchmark +${Math.round((Date.now() - startedAt) / 1000)}s] ${m}`) })
  .then(({ id, metrics, details }) => {
    console.log(`\nBenchmark ${id}`);
    console.table({
      "Bug recall": `${pct(metrics.bugRecall)} (${metrics.faultsDetected}/${metrics.faultsEvaluated} faults)`,
      "Case recall": pct(metrics.caseRecall),
      "Report precision": pct(metrics.reportPrecision),
      "False alarms on the clean app": String(metrics.falseAlarmsOnCleanApp),
      "Execution reliability": `${pct(metrics.executionReliability)} over ${metrics.cleanRuns} clean runs`,
      "Infrastructure rate": pct(metrics.infrastructureRate),
      "Flaky handling": metrics.flakyHandled ? "ok" : "FAILED",
      "Inventory verified": pct(metrics.inventoryVerified),
      "Mutation score": pct(metrics.mutationScore),
    });
    for (const f of details.perFault) console.log(`${f.detected ? "✓" : "✗"} ${f.fault} (${f.kind})${f.missed.length ? ` missed: ${f.missed.join("; ")}` : ""}${f.falsePositives.length ? ` false positives: ${f.falsePositives.join("; ")}` : ""}`);
    console.log(`\n${BENCHMARK_DISCLAIMER}`);
  })
  .catch((error) => {
    console.error("Benchmark failed:", error);
    process.exitCode = 1;
  })
  .finally(() => db().$disconnect());
