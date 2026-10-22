import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActionButton } from "@/components/forms/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { formatDateTime, humanize, pluralize } from "@/lib/utils";
import { NotFoundError } from "@/modules/access/service";
import { requireActor } from "@/modules/auth/session";
import { addInventoryDocumentAction, requestSourceAnalysisAction, syncDiscoveryInventoryAction } from "@/modules/inventory/actions";
import { InventoryDocumentForm, SourceAnalysisForm } from "@/modules/inventory/components/inventory-forms";
import { COVERAGE_DISCLAIMER, type CoverageLevel } from "@/modules/coverage/mapping";
import { getInventory } from "@/modules/inventory/queries";

export const metadata: Metadata = { title: "Inventory" };

export default function InventoryPage({ params }: PageProps<"/applications/[applicationId]/inventory">) {
  return (
    <Suspense fallback={<CardSkeleton rows={6} />}>
      <Inventory params={params} />
    </Suspense>
  );
}

const KINDS = ["ROUTE", "API_ENDPOINT", "ROLE", "REQUIREMENT", "WORKFLOW"] as const;
const LEVEL_TONE: Record<CoverageLevel, "success" | "info" | "warning" | "neutral" | "danger"> = { VERIFIED: "success", EXECUTED: "info", EXERCISED: "warning", PLANNED: "neutral", NOT_PLANNED: "danger" };
const LEVEL_HINT: Record<CoverageLevel, string> = {
  VERIFIED: "An approved case with assertions targets it and passed in its latest run",
  EXECUTED: "Targeted by an approved case that ran, but didn't pass",
  EXERCISED: "Reached at runtime, but no approved case targets it with assertions",
  PLANNED: "Targeted by an approved case that hasn't run yet",
  NOT_PLANNED: "No approved case targets it",
};

