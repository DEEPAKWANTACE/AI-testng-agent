import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import { db } from "@/lib/db";
import { requireActor } from "@/modules/auth/session";
import { BENCHMARK_DISCLAIMER, type BenchmarkMetrics } from "@/benchmark/metrics";

export const metadata: Metadata = { title: "Benchmark" };

export default function BenchmarkPage() {
  return (
    <>
      <PageHeader title="Accuracy benchmark" description={<>Run with <code className="text-xs">npm run benchmark</code>. {BENCHMARK_DISCLAIMER}</>} />
      <Suspense fallback={<CardSkeleton rows={4} />}>
        <Benchmarks />
      </Suspense>
    </>
  );
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
type PerFault = { fault: string; kind: string; description: string; detected: boolean; missed: string[]; falsePositives: string[] };

async function Benchmarks() {
  await requireActor();
  const runs = await db().benchmarkRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 });
  const latest = runs.find((r) => r.status === "SUCCEEDED");
  if (!runs.length) return <EmptyState title="No benchmark runs yet" description="Run npm run benchmark on a machine with the workers' environment." />;
  const m = latest?.metrics as BenchmarkMetrics | undefined;
  const tiles = m
    ? [
        { label: "Bug recall", value: pct(m.bugRecall), hint: `${m.faultsDetected}/${m.faultsEvaluated} seeded faults detected` },
        { label: "Report precision", value: pct(m.reportPrecision), hint: `${m.falseAlarmsOnCleanApp} false alarm(s) on the clean app` },
        { label: "Execution reliability", value: pct(m.executionReliability), hint: `${m.cleanRuns} clean runs · infra ${pct(m.infrastructureRate)}` },
        { label: "Inventory verified", value: pct(m.inventoryVerified), hint: `mutation score ${pct(m.mutationScore)}` },
      ]
    : [];
  return (
    <div className="space-y-6">
      {m && latest ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {tiles.map((t) => (
              <div key={t.label} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{t.label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</p>
                <p className="text-xs text-zinc-500">{t.hint}</p>
              </div>
            ))}
          </div>
          <Card>
            <CardHeader title="Seeded faults (latest run)" description={`${latest.corpusVersion} · ${formatDateTime(latest.finishedAt)}${latest.gitCommit ? ` · ${latest.gitCommit.slice(0, 10)}` : ""} · flaky handling ${m.flakyHandled ? "ok" : "failed"}`} />
            <Table>
              <THead columns={["Fault", "Kind", "Detected", "Missed cases", "False positives"]} />
              <TBody>
                {((latest.details as { perFault: PerFault[] }).perFault ?? []).map((f) => (
                  <tr key={f.fault}>
                    <TD>
                      <p className="font-mono text-xs">{f.fault}</p>
                      <p className="text-xs text-zinc-500">{f.description}</p>
                    </TD>
                    <TD className="text-xs">{f.kind}</TD>
                    <TD><StatusBadge status={f.detected ? "Detected" : "Missed"} tone={f.detected ? "success" : "danger"} /></TD>
                    <TD className="text-xs">{f.missed.join("; ") || "—"}</TD>
                    <TD className="text-xs">{f.falsePositives.join("; ") || "—"}</TD>
                  </tr>
                ))}
              </TBody>
            </Table>
          </Card>
        </>
      ) : null}
      <Card>
        <CardHeader title="History" />
        <Table>
          <THead columns={["Started", "Status", "Corpus", "Recall", "Precision", "Reliability", "Inventory", "Duration"]} />
          <TBody>
            {runs.map((r) => {
              const x = r.metrics as BenchmarkMetrics | null;
              return (
                <tr key={r.id}>
                  <TD className="text-xs whitespace-nowrap">{formatDateTime(r.startedAt)}</TD>
                  <TD><StatusBadge status={r.status} /></TD>
                  <TD className="text-xs">{r.corpusVersion}</TD>
                  <TD className="tabular-nums">{pct(x?.bugRecall)}</TD>
                  <TD className="tabular-nums">{pct(x?.reportPrecision)}</TD>
                  <TD className="tabular-nums">{pct(x?.executionReliability)}</TD>
                  <TD className="tabular-nums">{pct(x?.inventoryVerified)}</TD>
                  <TD className="text-xs">{r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : r.errorMessage ?? "—"}</TD>
                </tr>
              );
            })}
          </TBody>
        </Table>
        <CardBody className="text-xs text-zinc-500">Results are only comparable within the same corpus version.</CardBody>
      </Card>
    </div>
  );
}
