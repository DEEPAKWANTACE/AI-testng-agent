import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { formatDateTime, humanize, pluralize } from "@/lib/utils";
import { decideApproval } from "@/modules/approvals/actions";
import { ApprovalDecisionForm } from "@/modules/approvals/components/approval-decision-form";
import { listPendingApprovals, listRecentDecisions } from "@/modules/approvals/queries";
import { requireActor } from "@/modules/auth/session";
import { describeAction } from "@/modules/execution/steps";

export const metadata: Metadata = { title: "Approvals" };

export default function ApprovalsPage() {
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Review the exact content of each submitted plan version. Your decision is bound to its content hash; any later change needs a new approval."
      />
      <div className="space-y-6">
        <Suspense fallback={<CardSkeleton rows={3} />}>
          <PendingApprovals />
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <RecentDecisions />
        </Suspense>
      </div>
    </>
  );
}

async function PendingApprovals() {
  const actor = await requireActor();
  const approvals = await listPendingApprovals(actor);

  return (
    <Card>
      <CardHeader title="Awaiting review" description={pluralize(approvals.length, "request")} />
      {approvals.length === 0 ? (
        <EmptyState title="You're all caught up" description="Plan versions submitted for approval will appear here." />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {approvals.map((approval) => {
            const { planVersion, snapshot, diff } = approval;
            return (
              <li key={approval.id}>
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <Link href={`/test-plans/${planVersion.suite.id}`} className="text-sm font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100">
                        {planVersion.suite.name} <span className="text-zinc-500">v{planVersion.version}</span>
                      </Link>
                      {planVersion.suite.kind === "REGRESSION" ? <span className="ml-2"><StatusBadge status="Regression" tone="info" /></span> : null}
                      <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                        {planVersion.suite.application.project.name} / {planVersion.suite.application.name} · target {planVersion.suite.application.authorizedUrl} ({humanize(planVersion.suite.application.environment)})
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {pluralize(planVersion.caseCount, "test case")} · requested by {approval.requestedBy?.name ?? "—"} {formatDateTime(approval.requestedAt)}
                      </p>
                    </div>
                  </div>
                  <p className="font-mono text-xs break-all text-zinc-500" data-testid="content-hash">sha256 {planVersion.contentHash}</p>
                  {planVersion.changeSummary ? <p className="text-sm text-zinc-700 dark:text-zinc-300">“{planVersion.changeSummary}”</p> : null}
                  {diff ? (
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">
                      {approval.previousVersion ? `Compared with v${approval.previousVersion}: ` : "First version: "}
                      {diff.added.length} added · {diff.changed.length} changed · {diff.removed.length} removed
                      {diff.changed.length ? ` (changed: ${diff.changed.join(", ")})` : ""}
                      {diff.removed.length ? ` (removed: ${diff.removed.join(", ")})` : ""}
                    </p>
                  ) : null}
                  {snapshot ? (
                    <details className="rounded border border-zinc-200 p-2 text-xs dark:border-zinc-800">
                      <summary className="cursor-pointer font-medium text-indigo-600">Inspect {pluralize(snapshot.cases.length, "case")} and steps</summary>
                      <ol className="mt-2 space-y-2">
                        {snapshot.cases.map((c) => (
                          <li key={c.caseKey}>
                            <p className="font-medium text-zinc-800 dark:text-zinc-200">
                              {c.title} <span className="font-normal text-zinc-500">· {humanize(c.type)} · {humanize(c.priority)} · {c.featureName ?? "no feature"}</span>
                            </p>
                            {c.prerequisites.length ? <p className="text-zinc-500">Prerequisites: {c.prerequisites.join(" · ")}</p> : null}
                            <ol className="list-decimal pl-5 text-zinc-600 dark:text-zinc-400">
                              {c.steps.map((s) => (
                                <li key={s.position}>
                                  {s.action} {s.kind ? <span className="font-mono text-zinc-400">[{describeAction(s.kind, s.params)}]</span> : <em>(manual)</em>}
                                </li>
                              ))}
                            </ol>
                            <p className="text-zinc-500">Expected: {c.expectedResult ?? "—"}</p>
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                  {approval.canDecide ? (
                    <ApprovalDecisionForm action={decideApproval.bind(null, approval.id)} expectedHash={planVersion.contentHash} />
                  ) : (
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                      {approval.ownRequest
                        ? "You submitted this version, so someone else must review it."
                        : "Reviewing needs the Admin or QA Lead role and Editor access to the project."}
                    </p>
                  )}
                </CardBody>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

async function RecentDecisions() {
  const actor = await requireActor();
  const decisions = await listRecentDecisions(actor);

  return (
    <Card>
      <CardHeader title="Recent decisions" description="Last 20" />
      {decisions.length === 0 ? (
        <EmptyState title="No decisions yet" />
      ) : (
        <Table>
          <THead columns={["Plan version", "Reviewer", "Comment", "Decision", "Content hash", "Decided"]} />
          <TBody>
            {decisions.map((approval) => (
              <tr key={approval.id}>
                <TD>
                  <Link href={`/test-plans/${approval.planVersion.suite.id}`} className="font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100">
                    {approval.planVersion.suite.name} <span className="text-zinc-500">v{approval.planVersion.version}</span>
                  </Link>
                </TD>
                <TD>{approval.reviewer?.name ?? "—"}</TD>
                <TD className="max-w-60 truncate">{approval.comment ?? "—"}</TD>
                <TD>
                  <StatusBadge status={approval.status} />
                </TD>
                <TD className="font-mono text-xs"><span title={approval.decidedHash ?? ""}>{approval.decidedHash ? `${approval.decidedHash.slice(0, 12)}…` : "—"}</span></TD>
                <TD className="whitespace-nowrap">{formatDateTime(approval.decidedAt)}</TD>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
