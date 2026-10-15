import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { formatDate } from "@/lib/utils";
import { canCreateProject } from "@/modules/access/policy";
import { requireActor } from "@/modules/auth/session";
import { createProject } from "@/modules/projects/actions";
import { ProjectForm } from "@/modules/projects/components/project-form";
import { listProjects } from "@/modules/projects/service";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <>
      <PageHeader title="Projects" description="Group the applications you test and control who can access them." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Suspense fallback={<CardSkeleton />}>
            <ProjectsTable />
          </Suspense>
        </div>
        <Suspense fallback={<CardSkeleton rows={3} />}>
          <NewProjectCard />
        </Suspense>
      </div>
    </>
  );
}

async function ProjectsTable() {
  const actor = await requireActor();
  const projects = await listProjects(actor);

  return (
    <Card>
      <CardHeader title="Your projects" description={`${projects.length} total`} />
      {projects.length === 0 ? (
        <EmptyState title="No projects yet" description="Create a project, or ask a project owner to add you." />
      ) : (
        <Table>
          <THead columns={["Name", "Applications", "Members", "Status", "Created"]} />
          <TBody>
            {projects.map((project) => (
              <tr key={project.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                <TD>
                  <Link href={`/projects/${project.id}`} className="font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100">
                    {project.name}
                  </Link>
                  {project.description ? (
                    <p className="line-clamp-1 text-xs text-zinc-500 dark:text-zinc-400">{project.description}</p>
                  ) : null}
                </TD>
                <TD className="tabular-nums">{project._count.applications}</TD>
                <TD className="tabular-nums">{project._count.members}</TD>
                <TD>
                  <StatusBadge status={project.status} />
                </TD>
                <TD className="whitespace-nowrap">{formatDate(project.createdAt)}</TD>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

async function NewProjectCard() {
  const actor = await requireActor();
  if (!canCreateProject(actor.role)) return null;
  return (
    <Card>
      <CardHeader title="New project" description="You'll be its owner." />
      <CardBody>
        <ProjectForm action={createProject} submitLabel="Create project" />
      </CardBody>
    </Card>
  );
}
