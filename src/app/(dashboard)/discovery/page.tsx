import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActionButton } from "@/components/forms/action-button";
import { ActionForm } from "@/components/forms/action-form";
import { SelectField, TextField } from "@/components/forms/fields";
import { LinkButton } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import { listApplicationOptions } from "@/modules/applications/service";
import { requireActor } from "@/modules/auth/session";
import { cancelDiscoveryRun, createDiscoveryRun, deleteDiscoveryRun } from "@/modules/discovery/actions";
import { listDiscoveryRuns } from "@/modules/discovery/queries";

export const metadata: Metadata = { title: "Discovery" };

export default function DiscoveryPage({ searchParams }: PageProps<"/discovery">) {
  return (
    <>
      <PageHeader
        title="Discovery"
        description="Crawl an application's authorized URL to map its pages, links, forms, buttons, inputs and navigation."
      />
      <Callout title="Runs are processed by the discovery worker">
        Start it with <code>npm run worker:discovery</code>. It only visits the application&apos;s authorized URL, follows
        links but never submits forms, and blocks localhost, private networks and cloud metadata endpoints.
      </Callout>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Suspense fallback={<CardSkeleton />}>
            <RunsTable />
          </Suspense>
        </div>
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <NewRunCard searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

async function RunsTable() {
  const actor = await requireActor();
  const runs = await listDiscoveryRuns(actor);

  return (
    <Card>
      <CardHeader title="Discovery runs" description={`${runs.length} total`} />
      {runs.length === 0 ? (
        <EmptyState title="No discovery runs yet" description="Queue a run to map an application." />
      ) : (
        <Table>
          <THead columns={["Application", "Limits", "Pages", "Features", "Status", "Created", { label: "", className: "w-0" }]} />
          <TBody>
            {runs.map((run) => (
              <tr key={run.id}>
                <TD>
                  <Link href={`/discovery/${run.id}`} className="font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100">
                    {run.application.name}
                  </Link>
                  <p className="max-w-56 truncate text-xs text-zinc-500 dark:text-zinc-400">{run.startUrl}</p>
                </TD>
                <TD className="text-xs whitespace-nowrap">
                  depth {run.maxDepth} · {run.maxPages} pages
                </TD>
                <TD className="tabular-nums">{run._count.pages}</TD>
                <TD className="tabular-nums">{run._count.features}</TD>
                <TD>
                  <StatusBadge status={run.status} />
                </TD>
                <TD className="whitespace-nowrap">{formatDateTime(run.createdAt)}</TD>
                <TD>
                  <div className="flex items-start gap-1">
                    <LinkButton href={`/discovery/${run.id}`} variant="ghost" size="sm">
                      View
                    </LinkButton>
                    {run.status === "QUEUED" || run.status === "RUNNING" ? (
                      <ActionButton action={cancelDiscoveryRun.bind(null, run.id)} variant="ghost" confirmMessage="Cancel this discovery run?">
                        Cancel
                      </ActionButton>
                    ) : (
                      <ActionButton
                        action={deleteDiscoveryRun.bind(null, run.id)}
                        variant="ghost"
                        confirmMessage="Delete this run, its discovered pages and screenshots? Saved features are kept."
                      >
                        Delete
                      </ActionButton>
                    )}
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

async function NewRunCard({ searchParams }: { searchParams: PageProps<"/discovery">["searchParams"] }) {
  const actor = await requireActor();
  const [{ application }, applications] = await Promise.all([searchParams, listApplicationOptions(actor)]);
  const preselected = applications.find((app) => app.id === application);

  return (
    <Card>
      <CardHeader title="New discovery run" />
      <CardBody>
        {applications.length === 0 ? (
          <EmptyState
            title="No applications available"
            description="Register an application before running discovery."
            action={<LinkButton href="/applications">Go to applications</LinkButton>}
          />
        ) : (
          <ActionForm action={createDiscoveryRun} submitLabel="Queue discovery">
            <SelectField
              name="applicationId"
              label="Application"
              placeholder="Select an application"
              options={applications.map((app) => ({ value: app.id, label: `${app.project.name} / ${app.name}` }))}
              defaultValue={preselected?.id ?? ""}
            />
            <TextField
              name="startUrl"
              label="Start URL"
              type="url"
              placeholder="https://staging.example.com"
              defaultValue={preselected?.authorizedUrl}
              hint="Must be within the application's authorized URL."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField name="maxDepth" label="Max depth" type="number" min={1} max={10} defaultValue="5" hint="Clicks from the start page. 10 is the maximum." />
              <TextField name="maxPages" label="Max pages" type="number" min={1} max={1000} defaultValue="200" hint="Up to 1000. The time limit grows with this value." />
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
