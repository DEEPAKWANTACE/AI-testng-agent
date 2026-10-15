import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import { requireActor } from "@/modules/auth/session";
import { listReports } from "@/modules/test-runs/queries";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return (
    <>
      <PageHeader title="Reports" description="Results of every test run, with coverage, failures, regressions and evidence. Download as HTML or JSON from a report." />
      <Suspense fallback={<CardSkeleton />}>
        <ReportsTable />
      </Suspense>
    </>
  );
}

async function ReportsTable() {
  const actor = await requireActor();
  const runs = await listReports(actor);
  return (
    <Card>
      <CardHeader title="All reports" description={`${runs.length} most recent`} />
      {runs.length === 0 ? (
        <EmptyState title="No reports yet" description="A report is created when a test run finishes." />
      ) : (
        <Table>
          <THead columns={["Plan", "Run", "Passed", "Failed", "Blocked", "Regressions", "Finished"]} />
          <TBody>
            {runs.map((run) => (
              <tr key={run.id}>
                <TD>
                  <Link href={`/test-runs/${run.id}`} className="font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100">
                    {run.planVersion.suite.name} v{run.planVersion.version}
                  </Link>
                  <p className="text-xs text-zinc-500">{run.planVersion.suite.application.name}{run.planVersion.suite.kind === "REGRESSION" ? " · regression" : ""}</p>
                </TD>
                <TD><StatusBadge status={run.status} /></TD>
                <TD className="text-emerald-600 tabular-nums">{run.report!.passed}</TD>
                <TD className="text-red-600 tabular-nums">{run.report!.failed + run.report!.errored}</TD>
                <TD className="tabular-nums">{run.report!.blocked}</TD>
                <TD className={run.report!.regressions ? "font-medium text-red-600 tabular-nums" : "tabular-nums"}>{run.report!.regressions}</TD>
                <TD className="whitespace-nowrap">{formatDateTime(run.finishedAt ?? run.report!.createdAt)}</TD>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
