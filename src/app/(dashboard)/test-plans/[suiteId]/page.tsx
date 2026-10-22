import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BulkReviewForm } from "@/components/forms/bulk-review-form";
import { ActionButton } from "@/components/forms/action-button";
import { ActionForm } from "@/components/forms/action-form";
import { SelectField, TextAreaField, TextField } from "@/components/forms/fields";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Priority, TestCaseType } from "@/generated/prisma/enums";
import { enumOptions, formatDateTime, humanize, pluralize } from "@/lib/utils";
import { requireActor } from "@/modules/auth/session";
import { describeAction } from "@/modules/execution/steps";
import { MutationPanel } from "@/modules/mutation/components/mutation-panel";
import { rerunVersion } from "@/modules/test-runs/actions";
import { addTestCase, archiveTestSuite, deleteTestSuite, reviewTestCases, submitForApproval, updateTestSuite } from "@/modules/test-suites/actions";
import { getTestSuite } from "@/modules/test-suites/queries";

export default function TestSuitePage({ params }: PageProps<"/test-plans/[suiteId]">) {
  return (
    <Suspense
      fallback={
        <>
          <Skeleton className="mb-6 h-8 w-64" />
          <CardSkeleton rows={6} />
        </>
      }
    >
      <TestSuiteDetail params={params} />
    </Suspense>
  );
}

const reviewTone = { PROPOSED: "warning", ACCEPTED: "success", REJECTED: "danger" } as const;

