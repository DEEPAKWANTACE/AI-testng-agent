import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActionButton } from "@/components/forms/action-button";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { formatDate, formatDateTime, humanize } from "@/lib/utils";
import { deleteApplication, updateApplication } from "@/modules/applications/actions";
import { ApplicationForm } from "@/modules/applications/components/application-form";
import { DiscoveryAuthCard } from "@/modules/applications/components/discovery-auth-form";
import { GenerationCard, RegressionCard } from "@/modules/applications/components/test-design-cards";
import { db } from "@/lib/db";
import { getGenerationJobsForApplication } from "@/modules/generation/service";
import { providerFromEnv } from "@/modules/generation/providers";
import { listApprovedCases } from "@/modules/regression/service";
import { SecretReferences } from "@/modules/applications/components/secret-references";
import { getApplication } from "@/modules/applications/service";
import { requireActor } from "@/modules/auth/session";
import { listProjectsForNewApplications } from "@/modules/projects/service";

export default function ApplicationPage({ params }: PageProps<"/applications/[applicationId]">) {
  return (
    <Suspense
      fallback={
        <>
          <Skeleton className="mb-6 h-8 w-64" />
          <CardSkeleton rows={5} />
        </>
      }
    >
      <ApplicationDetail params={params} />
    </Suspense>
  );
}

