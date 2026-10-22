import "server-only";
import { db } from "@/lib/db";
import { can } from "@/modules/access/policy";
import { projectScope } from "@/modules/access/service";
import type { Actor } from "@/modules/auth/service";

const include = {
  application: { select: { id: true, name: true, projectId: true } },
  reviewer: { select: { name: true } },
} as const;

/** Baselines the actor can see: candidates awaiting review and the current approved images. */
export async function listBaselines(actor: Actor) {
  const where = { application: { project: projectScope(actor) } };
  const [pending, approved, memberships] = await Promise.all([
    db().visualBaseline.findMany({ where: { ...where, status: "PENDING" }, orderBy: { createdAt: "asc" }, include, take: 100 }),
    db().visualBaseline.findMany({ where: { ...where, status: "APPROVED" }, orderBy: { reviewedAt: "desc" }, include, take: 100 }),
    db().projectMember.findMany({ where: { userId: actor.id }, select: { projectId: true, role: true } }),
  ]);
  const roles = new Map(memberships.map((m) => [m.projectId, m.role]));
  // Case titles come from the most recent result for each case key.
  const keys = [...new Set([...pending, ...approved].map((b) => b.caseKey))];
  const titles = new Map(
    (await db().testResult.findMany({ where: { caseKey: { in: keys } }, orderBy: { createdAt: "desc" }, distinct: ["caseKey"], select: { caseKey: true, caseTitle: true } })).map((r) => [r.caseKey!, r.caseTitle]),
  );
  const withMeta = <T extends (typeof pending)[number]>(b: T) => ({
    ...b,
    caseTitle: titles.get(b.caseKey) ?? null,
    canReview: can(actor.role, roles.get(b.application.projectId) ?? null, "plan.review"),
    current: approved.find((a) => a.applicationId === b.applicationId && a.caseKey === b.caseKey && a.name === b.name && a.id !== b.id) ?? null,
  });
  return { pending: pending.map(withMeta), approved: approved.map(withMeta) };
}