async function Inventory({ params }: { params: PageProps<"/applications/[applicationId]/inventory">["params"] }) {
  const actor = await requireActor();
  const { applicationId } = await params;
  let data;
  try {
    data = await getInventory(actor, applicationId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { application, items, documents, analyses, permissions, coverageSummary } = data;
  const active = items.filter((i) => i.active);

  return (
    <>
      <PageHeader
        backHref={`/applications/${application.id}`}
        backLabel={application.name}
        title="Inventory"
        description="What this application is known to contain, from its OpenAPI specs, requirements, repository and discovery. Coverage is measured against this list only; anything the sources don't mention isn't counted."
      />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {KINDS.map((kind) => (
          <div key={kind} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{humanize(kind)}s</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{active.filter((i) => i.kind === kind).length}</p>
          </div>
        ))}
      </div>

      <Card className="mb-6">
        <CardHeader title="Coverage of the known inventory" description={`${coverageSummary.byLevel.VERIFIED} of ${coverageSummary.known} known items verified`} />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            {(["VERIFIED", "EXECUTED", "EXERCISED", "PLANNED", "NOT_PLANNED"] as const).map((level) => (
              <span key={level} title={LEVEL_HINT[level]} className="inline-flex items-center gap-1">
                <StatusBadge status={humanize(level)} tone={LEVEL_TONE[level]} /> {coverageSummary.byLevel[level]}
              </span>
            ))}
          </div>
          <p className="text-xs text-zinc-500">
            {Object.entries(coverageSummary.byKind)
              .map(([kind, k]) => `${humanize(kind)}s: ${k.verified}/${k.known} verified, ${k.planned}/${k.known} planned`)
              .join(" · ")}
          </p>
          <p className="text-xs text-zinc-500">{COVERAGE_DISCLAIMER}</p>
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Items" description={`${pluralize(active.length, "active item")}${items.length > active.length ? ` · ${items.length - active.length} no longer listed by any source` : ""}`} />
            {items.length === 0 ? (
              <EmptyState title="Nothing known yet" description="Add an OpenAPI spec or requirements, analyse the repository, or run discovery." />
            ) : (
              <Table>
                <THead columns={["Kind", "Item", "Coverage", "Sources", "Confidence", "Auth"]} />
                <TBody>
                  {items.map((item) => (
                    <tr key={item.id} className={item.active ? "" : "opacity-50"}>
                      <TD className="whitespace-nowrap text-xs">{humanize(item.kind)}</TD>
                      <TD>
                        <p className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{item.key}</p>
                        {item.title !== item.key ? <p className="text-xs text-zinc-500">{item.title}</p> : null}
                        {item.roles.length ? <p className="text-xs text-zinc-500">Roles: {item.roles.join(", ")}</p> : null}
                      </TD>
                      <TD className="text-xs">
                        {item.active && item.coverage ? (
                          <>
                            <span title={LEVEL_HINT[item.coverage.level]}>
                              <StatusBadge status={humanize(item.coverage.level)} tone={LEVEL_TONE[item.coverage.level]} />
                            </span>
                            {item.coverage.cases.slice(0, 3).map((c) => (
                              <p key={c.caseKey} className="mt-1 max-w-56 truncate text-zinc-500" title={`${c.suite} v${c.version}: ${c.title}`}>
                                {c.title} · {c.status ? humanize(c.status) : "not run"}
                              </p>
                            ))}
                            {item.coverage.cases.length > 3 ? <p className="text-zinc-500">+{item.coverage.cases.length - 3} more</p> : null}
                            {!item.coverage.cases.length && item.coverage.exercisedBy.length ? <p className="mt-1 max-w-56 truncate text-zinc-500">Reached by {item.coverage.exercisedBy[0]}</p> : null}
                          </>
                        ) : (
                          "—"
                        )}
                      </TD>
                      <TD className="text-xs text-zinc-500">
                        {[...new Set(item.sources.map((s) => humanize(s.source)))].join(", ") || "—"}
                        <p className="max-w-56 truncate" title={item.sources.map((s) => s.ref).join("\n")}>{item.sources[0]?.ref}</p>
                      </TD>
                      <TD><StatusBadge status={item.confidence} tone={item.confidence === "HIGH" ? "success" : item.confidence === "MEDIUM" ? "info" : "neutral"} /></TD>
                      <TD className="text-xs">{item.protected === null ? "—" : item.protected ? "Required" : "Public"}</TD>
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
              <CardHeader title="Add a document" description="Stored verbatim for traceability and parsed as data." />
              <CardBody>
                <InventoryDocumentForm action={addInventoryDocumentAction.bind(null, application.id)} />
              </CardBody>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Repository" description={application.repoUrl ? `${application.repoUrl}${application.repoBranch ? ` · ${application.repoBranch}` : ""}` : "No repository configured on the application"} />
            <CardBody className="space-y-4">
              {permissions.update && application.repoUrl ? <SourceAnalysisForm action={requestSourceAnalysisAction.bind(null, application.id)} secretNames={application.secrets.map((s) => s.name)} /> : null}
              {analyses.length ? (
                <ul className="space-y-2 text-xs">
                  {analyses.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={a.status} />
                      <span className="text-zinc-500">{formatDateTime(a.createdAt)}</span>
                      {a.commitSha ? <span className="font-mono">{a.commitSha.slice(0, 10)}</span> : null}
                      {a.stats ? <span className="text-zinc-500">{(a.stats as { files: number }).files} files</span> : null}
                      {a.errorMessage ? <span className="text-red-600">{a.errorMessage}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Sources" />
            <CardBody className="space-y-3 text-xs">
              {documents.length === 0 ? <p className="text-zinc-500">No documents yet.</p> : null}
              {documents.map((d) => (
                <p key={d.id}>
                  <span className="font-medium">{d.name}</span> · {humanize(d.source)} · {pluralize(d.itemCount, "item")} · {formatDateTime(d.createdAt)}
                  {d.createdBy ? ` by ${d.createdBy.name}` : ""}
                </p>
              ))}
              {permissions.update ? <ActionButton action={syncDiscoveryInventoryAction.bind(null, application.id)}>Sync routes from latest discovery</ActionButton> : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
