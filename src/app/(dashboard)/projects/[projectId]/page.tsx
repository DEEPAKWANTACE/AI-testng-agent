import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActionButton } from "@/components/forms/action-button";
import { ActionForm } from "@/components/forms/action-form";
import { SelectField, TextField } from "@/components/forms/fields";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { ProjectRole } from "@/generated/prisma/enums";
import { enumOptions, humanize } from "@/lib/utils";
import { requireActor } from "@/modules/auth/session";
import { addMember, deleteProject, removeMember, updateMemberRole, updateProject } from "@/modules/projects/actions";
import { ProjectForm } from "@/modules/projects/components/project-form";
import { getProject } from "@/modules/projects/service";

export default function ProjectPage({ params }: PageProps<"/projects/[projectId]">) {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <ProjectDetail params={params} />
    </Suspense>
  );
}

async function ProjectDetail({ params }: { params: PageProps<"/projects/[projectId]">["params"] }) {
  const actor = await requireActor();
  const { projectId } = await params;
  const project = await getProject(actor, projectId);
  if (!project) notFound();
  const { permissions } = project;

  return (
    <>
      <PageHeader
        backHref="/projects"
        backLabel="Projects"
        title={
          <span className="flex items-center gap-3">
            {project.name} <StatusBadge status={project.status} />
          </span>
        }
        description={
          <>
            {project.description ? `${project.description} · ` : null}
            Your role: {project.myRole ? humanize(project.myRole) : actor.role === "ADMIN" ? "Admin (all projects)" : "—"}
          </>
        }
        actions={
          permissions.delete ? (
            <ActionButton
              action={deleteProject.bind(null, project.id)}
              variant="danger"
              confirmMessage={`Delete "${project.name}" and all of its applications, suites and runs?`}
            >
              Delete project
            </ActionButton>
          ) : null
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Applications"
              description="Systems under test in this project"
              actions={
                permissions.createApplication && project.status === "ACTIVE" ? (
                  <LinkButton href={`/applications?project=${project.id}`} size="sm">
                    Add application
                  </LinkButton>
                ) : null
              }
            />
            {project.applications.length === 0 ? (
              <EmptyState title="No applications yet" description="Add the web app, API or mobile app you want to test." />
            ) : (
              <Table>
                <THead columns={["Name", "Environment", "Repository", "Suites"]} />
                <TBody>
                  {project.applications.map((app) => (
                    <tr key={app.id}>
                      <TD>
                        <Link href={`/applications/${app.id}`} className="font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100">
                          {app.name}
                        </Link>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">{app.authorizedUrl}</p>
                      </TD>
                      <TD>
                        <StatusBadge status={app.environment} />
                      </TD>
                      <TD className="max-w-48 truncate text-xs">{app.repoUrl ?? "—"}</TD>
                      <TD className="tabular-nums">{app._count.testSuites}</TD>
                    </tr>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="Members" description="Owners manage the project and its members; editors manage applications and tests; viewers read." />
            <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
              {project.members.map((member) => (
                <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">
                      {member.user.name}
                      {member.user.id === actor.id ? <span className="ml-1 font-normal text-zinc-500">(you)</span> : null}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{member.user.email}</p>
                  </div>
                  {permissions.members ? (
                    <div className="flex items-start gap-2">
                      <ActionForm action={updateMemberRole.bind(null, member.id)} submitLabel="Change" className="flex items-end gap-2 space-y-0">
                        <SelectField name="role" label="Role" options={enumOptions(ProjectRole)} defaultValue={member.role} />
                      </ActionForm>
                      <ActionButton
                        action={removeMember.bind(null, member.id)}
                        variant="ghost"
                        confirmMessage={`Remove ${member.user.name} from ${project.name}?`}
                      >
                        Remove
                      </ActionButton>
                    </div>
                  ) : (
                    <StatusBadge status={member.role} tone={member.role === "OWNER" ? "info" : "neutral"} />
                  )}
                </li>
              ))}
            </ul>
            {permissions.members ? (
              <CardBody className="border-t border-zinc-200 dark:border-zinc-800">
                <ActionForm action={addMember.bind(null, project.id)} submitLabel="Add member" pendingLabel="Adding…">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="sm:col-span-2">
                      <TextField name="email" label="Email" type="email" placeholder="teammate@example.com" autoComplete="off" />
                    </div>
                    <SelectField name="role" label="Role" options={enumOptions(ProjectRole)} defaultValue={ProjectRole.VIEWER} />
                  </div>
                </ActionForm>
              </CardBody>
            ) : null}
          </Card>
        </div>
        {permissions.update ? (
          <Card className="self-start">
            <CardHeader title="Project settings" />
            <CardBody>
              <ProjectForm action={updateProject.bind(null, project.id)} defaults={project} submitLabel="Save changes" />
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}

function DetailSkeleton() {
  return (
    <>
      <Skeleton className="mb-6 h-8 w-64" />
      <CardSkeleton rows={5} />
    </>
  );
}
