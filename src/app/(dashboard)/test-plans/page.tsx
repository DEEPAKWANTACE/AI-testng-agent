import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActionForm } from "@/components/forms/action-form";
import { SelectField, TextAreaField, TextField } from "@/components/forms/fields";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { formatDate } from "@/lib/utils";
import { listApplicationOptions } from "@/modules/applications/service";
import { createTestSuite } from "@/modules/test-suites/actions";
import { listTestSuites } from "@/modules/test-suites/queries";
import { requireActor } from "@/modules/auth/session";

export const metadata: Metadata = { title: "Test Plans" };

export default function TestPlansPage({ searchParams }: PageProps<"/test-plans">) {
  return (
    <>
      <PageHeader
        title="Test Plans"
        description="Write test cases in a suite, then submit it as a versioned plan for approval before it can run."
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Suspense fallback={<CardSkeleton />}>
            <SuitesTable />
          </Suspense>
        </div>
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <NewSuiteCard searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

async function SuitesTable() {
  const actor = await requireActor();
  const suites = await listTestSuites(actor);

  return (
    <Card>
      <CardHeader title="Test suites" description={`${suites.length} total`} />
      {suites.length === 0 ? (
        <EmptyState title="No test suites yet" description="Create a suite and add test cases to it." />
      ) : (
        <Table>
          <THead columns={["Suite", "Application", "Cases", "Latest plan", "Updated"]} />
          <TBody>
            {suites.map((suite) => {
              const latest = suite.planVersions[0];
              return (
                <tr key={suite.id}>
                  <TD>
                    <Link href={`/test-plans/${suite.id}`} className="font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100">
                      {suite.name}
                    </Link>
                    {suite.status === "ARCHIVED" ? <span className="ml-2 text-xs text-zinc-400">Archived</span> : null}
                  </TD>
                  <TD>
                    <Link href={`/applications/${suite.application.id}`} className="hover:text-indigo-600">
                      {suite.application.name}
                    </Link>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{suite.application.project.name}</p>
                  </TD>
                  <TD className="tabular-nums">{suite._count.testCases}</TD>
                  <TD className="whitespace-nowrap">
                    {latest ? (
                      <span className="flex items-center gap-2">
                        <span className="text-zinc-500 tabular-nums">v{latest.version}</span>
                        <StatusBadge status={latest.status} />
                      </span>
                    ) : (
                      <span className="text-zinc-400">Not submitted</span>
                    )}
                  </TD>
                  <TD className="whitespace-nowrap">{formatDate(suite.updatedAt)}</TD>
                </tr>
              );
            })}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

async function NewSuiteCard({ searchParams }: { searchParams: PageProps<"/test-plans">["searchParams"] }) {
  const actor = await requireActor();
  const [{ application }, applications] = await Promise.all([searchParams, listApplicationOptions(actor)]);
  const preselected = applications.find((app) => app.id === application)?.id;

  return (
    <Card>
      <CardHeader title="New test suite" />
      <CardBody>
        {applications.length === 0 ? (
          <EmptyState
            title="No applications available"
            description="Register an application before creating test suites."
            action={<LinkButton href="/applications">Go to applications</LinkButton>}
          />
        ) : (
          <ActionForm action={createTestSuite} submitLabel="Create suite">
            <SelectField
              name="applicationId"
              label="Application"
              placeholder="Select an application"
              options={applications.map((app) => ({ value: app.id, label: `${app.project.name} / ${app.name}` }))}
              defaultValue={preselected ?? ""}
            />
            <TextField name="name" label="Name" placeholder="Checkout regression" />
            <TextAreaField name="description" label="Description" placeholder="Scope, assumptions and test data" />
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