async function ApplicationDetail({ params }: { params: PageProps<"/applications/[applicationId]">["params"] }) {
  const actor = await requireActor();
  const { applicationId } = await params;
  const application = await getApplication(actor, applicationId);
  if (!application) notFound();

  const { permissions } = application;
  const [projects, generationJobs, draftSuites, approvedCases] = permissions.update
    ? await Promise.all([
        listProjectsForNewApplications(actor),
        getGenerationJobsForApplication(application.id),
        db().testSuite.findMany({
          where: { applicationId: application.id, status: "ACTIVE", kind: "STANDARD", planVersions: { none: { status: "PENDING_APPROVAL" } } },
          orderBy: { updatedAt: "desc" },
          select: { id: true, name: true },
        }),
        listApprovedCases(application.id),
      ])
    : [[], [], [], []];
  let providerName = "heuristic";
  try {
    providerName = providerFromEnv().name;
  } catch {
    providerName = "misconfigured";
  }
  // Keep the current project selectable even if the actor can't add apps to it any more.
  const projectOptions = projects.some((p) => p.id === application.project.id) ? projects : [application.project, ...projects];

  return (
    <>
      <PageHeader
        backHref="/applications"
        backLabel="Applications"
        title={
          <span className="flex flex-wrap items-center gap-3">
            {application.name} <StatusBadge status={application.environment} />
          </span>
        }
        description={
          <>
            {humanize(application.type)} app in{" "}
            <Link href={`/projects/${application.project.id}`} className="font-medium hover:text-indigo-600">
              {application.project.name}
            </Link>
          </>
        }
        actions={
          <div className="flex flex-wrap items-start gap-2">
            <LinkButton href={`/applications/${application.id}/inventory`} variant="secondary">
              Inventory &amp; coverage
            </LinkButton>
            {permissions.delete ? (
              <ActionButton
                action={deleteApplication.bind(null, application.id)}
                variant="danger"
                confirmMessage={`Delete "${application.name}" with its secret references, features, suites and runs?`}
              >
                Delete
              </ActionButton>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Configuration" />
            <CardBody>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-zinc-500">Authorized URL</dt>
                  <dd className="mt-0.5 break-all text-zinc-900 dark:text-zinc-100">{application.authorizedUrl}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Environment</dt>
                  <dd className="mt-0.5 text-zinc-900 dark:text-zinc-100">{humanize(application.environment)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Repository</dt>
                  <dd className="mt-0.5 break-all text-zinc-900 dark:text-zinc-100">{application.repoUrl ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Branch</dt>
                  <dd className="mt-0.5 text-zinc-900 dark:text-zinc-100">
                    {application.repoBranch ?? (application.repoUrl ? "Default branch" : "—")}
                  </dd>
                </div>
              </dl>
              {application.description ? (
                <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">{application.description}</p>
              ) : null}
            </CardBody>
          </Card>

          <SecretReferences
            applicationId={application.id}
            secrets={application.secrets}
            canManage={permissions.manageSecrets}
          />

          <DiscoveryAuthCard
            applicationId={application.id}
            authorizedUrl={application.authorizedUrl}
            config={application.discoveryAuth}
            secrets={application.secrets}
            canManage={permissions.manageSecrets}
          />

          <Card>
            <CardHeader
              title="Test suites"
              actions={
                permissions.update ? (
                  <LinkButton href={`/test-plans?application=${application.id}`} size="sm">
                    New test suite
                  </LinkButton>
                ) : null
              }
            />
            {application.testSuites.length === 0 ? (
              <EmptyState title="No test suites yet" description="Create a suite to describe what should be tested." />
            ) : (
              <Table>
                <THead columns={["Suite", "Cases", "Latest plan", "Updated"]} />
                <TBody>
                  {application.testSuites.map((suite) => (
                    <tr key={suite.id}>
                      <TD>
                        <Link href={`/test-plans/${suite.id}`} className="font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100">
                          {suite.name}
                        </Link>
                      </TD>
                      <TD className="tabular-nums">{suite._count.testCases}</TD>
                      <TD>
                        {suite.planVersions[0] ? (
                          <span className="flex items-center gap-2">
                            <span className="text-zinc-500 tabular-nums">v{suite.planVersions[0].version}</span>
                            <StatusBadge status={suite.planVersions[0].status} />
                          </span>
                        ) : (
                          <span className="text-zinc-400">Not submitted</span>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap">{formatDate(suite.updatedAt)}</TD>
                    </tr>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Discovery runs"
              description="Most recent 10"
              actions={
                permissions.update ? (
                  <LinkButton href={`/discovery?application=${application.id}`} size="sm" variant="secondary">
                    New run
                  </LinkButton>
                ) : null
              }
            />
            {application.discoveryRuns.length === 0 ? (
              <EmptyState title="No discovery runs yet" />
            ) : (
              <Table>
                <THead columns={["Start URL", "Depth", "Features", "Status", "Created"]} />
                <TBody>
                  {application.discoveryRuns.map((run) => (
                    <tr key={run.id}>
                      <TD className="max-w-64 truncate">
                        <Link href={`/discovery/${run.id}`} className="hover:text-indigo-600">
                          {run.startUrl}
                        </Link>
                      </TD>
                      <TD className="tabular-nums">{run.maxDepth}</TD>
                      <TD className="tabular-nums">{run._count.features}</TD>
                      <TD>
                        <StatusBadge status={run.status} />
                      </TD>
                      <TD className="whitespace-nowrap">{formatDateTime(run.createdAt)}</TD>
                    </tr>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          {permissions.update ? (
            <Card>
              <CardHeader title="Edit application" />
              <CardBody>
                <ApplicationForm
                  action={updateApplication.bind(null, application.id)}
                  projects={projectOptions}
                  defaults={application}
                  submitLabel="Save changes"
                />
              </CardBody>
            </Card>
          ) : null}
          {permissions.update ? (
            <>
              <GenerationCard applicationId={application.id} features={application.features} suites={draftSuites} jobs={generationJobs} provider={providerName} />
              <RegressionCard applicationId={application.id} cases={approvedCases} />
            </>
          ) : null}
          <Card>
            <CardHeader title="Features" description="Functional areas, entered manually or found by discovery" />
            {application.features.length === 0 ? (
              <EmptyState title="No features yet" />
            ) : (
              <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {application.features.map((feature) => (
                  <li key={feature.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                    <span className="text-zinc-800 dark:text-zinc-200">{feature.name}</span>
                    <span className="text-xs text-zinc-500">{humanize(feature.source)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
