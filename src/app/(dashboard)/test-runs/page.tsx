import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionButton } from "@/components/forms/action-button";
import { ActionForm } from "@/components/forms/action-form";
import { SelectField } from "@/components/forms/fields";
import { LinkButton } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Progress } from "@/components/ui/progress";
import { CardSkeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import { requireActor } from "@/modules/auth/session";
import { cancelTestRun, createTestRun } from "@/modules/test-runs/actions";
import { listRunnableVersions, listTestRuns } from "@/modules/test-runs/queries";

export const metadata: Metadata = { title: "Test Runs" };

export default function TestRunsPage() {
  return (
    <>
      <PageHeader title="Test Runs" description="Execute approved plan versions with the isolated Playwright worker." />
      <Callout title="Runs are executed by the job worker">
        Start Redis (<code>docker compose up -d redis</code>) and the worker (<code>npm run worker:jobs</code>). Before each run
        the worker re-verifies the plan&apos;s approval, content hash, target and environment; anything that doesn&apos;t check
        out is <strong>blocked</strong> without opening a browser.
      </Callout>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Suspense fallback={<CardSkeleton />}>
            <RunsTable />
          </Suspense>
        </div>
        <Suspense fallback={<CardSkeleton rows={2} />}>
          <NewRunCard />
        </Suspense>
      </div>
    </>
  );
}

async function RunsTable() {
  const actor = await requireActor();
  const runs = await listTestRuns(actor);
  const active = runs.some((r) => r.status === "QUEUED" || r.status === "RUNNING");

  return (
    <Card>
      <CardHeader title="Runs" description={`${runs.length} most recent`} actions={<AutoRefresh active={active} />} />
      {runs.length === 0 ? (
        <EmptyState title="No test runs yet" description="Queue a run from an approved plan version." />
      ) : (
        <Table>
          <THead columns={["Plan", "Status", "Progress", "Result", "Queued", { label: "", className: "w-0" }]} />
          <TBody>
            {runs.map((run) => (
              <tr key={run.id}>
                <TD>
                  <Link href={`/test-runs/${run.id}`} className="font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100">
                    {run.planVersion.suite.name} <span className="text-zinc-500">v{run.planVersion.version}</span>
                  </Link>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {run.planVersion.suite.application.name} · {run.environment ?? "—"}
                    {run.planVersion.suite.kind === "REGRESSION" ? " · regression" : ""}
                  </p>
                </TD>
                <TD>
                  <StatusBadge status={run.status} />
                  {run.attempts > 1 ? <p className="mt-1 text-xs text-zinc-500">attempt {run.attempts}</p> : null}
                </TD>
                <TD>
                  <Progress done={run.progressDone} total={run.progressTotal} label={`Progress of run ${run.id}`} />
                </TD>
                <TD className="text-xs whitespace-nowrap">
                  {run.report ? (
                    <>
                      <span className="text-emerald-600">{run.report.passed} passed</span> ·{" "}
                      <span className="text-red-600">{run.report.failed} failed</span> · {run.report.blocked} blocked
                      {run.report.inconclusive + run.report.errored ? <> · {run.report.inconclusive + run.report.errored} inconclusive</> : null}
                      {run.report.regressions ? <span className="ml-1 font-medium text-red-600">· {run.report.regressions} regressed</span> : null}
                    </>
                  ) : run.blockedReason ? (
                    <span className="text-amber-700">Blocked</span>
                  ) : (
                    "—"
                  )}
                </TD>
                <TD className="whitespace-nowrap">{formatDateTime(run.createdAt)}</TD>
                <TD>
                  <div className="flex items-start gap-1">
                    <LinkButton href={`/test-runs/${run.id}`} variant="ghost" size="sm">
                      Report
                    </LinkButton>
                    {run.status === "QUEUED" || run.status === "RUNNING" ? (
                      <ActionButton action={cancelTestRun.bind(null, run.id)} variant="ghost" confirmMessage="Cancel this run?">
                        Cancel
                      </ActionButton>
                    ) : null}
                  </div>
                </TD>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

async function NewRunCard() {
  const actor = await requireActor();
  const versions = await listRunnableVersions(actor);

  return (
    <Card>
      <CardHeader title="Queue a run" description="Only the current approved version of each suite can run." />
      <CardBody>
        {versions.length === 0 ? (
          <EmptyState
            title="No approved plans"
            description="Runs need an approved plan version with executable steps, in a project where you have Editor access."
            action={<LinkButton href="/approvals" variant="secondary">Review approvals</LinkButton>}
          />
        ) : (
          <ActionForm action={createTestRun} submitLabel="Queue run" pendingLabel="Queuing…">
            <SelectField
              name="planVersionId"
              label="Approved plan"
              placeholder="Select a plan"
              options={versions.map((v) => ({
                value: v.id,
                label: `${v.suite.application.name} / ${v.suite.name} (v${v.version}${v.suite.kind === "REGRESSION" ? ", regression" : ""})`,
              }))}
              defaultValue=""
            />
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
