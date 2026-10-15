import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { createApplication } from "@/modules/applications/actions";
import { ApplicationForm } from "@/modules/applications/components/application-form";
import { listApplications } from "@/modules/applications/service";
import { requireActor } from "@/modules/auth/session";
import { listProjectsForNewApplications } from "@/modules/projects/service";

export const metadata: Metadata = { title: "Applications" };

export default function ApplicationsPage({ searchParams }: PageProps<"/applications">) {
  return (
    <>
      <PageHeader title="Applications" description="The systems under test and the URLs the agent is authorized to test." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Suspense fallback={<CardSkeleton />}>
            <ApplicationsTable />
          </Suspense>
        </div>
        <Suspense fallback={<CardSkeleton rows={6} />}>
          <NewApplicationCard searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

async function ApplicationsTable() {
  const actor = await requireActor();
  const applications = await listApplications(actor);

  return (
    <Card>
      <CardHeader title="All applications" description={`${applications.length} total`} />
      {applications.length === 0 ? (
        <EmptyState title="No applications yet" description="Register an application to start discovery and test planning." />
      ) : (
        <Table>
          <THead columns={["Name", "Project", "Environment", "Repository", "Suites"]} />
          <TBody>
            {applications.map((app) => (
              <tr key={app.id}>
                <TD>
                  <Link href={`/applications/${app.id}`} className="font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100">
                    {app.name}
                  </Link>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{app.authorizedUrl}</p>
                </TD>
                <TD>
                  <Link href={`/projects/${app.project.id}`} className="hover:text-indigo-600">
                    {app.project.name}
                  </Link>
                </TD>
                <TD>
                  <StatusBadge status={app.environment} />
                </TD>
                <TD className="max-w-48 truncate text-xs">
                  {app.repoUrl ? (
                    <>
                      {app.repoUrl.replace(/^https:\/\/|^ssh:\/\/|^git@/, "")}
                      {app.repoBranch ? <span className="text-zinc-400"> @ {app.repoBranch}</span> : null}
                    </>
                  ) : (
                    <span className="text-zinc-400">—</span>
                  )}
                </TD>
                <TD className="tabular-nums">{app._count.testSuites}</TD>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

async function NewApplicationCard({ searchParams }: { searchParams: PageProps<"/applications">["searchParams"] }) {
  const actor = await requireActor();
  const [{ project }, projects] = await Promise.all([searchParams, listProjectsForNewApplications(actor)]);
  const preselected = typeof project === "string" && projects.some((p) => p.id === project) ? project : undefined;

  return (
    <Card>
      <CardHeader title="New application" />
      <CardBody>
        {projects.length === 0 ? (
          <EmptyState
            title="No projects you can add to"
            description="You need the Owner or Editor role on an active project to add applications."
            action={<LinkButton href="/projects">Go to projects</LinkButton>}
          />
        ) : (
          <ApplicationForm
            action={createApplication}
            projects={projects}
            defaults={{ projectId: preselected }}
            submitLabel="Create application"
          />
        )}
      </CardBody>
    </Card>
  );
}
