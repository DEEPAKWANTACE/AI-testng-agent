import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

/**
 * Append-only, hash-chained audit log. Each entry's hash covers its content and the previous
 * entry's hash, so editing or removing history is detectable (`verifyAuditChain`); a database
 * trigger also rejects UPDATE/DELETE. Appends are serialised with an advisory lock.
 */

export type AuditAction =
  | "generation.requested"
  | "generation.completed"
  | "generation.failed"
  | "case.created"
  | "case.edited"
  | "case.reviewed"
  | "case.archived"
  | "plan.submitted"
  | "plan.approved"
  | "plan.rejected"
  | "run.queued"
  | "run.started"
  | "run.finished"
  | "run.blocked"
  | "run.cancelled"
  | "run.retry"
  | "regression.created"
  | "defect.verified"
  | "baseline.approved"
  | "baseline.rejected"
  | "inventory.updated"
  | "inventory.analysis.requested"
  | "inventory.analysis.finished"
  | "mutation.requested"
  | "mutation.finished"
  | "report.downloaded"
  | "autotest.started";

export type AuditEntry = {
  actor: { id: string; email: string } | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  projectId?: string | null;
  data?: Record<string, unknown>;
};

type Client = Prisma.TransactionClient | ReturnType<typeof db>;
const AUDIT_LOCK = 4242_0001;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function auditEntryHash(prevHash: string | null, entry: { createdAt: Date; actorId: string | null; action: string; entityType: string; entityId: string; projectId: string | null; data: unknown }) {
  return createHash("sha256")
    .update(prevHash ?? "genesis")
    .update("\n")
    .update(canonical({ ...entry, createdAt: entry.createdAt.toISOString() }))
    .digest("hex");
}

async function appendWith(tx: Prisma.TransactionClient, entry: AuditEntry) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK})`;
  const last = await tx.auditLog.findFirst({ orderBy: { id: "desc" }, select: { hash: true } });
  const createdAt = new Date();
  const record = {
    createdAt,
    actorId: entry.actor?.id ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    projectId: entry.projectId ?? null,
    data: (entry.data ?? null) as Prisma.InputJsonValue | null,
  };
  const prevHash = last?.hash ?? null;
  await tx.auditLog.create({
    data: {
      ...record,
      data: record.data ?? undefined,
      actorEmail: entry.actor?.email ?? null,
      prevHash,
      hash: auditEntryHash(prevHash, record),
    },
  });
}

/** Appends an entry, inside the caller's transaction when one is passed. */
export async function audit(entry: AuditEntry, client?: Client): Promise<void> {
  if (client && "$transaction" in client) {
    await client.$transaction((tx) => appendWith(tx, entry));
  } else if (client) {
    await appendWith(client as Prisma.TransactionClient, entry);
  } else {
    await db().$transaction((tx) => appendWith(tx, entry));
  }
}

/** Recomputes the chain; returns the id of the first broken entry, or null if intact. */
export async function verifyAuditChain(): Promise<{ ok: true; entries: number } | { ok: false; brokenAt: string }> {
  const entries = await db().auditLog.findMany({ orderBy: { id: "asc" } });
  let prev: string | null = null;
  for (const e of entries) {
    const expected = auditEntryHash(prev, {
      createdAt: e.createdAt,
      actorId: e.actorId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      projectId: e.projectId,
      data: e.data,
    });
    if (e.prevHash !== prev || e.hash !== expected) return { ok: false, brokenAt: e.id.toString() };
    prev = e.hash;
  }
  return { ok: true, entries: entries.length };
}
