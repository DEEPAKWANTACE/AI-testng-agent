import Link from "next/link";
import { ActionForm } from "@/components/forms/action-form";
import { SelectField, TextAreaField, TextField } from "@/components/forms/fields";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDateTime, humanize } from "@/lib/utils";
import { createRegressionSuiteAction, generateTestCases } from "@/modules/generation/actions";

type Job = {
  id: string;
  status: string;
  caseCount: number;
  rejectedCount: number;
  provider: string | null;
  model: string | null;
  errorMessage: string | null;
  createdAt: Date;
  suite: { id: string; name: string } | null;
};

export function GenerationCard({
  applicationId,
  features,
  suites,
  jobs,
  provider,
}: {
  applicationId: string;
  features: Array<{ id: string; name: string; source: string }>;
  suites: Array<{ id: string; name: string }>;
  jobs: Job[];
  provider: string;
}) {
  return (
    <Card>
      <CardHeader
        title="Generate test cases"
        description={`From discovered features and your requirements, using ${provider === "heuristic" ? "the built-in rule-based generator (no LLM configured)" : `the configured LLM (${provider})`}. Results are drafts for review.`}
      />
      <CardBody>
        {features.length === 0 ? (
          <EmptyState title="No features yet" description="Run discovery first, so there's something to generate tests for." />
        ) : (
          <ActionForm action={generateTestCases.bind(null, applicationId)} submitLabel="Generate" pendingLabel="Queuing…">
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">Features</legend>
              <div className="grid max-h-48 gap-1 overflow-y-auto rounded border border-zinc-200 p-2 text-sm dark:border-zinc-800">
                {features.map((f) => (
                  <label key={f.id} className="flex items-center gap-2">
                    <input type="checkbox" name="featureIds" value={f.id} className="size-4" /> {f.name}
                    <span className="text-xs text-zinc-400">{humanize(f.source)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <TextAreaField name="requirements" label="Requirements (optional)" rows={3} placeholder={"Guests can check out without an account\nCoupons can't be combined"} />
            <SelectField name="suiteId" label="Add to" options={suites.map((s) => ({ value: s.id, label: s.name }))} placeholder="A new draft suite" defaultValue="" />
          </ActionForm>
        )}
      </CardBody>
      {jobs.length ? (
        <ul className="divide-y divide-zinc-100 border-t border-zinc-200 text-xs dark:divide-zinc-800 dark:border-zinc-800">
          {jobs.map((job) => (
            <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
              <span>
                <StatusBadge status={job.status} /> <span className="text-zinc-500">{formatDateTime(job.createdAt)}</span>
                {job.status === "SUCCEEDED" ? ` · ${job.caseCount} cases${job.rejectedCount ? `, ${job.rejectedCount} invalid dropped` : ""} · ${job.provider}/${job.model}` : ""}
                {job.errorMessage && job.status === "FAILED" ? <span className="text-red-600"> · {job.errorMessage}</span> : null}
              </span>
              {job.suite ? (
                <Link href={`/test-plans/${job.suite.id}`} className="text-indigo-600">
                  Review →
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

type ApprovedCase = { versionId: string; version: number; suiteName: string; case: { caseKey: string; title: string; type: string; priority: string } };

export function RegressionCard({ applicationId, cases }: { applicationId: string; cases: ApprovedCase[] }) {
  const bySuite = new Map<string, ApprovedCase[]>();
  for (const c of cases) bySuite.set(`${c.suiteName} v${c.version}`, [...(bySuite.get(`${c.suiteName} v${c.version}`) ?? []), c]);
  return (
    <Card>
      <CardHeader title="Regression suite" description="Reuse approved cases. The new suite must be approved before it runs; results are compared with earlier runs." />
      <CardBody>
        {cases.length === 0 ? (
          <EmptyState title="No approved cases yet" description="Approve a plan version first." />
        ) : (
          <ActionForm action={createRegressionSuiteAction.bind(null, applicationId)} submitLabel="Create regression suite" pendingLabel="Creating…">
            <TextField name="name" label="Name" placeholder="Release regression" />
            <div className="max-h-64 space-y-2 overflow-y-auto rounded border border-zinc-200 p-2 text-sm dark:border-zinc-800">
              {[...bySuite.entries()].map(([suite, items]) => (
                <fieldset key={suite}>
                  <legend className="text-xs font-medium text-zinc-500">{suite}</legend>
                  {items.map((c) => (
                    <label key={`${c.versionId}:${c.case.caseKey}`} className="flex items-center gap-2">
                      <input type="checkbox" name="selections" value={`${c.versionId}:${c.case.caseKey}`} defaultChecked className="size-4" />
                      <span className="truncate">{c.case.title}</span>
                      <span className="text-xs text-zinc-400">{humanize(c.case.type)}</span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
