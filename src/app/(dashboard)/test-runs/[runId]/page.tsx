import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionButton } from "@/components/forms/action-button";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Progress } from "@/components/ui/progress";
import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { formatDateTime, humanize } from "@/lib/utils";
import { requireActor } from "@/modules/auth/session";
import { SUSPECTED_CAUSE_LABEL, type FeatureCoverage } from "@/modules/reports/build";
import { DefectVerificationForm } from "@/modules/defects/components/defect-verification-form";
import { verifyDefectAction } from "@/modules/defects/actions";
import { FAILURE_CLASS_LABELS } from "@/modules/execution/verdict";
import { filterResults, REPORT_LIMITATIONS } from "@/modules/reports/export";
import { cancelTestRun, rerunVersion } from "@/modules/test-runs/actions";
import { getRunReport } from "@/modules/test-runs/queries";

export default function RunReportPage({ params, searchParams }: PageProps<"/test-runs/[runId]">) {
  return (
    <Suspense
      fallback={
        <>
          <Skeleton className="mb-6 h-8 w-64" />
          <CardSkeleton rows={6} />
        </>
      }
    >
      <RunReport params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const STATUSES = ["PASSED", "FAILED", "BLOCKED", "INCONCLUSIVE", "SKIPPED"] as const;
const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

async function RunReport({ params, searchParams }: { params: PageProps<"/test-runs/[runId]">["params"]; searchParams: PageProps<"/test-runs/[runId]">["searchParams"] }) {
  const actor = await requireActor();
  const [{ runId }, query] = await Promise.all([params, searchParams]);
  const run = await getRunReport(actor, runId);
  if (!run) notFound();

  const filters = {
    status: STATUSES.find((s) => s === one(query.status)),
    priority: PRIORITIES.find((p) => p === one(query.priority)),
    feature: one(query.feature),
    regressionsOnly: one(query.regressions) === "1",
  };
  const results = filterResults(run, filters);
  const coverage = (run.report?.coverage ?? { features: [], uncovered: [] }) as { features: FeatureCoverage[]; uncovered: string[]; inventory?: { known: number; byLevel: Record<string, number>; notVerified: string[]; disclaimer: string } | null };
  const active = run.status === "QUEUED" || run.status === "RUNNING";
  const approval = run.planVersion.approvals[0];
  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status: filters.status, priority: filters.priority, feature: filters.feature, regressions: filters.regressionsOnly ? "1" : undefined, ...extra })) if (v) p.set(k, v);
    return p.toString();
  };
  const features = [...new Set(run.results.map((r) => r.featureName ?? "(no feature)"))].sort();

  const tiles = [
    { label: "Passed", value: run.report?.passed ?? 0, tone: "text-emerald-600" },
    { label: "Failed", value: run.report?.failed ?? 0, tone: "text-red-600" },
    { label: "Blocked", value: run.report?.blocked ?? 0, tone: "text-amber-600" },
    { label: "Inconclusive", value: (run.report?.inconclusive ?? 0) + (run.report?.errored ?? 0), tone: "text-amber-600" },
    { label: "Skipped", value: run.report?.skipped ?? 0, tone: "" },
    { label: "Regressions", value: run.report?.regressions ?? 0, tone: run.report?.regressions ? "text-red-600" : "" },
    { label: "Fixed", value: run.report?.fixed ?? 0, tone: "" },
  ];

  return (
    <>
      <PageHeader
        backHref="/test-runs"
        backLabel="Test runs"
        title={
          <span className="flex flex-wrap items-center gap-3">
            {run.planVersion.suite.name} v{run.planVersion.version} <StatusBadge status={run.status} />
          </span>
        }
        description={
          <>
            {run.planVersion.suite.application.name} · {run.baseUrl} · {run.environment ?? "—"} · queued {formatDateTime(run.createdAt)}
            {run.triggeredBy ? ` by ${run.triggeredBy.name}` : ""} · finished {formatDateTime(run.finishedAt)}
            {run.attempts > 1 ? ` · ${run.attempts} attempts` : ""}
          </>
        }
        actions={
          <div className="flex flex-wrap items-start gap-2">
            <AutoRefresh active={active} />
            <LinkButton href={`/api/runs/${run.id}/report?${qs({ format: "html" })}`} variant="secondary" size="sm" prefetch={false}>
              Download HTML
            </LinkButton>
            <LinkButton href={`/api/runs/${run.id}/report?${qs({ format: "json" })}`} variant="secondary" size="sm" prefetch={false}>
              Download JSON
            </LinkButton>
            {active && run.permissions.manage ? (
              <ActionButton action={cancelTestRun.bind(null, run.id)} confirmMessage="Cancel this run?">
                Cancel
              </ActionButton>
            ) : null}
            {!active && run.permissions.manage ? <ActionButton action={rerunVersion.bind(null, run.planVersion.id)}>Rerun</ActionButton> : null}
          </div>
        }
      />

      {run.blockedReason ? (
        <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          <strong>Blocked before execution:</strong> {run.blockedReason}
        </div>
      ) : null}
      {run.errorMessage ? (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
          {run.errorMessage}
        </div>
      ) : null}
      {active ? (
        <div className="mb-4 max-w-sm">
          <Progress done={run.progressDone} total={run.progressTotal} label="Run progress" />
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-3 gap-3 lg:grid-cols-7">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{t.label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${t.tone}`}>{t.value}</p>
          </div>
        ))}
      </div>

      <p className="mb-6 -mt-3 text-xs text-zinc-500">{REPORT_LIMITATIONS}</p>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Results" description={`${results.length} of ${run.results.length} cases`} />
            <form className="flex flex-wrap items-end gap-3 border-b border-zinc-200 px-5 py-3 text-sm dark:border-zinc-800" aria-label="Filter results">
              <label className="grid gap-1 text-xs text-zinc-500">
                Status
                <select name="status" defaultValue={filters.status ?? ""} className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                  <option value="">All</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{humanize(s)}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-zinc-500">
                Feature
                <select name="feature" defaultValue={filters.feature ?? ""} className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                  <option value="">All</option>
                  {features.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-zinc-500">
                Priority
                <select name="priority" defaultValue={filters.priority ?? ""} className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                  <option value="">All</option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>{humanize(p)}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-xs text-zinc-600">
                <input type="checkbox" name="regressions" value="1" defaultChecked={filters.regressionsOnly} /> Regressions only
              </label>
              <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
                Apply
              </button>
              <Link href={`/test-runs/${run.id}`} className="text-xs text-zinc-500 hover:text-zinc-900">
                Reset
              </Link>
            </form>
            {results.length === 0 ? (
              <EmptyState title={run.results.length ? "No results match the filters" : active ? "Waiting for results…" : "No results"} />
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {results.map((r) => {
                  const failed = r.failedStep;
                  return (
                    <li key={r.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={r.status} />
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">{r.caseTitle}</span>
                        {r.comparison === "REGRESSED" ? <StatusBadge status="Regression" tone="danger" /> : null}
                        {r.comparison === "FIXED" ? <StatusBadge status="Fixed" tone="success" /> : null}
                        {r.flaky ? <StatusBadge status="Flaky" tone="warning" /> : null}
                        {r.failureClass ? <span className="text-xs text-zinc-500">Failure class: {FAILURE_CLASS_LABELS[r.failureClass]}</span> : null}
                      </div>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {r.featureName ?? "No feature"} · {humanize(r.category ?? "FUNCTIONAL")} · priority {humanize(r.casePriority)}
                        {r.suggestedSeverity ? ` · suggested severity ${humanize(r.suggestedSeverity)}` : ""}
                        {r.previousStatus ? ` · previously ${humanize(r.previousStatus)}` : ""}
                        {r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ""}
                        {r.attemptCount > 1 ? ` · ${r.attemptCount} attempts` : ""}
                        {r.flakeRate ? ` · flake rate ${Math.round(r.flakeRate * 100)}% (recent runs, heuristic)` : ""}
                      </p>
                      {r.errorMessage ? <p className="mt-1 text-sm text-red-700 dark:text-red-400">{r.errorMessage}</p> : null}
                      {failed ? (
                        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded border border-zinc-200 p-2 text-xs dark:border-zinc-800">
                          <dt className="text-zinc-500">{failed.status === "FAILED" ? "Failed step" : `${humanize(failed.status)} step`}</dt>
                          <dd>{failed.position + 1}. {failed.action}</dd>
                          <dt className="text-zinc-500">Expected</dt>
                          <dd>{failed.expectedResult ?? "—"}</dd>
                          <dt className="text-zinc-500">Actual</dt>
                          <dd className="text-red-700 dark:text-red-400">{failed.actualResult ?? failed.errorMessage ?? "—"}</dd>
                        </dl>
                      ) : null}
                      {r.suspectedCause ? (
                        <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                          <strong>{SUSPECTED_CAUSE_LABEL}:</strong> {r.suspectedCause}
                        </p>
                      ) : null}
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-indigo-600">Steps, reproduction and evidence</summary>
                        <ol className="mt-2 space-y-1">
                          {r.stepResults.map((s) => (
                            <li key={s.id} className="flex flex-wrap items-center gap-2">
                              <StatusBadge status={s.status} />
                              <span>{s.position + 1}. {s.action}</span>
                              {s.actualResult ? <span className="text-zinc-500">→ {s.actualResult}</span> : null}
                              {s.artifacts.map((a) => (
                                <a key={a.id} href={`/api/artifacts/${a.id}`} target="_blank" rel="noreferrer" className="text-indigo-600">
                                  screenshot
                                </a>
                              ))}
                            </li>
                          ))}
                        </ol>
                        {r.attemptCount > 1 ? (
                          <ul className="mt-2 space-y-0.5 text-zinc-600 dark:text-zinc-300" aria-label="Attempts">
                            {((r.attempts ?? []) as Array<{ attempt: number; status: string; failedStep: number | null; durationMs: number }>).map((a) => (
                              <li key={a.attempt}>
                                Attempt {a.attempt}: {humanize(a.status)}
                                {a.failedStep !== null ? ` at step ${a.failedStep + 1}` : ""} · {(a.durationMs / 1000).toFixed(1)}s
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {r.artifacts.length ? (
                          <p className="mt-2">
                            {r.artifacts.map((a) => (
                              <a key={a.id} href={`/api/artifacts/${a.id}`} className="mr-3 text-indigo-600">
                                {a.kind === "TRACE" ? "Playwright trace (.zip)" : a.name}
                              </a>
                            ))}
                          </p>
                        ) : null}
                        {r.defects.map((d) => (
                          <div key={d.id} className="mt-2 rounded border border-zinc-200 p-2 dark:border-zinc-800">
                            <p className="text-zinc-600 dark:text-zinc-300">
                              Defect ({humanize(d.severity)}) · <StatusBadge status={d.verification === "REPRODUCED" ? "Reproduced, awaiting review" : humanize(d.verification)} tone={d.verification === "CONFIRMED" ? "danger" : d.verification === "REPRODUCED" ? "warning" : "neutral"} />
                              {d.verifiedAt ? ` by ${d.verifiedBy?.name ?? "a former user"} on ${formatDateTime(d.verifiedAt)}: ${d.verificationNote ?? ""}` : null}
                            </p>
                            {d.verification === "REPRODUCED" && run.permissions.verifyDefects ? <DefectVerificationForm action={verifyDefectAction.bind(null, d.id)} /> : null}
                          </div>
                        ))}
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Feature coverage" />
            {coverage.features.length === 0 ? (
              <EmptyState title="No results yet" />
            ) : (
              <Table>
                <THead columns={["Feature", "Cases", "Pass rate"]} />
                <TBody>
                  {coverage.features.map((f) => (
                    <tr key={f.feature}>
                      <TD>
                        <Link href={`/test-runs/${run.id}?${qs({ feature: f.feature })}`} className="hover:text-indigo-600">
                          {f.feature}
                        </Link>
                        <p className="text-xs text-zinc-500">
                          {f.passed} passed · {f.failed} failed · {f.blocked} blocked
                        </p>
                      </TD>
                      <TD className="tabular-nums">{f.total}</TD>
                      <TD className="tabular-nums">{f.passRate === null ? "—" : `${f.passRate}%`}</TD>
                    </tr>
                  ))}
                </TBody>
              </Table>
            )}
            {coverage.uncovered.length ? (
              <CardBody className="border-t border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">Not covered: {coverage.uncovered.join(", ")}</CardBody>
            ) : null}
            {coverage.inventory ? (
              <CardBody className="space-y-1 border-t border-zinc-200 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
                <p className="font-medium">
                  Known inventory: {coverage.inventory.byLevel.VERIFIED} of {coverage.inventory.known} items verified by this run
                </p>
                {coverage.inventory.notVerified.length ? <p className="text-zinc-500">Not verified: {coverage.inventory.notVerified.slice(0, 15).join(", ")}{coverage.inventory.notVerified.length > 15 ? "…" : ""}</p> : null}
                <p className="text-zinc-500">{coverage.inventory.disclaimer}</p>
              </CardBody>
            ) : null}
          </Card>
          <Card>
            <CardHeader title="Approved plan" />
            <CardBody className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
              <p>
                <Link href={`/test-plans/${run.planVersion.suite.id}`} className="text-indigo-600">
                  {run.planVersion.suite.name} v{run.planVersion.version}
                </Link>
              </p>
              <p className="font-mono break-all">sha256 {run.planVersion.contentHash}</p>
              <p>Approved by {approval?.reviewer?.name ?? "—"} · {formatDateTime(approval?.decidedAt)}</p>
              {run.comparedToRun ? (
                <p>
                  Compared with{" "}
                  <Link href={`/test-runs/${run.comparedToRun.id}`} className="text-indigo-600">
                    the run of {formatDateTime(run.comparedToRun.createdAt)}
                  </Link>
                </p>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
