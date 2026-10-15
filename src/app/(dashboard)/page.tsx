import Link from "next/link";
import { Suspense } from "react";
import { LinkButton } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDateTime } from "@/lib/utils";
import { getDashboardOverview } from "@/modules/dashboard/queries";
import { requireActor } from "@/modules/auth/session";

const workflow = [
  { step: "Project", href: "/projects" },
  { step: "Application", href: "/applications" },
  { step: "Discovery", href: "/discovery" },
  { step: "Test suite", href: "/test-plans" },
  { step: "Plan version", href: "/test-plans" },
  { step: "Approval", href: "/approvals" },
  { step: "Test run", href: "/test-runs" },
  { step: "Report", href: "/reports" },
];

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="Track QA work from application discovery through approved test runs and reports."
        actions={<LinkButton href="/test-plans">New test plan</LinkButton>}
      />
      <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
        {workflow.map((item, index) => (
          <li key={item.step} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden="true">→</span> : null}
            <Link href={item.href} className="hover:text-indigo-600">
              {item.step}
            </Link>
          </li>
        ))}
      </ol>
      <Suspense fallback={<OverviewSkeleton />}>
        <OverviewContent />
      </Suspense>
    </>
  );
}

async function OverviewContent() {
  const actor = await requireActor();
  const { counts, recentRuns, recentSuites } = await getDashboardOverview(actor);

  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Active projects" value={counts.projects} hint={`${counts.applications} applications`} href="/projects" />
        <StatCard label="Test suites" value={counts.suites} hint={`${counts.discoveryQueued} discovery queued`} href="/test-plans" />
        <StatCard label="Awaiting approval" value={counts.pendingApprovals} href="/approvals" />
        <StatCard label="Queued runs" value={counts.queuedRuns} hint={`${counts.openDefects} open defects`} href="/test-runs" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recently updated suites" />
          {recentSuites.length === 0 ? (
            <EmptyState title="No test suites yet" action={<LinkButton href="/projects" variant="secondary">Start with a project</LinkButton>} />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {recentSuites.map((suite) => (
                <li key={suite.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <Link href={`/test-plans/${suite.id}`} className="block truncate text-sm font-medium hover:text-indigo-600">
                      {suite.name}
                    </Link>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{suite.application.name}</p>
                  </div>
                  {suite.planVersions[0] ? (
                    <StatusBadge status={suite.planVersions[0].status} />
                  ) : (
                    <StatusBadge status="DRAFT" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Recent test runs" />
          {recentRuns.length === 0 ? (
            <EmptyState title="No test runs yet" description="Runs appear here once an approved plan is queued." />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {recentRuns.map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/test-plans/${run.planVersion.suite.id}`}
                      className="block truncate text-sm font-medium hover:text-indigo-600"
                    >
                      {run.planVersion.suite.name} v{run.planVersion.version}
                    </Link>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">Queued {formatDateTime(run.createdAt)}</p>
                  </div>
                  <StatusBadge status={run.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    </>
  );
}
