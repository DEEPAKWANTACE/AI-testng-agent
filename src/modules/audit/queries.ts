import "server-only";
import { db } from "@/lib/db";
import type { Actor } from "@/modules/auth/service";

/** Audit entries for projects the actor belongs to (admins see everything). */
export async function listAuditEntries(actor: Actor, options: { action?: string; limit?: number } = {}) {
  const projectIds =
    actor.role === "ADMIN" ? undefined : (await db().projectMember.findMany({ where: { userId: actor.id }, select: { projectId: true } })).map((m) => m.projectId);
  return db().auditLog.findMany({
    where: { ...(projectIds ? { projectId: { in: projectIds } } : {}), ...(options.action ? { action: { startsWith: options.action } } : {}) },
    orderBy: { id: "desc" },
    take: options.limit ?? 200,
  });
}