async function TestSuiteDetail({ params }: { params: PageProps<"/test-plans/[suiteId]">["params"] }) {
  const actor = await requireActor();
  const { suiteId } = await params;
  const suite = await getTestSuite(actor, suiteId);
  if (!suite) notFound();

  const pending = suite.planVersions.find((v) => v.status === "PENDING_APPROVAL");
  const editable = suite.permissions.edit && suite.status === "ACTIVE" && !pending;
  const { review } = suite;

  return (
    <>
      <PageHeader
        backHref="/test-plans"
        backLabel="Test plans"
        title={
          <span className="flex flex-wrap items-center gap-3">
            {suite.name}
            {suite.kind === "REGRESSION" ? <StatusBadge status="Regression suite" tone="info" /> : null}
            {suite.status === "ARCHIVED" ? <StatusBadge status="ARCHIVED" /> : null}
          </span>
        }
        description={
          <>
            <Link href={`/applications/${suite.application.id}`} className="font-medium hover:text-indigo-600">
              {suite.application.name}
            </Link>{" "}
            · {humanize(suite.source)} · {pluralize(review.accepted, "accepted case")}
            {review.proposed ? ` · ${review.proposed} awaiting review` : ""}
            {review.rejected ? ` · ${review.rejected} rejected` : ""}
          </>
        }
        actions={
          suite.permissions.delete ? (
            <div className="flex gap-2">
              <ActionButton action={archiveTestSuite.bind(null, suite.id)} confirmMessage="Archive this suite? Its history is kept.">
                Archive
              </ActionButton>
              <ActionButton action={deleteTestSuite.bind(null, suite.id)} variant="danger" confirmMessage={`Delete "${suite.name}"? Suites with runs can only be archived.`}>
                Delete
              </ActionButton>
            </div>
          ) : null
        }
      />

      {pending ? (
        <Banner tone="warning">
          v{pending.version} is awaiting review. Cases are locked until it&apos;s approved or rejected.{" "}
          <Link href="/approvals" className="underline">Go to approvals</Link>
        </Banner>
      ) : review.changedSinceApproval ? (
        <Banner tone="warning">
          <strong>Changed since approved v{review.approvedVersion}.</strong> Runs keep using v{review.approvedVersion} until a new version
          is submitted and approved.
          {review.changes ? (
            <span className="mt-1 block text-xs">
              {review.changes.added.length ? `Added: ${review.changes.added.join(", ")}. ` : ""}
              {review.changes.changed.length ? `Changed: ${review.changes.changed.join(", ")}. ` : ""}
              {review.changes.removed.length ? `Removed: ${review.changes.removed.join(", ")}.` : ""}
            </span>
          ) : null}
        </Banner>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Test cases"
              description={editable ? "Select cases to accept or reject. Only accepted cases are submitted for approval." : "Read only."}
            />
            {suite.testCases.length === 0 ? (
              <EmptyState title="No test cases yet" description="Generate cases from the application page, or add one manually." />
            ) : (
              <BulkReviewForm action={reviewTestCases.bind(null, suite.id)} disabled={!editable}>
                <ol className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {suite.testCases.map((testCase, index) => {
                    const executable = testCase.steps.every((s) => s.kind !== null);
                    return (
                      <li key={testCase.id} className={`px-5 py-4 ${testCase.reviewState === "REJECTED" ? "opacity-60" : ""}`}>
                        <div className="flex items-start gap-3">
                          {editable ? (
                            <input
                              type="checkbox"
                              name="caseIds"
                              value={testCase.id}
                              data-state={testCase.reviewState}
                              aria-label={`Select ${testCase.title}`}
                              className="mt-1 size-4 rounded border-zinc-300"
                            />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                              <span className="text-zinc-400 tabular-nums">{index + 1}.</span>
                              {testCase.title}
                              <StatusBadge status={testCase.reviewState} tone={reviewTone[testCase.reviewState]} />
                              <StatusBadge status={testCase.type} tone="neutral" />
                              <StatusBadge status={testCase.priority} />
                              {!executable ? <StatusBadge status="Manual" tone="neutral" /> : null}
                            </p>
                            <p className="mt-0.5 text-xs text-zinc-500">
                              {testCase.feature?.name ?? "No feature"}
                              {testCase.generationJob ? ` · generated by ${testCase.generationJob.provider}/${testCase.generationJob.model}` : ""}
                              {testCase.requirementRefs.length ? ` · covers: ${testCase.requirementRefs.join("; ")}` : ""}
                            </p>
                            {testCase.prerequisites.length ? (
                              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                                <span className="font-medium">Prerequisites:</span> {testCase.prerequisites.join(" · ")}
                              </p>
                            ) : null}
                            <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
                              {testCase.steps.map((step) => (
                                <li key={step.id}>
                                  {step.action}
                                  {step.kind ? <span className="ml-1 font-mono text-xs text-zinc-400">[{describeAction(step.kind, step.params)}]</span> : null}
                                  {step.expectedResult ? <span className="text-zinc-400"> → {step.expectedResult}</span> : null}
                                </li>
                              ))}
                            </ol>
                            {testCase.expectedResult ? (
                              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                                <span className="font-medium text-zinc-800 dark:text-zinc-200">Expected:</span> {testCase.expectedResult}
                              </p>
                            ) : null}
                          </div>
                          {editable ? (
                            <LinkButton href={`/test-plans/${suite.id}/cases/${testCase.id}`} variant="ghost" size="sm">
                              Edit
                            </LinkButton>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </BulkReviewForm>
            )}
          </Card>

          <Card>
            <CardHeader title="Plan versions" description="Immutable snapshots. Approval is bound to each version's content hash." />
            {suite.planVersions.length === 0 ? (
              <EmptyState title="Not submitted yet" />
            ) : (
              <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {suite.planVersions.map((version) => {
                  const decision = version.approvals.find((a) => a.status !== "PENDING");
                  return (
                    <li key={version.id} className="px-5 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="font-medium text-zinc-900 dark:text-zinc-100">
                          v{version.version}{" "}
                          <span className="font-normal text-zinc-500">
                            · {pluralize(version.caseCount, "case")} · submitted {formatDateTime(version.createdAt)}
                            {version.approvals[0]?.requestedBy ? ` by ${version.approvals[0].requestedBy.name}` : ""}
                          </span>
                        </p>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={version.status} />
                          {version.status === "APPROVED" && suite.permissions.run && version.snapshotFormat === 2 ? (
                            <ActionButton action={rerunVersion.bind(null, version.id)} variant="primary">
                              Run
                            </ActionButton>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-1 font-mono text-xs break-all text-zinc-500" title="SHA-256 of the version content">
                        sha256 {version.contentHash}
                      </p>
                      {version.changeSummary ? <p className="mt-1 text-zinc-600 dark:text-zinc-400">{version.changeSummary}</p> : null}
                      {decision ? (
                        <p className="mt-1 text-zinc-500 dark:text-zinc-400">
                          {humanize(decision.status)} by {decision.reviewer?.name ?? "unknown"} {formatDateTime(decision.decidedAt)}
                          {decision.comment ? ` — ${decision.comment}` : ""}
                        </p>
                      ) : null}
                      {version.testRuns.length ? (
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                          Runs:
                          {version.testRuns.map((run) => (
                            <Link key={run.id} href={`/test-runs/${run.id}`}>
                              <StatusBadge status={run.status} />
                            </Link>
                          ))}
                        </p>
                      ) : null}
                      {version.status === "APPROVED" && version.snapshotFormat === 2 ? (
                        <MutationPanel planVersionId={version.id} runs={version.mutationRuns} canRun={suite.permissions.run} />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          {editable ? (
            <Card>
              <CardHeader title="Submit for approval" description={`Freezes ${pluralize(review.accepted, "accepted case")} into v${(suite.planVersions[0]?.version ?? 0) + 1}.`} />
              <CardBody>
                {review.workingHash ? <p className="mb-3 font-mono text-xs break-all text-zinc-500">content sha256 {review.workingHash}</p> : null}
                <ActionForm action={submitForApproval.bind(null, suite.id)} submitLabel="Submit for approval" pendingLabel="Submitting…">
                  <TextAreaField name="changeSummary" label="What changed (optional)" rows={2} />
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
          {editable ? (
            <Card>
              <CardHeader title="Add a test case" />
              <CardBody>
                <CaseFields />
              </CardBody>
            </Card>
          ) : null}
          {editable ? (
            <Card>
              <CardHeader title="Suite details" />
              <CardBody>
                <ActionForm action={updateTestSuite.bind(null, suite.id)} submitLabel="Save">
                  <TextField name="name" label="Name" defaultValue={suite.name} />
                  <TextAreaField name="description" label="Description" defaultValue={suite.description ?? ""} />
                </ActionForm>
              </CardBody>
            </Card>
          ) : (
            <Card className="self-start">
              <CardHeader title="Suite details" />
              <CardBody className="text-sm text-zinc-600 dark:text-zinc-400">{suite.description ?? "No description."}</CardBody>
            </Card>
          )}
        </div>
      </div>
    </>
  );

  function CaseFields() {
    return (
      <ActionForm action={addTestCase.bind(null, suite!.id)} submitLabel="Add test case" pendingLabel="Adding…">
        <TextField name="title" label="Title" placeholder="Guest can complete checkout" />
        <TextAreaField name="steps" label="Steps" rows={5} placeholder={'One step per line (manual), or a JSON array of executable steps:\n[{"kind":"NAVIGATE","description":"Open cart","params":{"url":"/cart"}}]'} hint="Manual steps can't run automatically; executable steps use navigate, click, fill, select, wait and assert." />
        <TextAreaField name="expectedResult" label="Expected result" rows={2} />
        <TextAreaField name="prerequisites" label="Prerequisites (one per line)" rows={2} />
        <TextAreaField name="requirementRefs" label="Requirements covered (one per line)" rows={2} />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField name="priority" label="Priority" options={enumOptions(Priority)} defaultValue={Priority.MEDIUM} />
          <SelectField name="type" label="Category" options={enumOptions(TestCaseType)} defaultValue={TestCaseType.POSITIVE} />
        </div>
      </ActionForm>
    );
  }
}

function Banner({ tone, children }: { tone: "warning"; children: React.ReactNode }) {
  return (
    <div role="status" className={tone === "warning" ? "mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200" : ""}>
      {children}
    </div>
  );
}
