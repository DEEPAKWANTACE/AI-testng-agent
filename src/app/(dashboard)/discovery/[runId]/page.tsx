import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActionButton } from "@/components/forms/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDateTime, humanize, pluralize } from "@/lib/utils";
import { requireActor } from "@/modules/auth/session";
import { cancelDiscoveryRun } from "@/modules/discovery/actions";
import { countElements } from "@/modules/discovery/page-elements";
import { getDiscoveryRun } from "@/modules/discovery/queries";

export default function DiscoveryRunPage({ params }: PageProps<"/discovery/[runId]">) {
  return (
    <Suspense
      fallback={
        <>
          <Skeleton className="mb-6 h-8 w-64" />
          <CardSkeleton rows={6} />
        </>
      }
    >
      <RunDetail params={params} />
    </Suspense>
  );
}

function duration(start: Date | null, end: Date | null) {
  if (!start || !end) return "—";
  const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

async function RunDetail({ params }: { params: PageProps<"/discovery/[runId]">["params"] }) {
  const actor = await requireActor();
  const { runId } = await params;
  const run = await getDiscoveryRun(actor, runId);
  if (!run) notFound();

  const { stats } = run;
  const active = run.status === "QUEUED" || run.status === "RUNNING";
  const blocked = [
    ...(stats.redirectsBlocked ?? []).map((r) => ({ target: r.to, detail: `Redirect from ${r.from} was not followed` })),
    ...(stats.blockedRequests ?? []).map((b) => ({ target: b.target, detail: b.detail })),
  ];
  const tiles = [
    { label: "Pages", value: run.pagesVisited },
    { label: "Features", value: run.features.length },
    { label: "Forms", value: stats.totals?.forms ?? 0 },
    { label: "Inputs", value: stats.totals?.inputs ?? 0 },
    { label: "Buttons", value: stats.totals?.buttons ?? 0 },
    { label: "Blocked requests", value: blocked.length },
  ];

  return (
    <>
      <PageHeader
        backHref="/discovery"
        backLabel="Discovery"
        title={
          <span className="flex flex-wrap items-center gap-3">
            Discovery of {run.application.name} <StatusBadge status={run.status} />
          </span>
        }
        description={
          <>
            {run.startUrl} · depth {run.maxDepth} · up to {run.maxPages} pages · queued {formatDateTime(run.createdAt)}
            {run.triggeredBy ? ` by ${run.triggeredBy.name}` : null} · took {duration(run.startedAt, run.finishedAt)}
          </>
        }
        actions={
          active && run.permissions.manage ? (
            <ActionButton action={cancelDiscoveryRun.bind(null, run.id)} confirmMessage="Cancel this discovery run?">
              Cancel run
            </ActionButton>
          ) : null
        }
      />

      {run.errorMessage ? (
        <div role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
          {run.errorMessage}
        </div>
      ) : run.summary ? (
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">{run.summary}</p>
      ) : active ? (
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          {run.status === "QUEUED" ? "Waiting for the discovery worker…" : `Crawling — ${pluralize(run.pagesVisited, "page")} so far.`} Refresh to see progress.
        </p>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{tile.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{tile.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Pages" description="Each page's screenshot and the elements found on it. Field values are never recorded." />
            {run.pages.length === 0 ? (
              <EmptyState title="No pages yet" />
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {run.pages.map((page) => {
                  const counts = countElements(page.elements);
                  const screenshot = page.artifacts[0];
                  return (
                    <li key={page.id} className="px-5 py-4">
                      <div className="flex gap-4">
                        {screenshot ? (
                          <a href={`/api/artifacts/${screenshot.id}`} target="_blank" rel="noreferrer" className="shrink-0">
                            {/* eslint-disable-next-line @next/next/no-img-element -- authenticated artifact route, not a static asset */}
                            <img
                              src={`/api/artifacts/${screenshot.id}`}
                              alt={`Screenshot of ${page.title ?? page.url}`}
                              width={160}
                              height={100}
                              loading="lazy"
                              className="h-[100px] w-[160px] rounded border border-zinc-200 object-cover object-top dark:border-zinc-700"
                            />
                          </a>
                        ) : (
                          <div className="grid h-[100px] w-[160px] shrink-0 place-items-center rounded border border-dashed border-zinc-300 text-xs text-zinc-400 dark:border-zinc-700">
                            No screenshot
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            {page.title ?? "Untitled"}
                            {page.statusCode ? <StatusBadge status={String(page.statusCode)} tone={page.statusCode < 400 ? "success" : "danger"} /> : null}
                            {page.feature ? <span className="text-xs font-normal text-zinc-500">{page.feature.name}</span> : null}
                          </p>
                          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{page.url}</p>
                          {page.error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{page.error}</p> : null}
                          <p className="mt-1 text-xs text-zinc-500">
                            depth {page.depth} · {page.loadTimeMs ?? "—"} ms · {pluralize(counts.links, "link")} · {pluralize(counts.forms, "form")} ·{" "}
                            {pluralize(counts.inputs, "input")} · {pluralize(counts.buttons, "button")}
                          </p>
                          {counts.forms + counts.inputs + counts.navigation > 0 ? (
                            <details className="mt-2 text-xs">
                              <summary className="cursor-pointer text-indigo-600">Elements</summary>
                              <div className="mt-2 space-y-2 text-zinc-600 dark:text-zinc-400">
                                {page.elements.navigation.map((nav, i) => (
                                  <p key={`nav-${i}`}>
                                    <span className="font-medium text-zinc-800 dark:text-zinc-200">Navigation “{nav.label}”:</span>{" "}
                                    {nav.links.map((l) => l.text || l.href).join(" · ")}
                                  </p>
                                ))}
                                {page.elements.forms.map((form, i) => (
                                  <p key={`form-${i}`}>
                                    <span className="font-medium text-zinc-800 dark:text-zinc-200">
                                      Form{form.name ? ` “${form.name}”` : ""} ({form.method}
                                      {form.action ? ` ${new URL(form.action).pathname}` : ""}):
                                    </span>{" "}
                                    {form.fields.map((f) => `${f.label ?? f.name ?? f.type} [${f.type}${f.required ? ", required" : ""}]`).join(", ") || "no fields"}
                                    {form.submitLabels.length ? ` → ${form.submitLabels.join(" / ")}` : ""}
                                  </p>
                                ))}
                                {page.elements.inputs.length ? (
                                  <p>
                                    <span className="font-medium text-zinc-800 dark:text-zinc-200">Standalone inputs:</span>{" "}
                                    {page.elements.inputs.map((f) => f.label ?? f.name ?? f.type).join(", ")}
                                  </p>
                                ) : null}
                                {page.elements.buttons.length ? (
                                  <p>
                                    <span className="font-medium text-zinc-800 dark:text-zinc-200">Buttons:</span>{" "}
                                    {page.elements.buttons.map((b) => b.text || b.type).join(", ")}
                                  </p>
                                ) : null}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Features found" description="Saved to the application" />
            {run.features.length === 0 ? (
              <EmptyState title="No features yet" />
            ) : (
              <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {run.features.map((feature) => (
                  <li key={feature.id} className="px-5 py-3">
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{feature.name}</p>
                    <p className="text-xs text-zinc-500">{feature.description}</p>
                  </li>
                ))}
              </ul>
            )}
            <CardBody className="border-t border-zinc-200 text-xs dark:border-zinc-800">
              <Link href={`/applications/${run.application.id}`} className="text-indigo-600 hover:text-indigo-500">
                View {run.application.name} →
              </Link>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Blocked by egress policy" description="Requests and redirects the worker refused" />
            {blocked.length === 0 ? (
              <EmptyState title="Nothing blocked" />
            ) : (
              <ul className="divide-y divide-zinc-100 text-xs dark:divide-zinc-800">
                {blocked.map((entry, i) => (
                  <li key={i} className="px-5 py-2.5">
                    <p className="font-mono break-all text-zinc-800 dark:text-zinc-200">{entry.target}</p>
                    <p className="text-zinc-500">{entry.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Run details" />
            <CardBody className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
              <p>Signed in: {stats.authenticated ? "yes" : "no"}</p>
              <p>Stopped: {stats.stoppedBy ? humanize(stats.stoppedBy) : "—"}</p>
              {stats.skippedLinks ? (
                <p>
                  Skipped links:{" "}
                  {Object.entries(stats.skippedLinks)
                    .filter(([, n]) => n > 0)
                    .map(([reason, n]) => `${humanize(reason)} ${n}`)
                    .join(" · ") || "none"}
                </p>
              ) : null}
              {run.artifacts.map((artifact) => (
                <p key={artifact.id}>
                  <a href={`/api/artifacts/${artifact.id}`} className="text-indigo-600 hover:text-indigo-500">
                    {artifact.name}
                  </a>
                </p>
              ))}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
