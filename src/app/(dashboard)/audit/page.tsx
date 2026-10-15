import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, THead } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import { verifyAuditChain } from "@/modules/audit/audit";
import { listAuditEntries } from "@/modules/audit/queries";
import { requireActor } from "@/modules/auth/session";

export const metadata: Metadata = { title: "Audit log" };

export default function AuditPage({ searchParams }: PageProps<"/audit">) {
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only, hash-chained record of generation, review, approval and execution events in your projects."
      />
      <Suspense fallback={<CardSkeleton rows={8} />}>
        <AuditTable searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const FILTERS = ["generation", "case", "plan", "run", "regression", "report"] as const;

async function AuditTable({ searchParams }: { searchParams: PageProps<"/audit">["searchParams"] }) {
  const actor = await requireActor();
  const { action } = await searchParams;
  const filter = FILTERS.find((f) => f === action);
  const entries = await listAuditEntries(actor, { action: filter ? `${filter}.` : undefined });
  const chain = actor.role === "ADMIN" ? await verifyAuditChain() : null;

  return (
    <Card>
      <CardHeader
        title="Events"
        description={
          chain ? (chain.ok ? `Chain verified: ${chain.entries} entries intact.` : `Chain broken at entry ${chain.brokenAt} — the log may have been tampered with.`) : "Most recent 200"
        }
        actions={
          <form className="flex items-center gap-2 text-sm">
            <select name="action" defaultValue={filter ?? ""} aria-label="Filter by event type" className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950">
              <option value="">All events</option>
              {FILTERS.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <button className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Filter</button>
          </form>
        }
      />
      {entries.length === 0 ? (
        <EmptyState title="No events yet" />
      ) : (
        <Table>
          <THead columns={["When", "Actor", "Event", "Subject", "Details"]} />
          <TBody>
            {entries.map((e) => (
              <tr key={e.id.toString()}>
                <TD className="whitespace-nowrap text-xs">{formatDateTime(e.createdAt)}</TD>
                <TD className="text-xs">{e.actorEmail ?? "system (worker)"}</TD>
                <TD className="font-mono text-xs">{e.action}</TD>
                <TD className="text-xs">
                  {e.entityType}
                  <span className="block font-mono text-zinc-400">{e.entityId}</span>
                </TD>
                <TD className="max-w-md">
                  <code className="block truncate text-xs text-zinc-500" title={JSON.stringify(e.data)}>{e.data ? JSON.stringify(e.data) : "—"}</code>
                </TD>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
