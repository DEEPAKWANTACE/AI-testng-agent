import "server-only";
import { db } from "@/lib/db";
import { can } from "@/modules/access/policy";
import { projectScope } from "@/modules/access/service";
import type { Actor } from "@/modules/auth/service";
import { diffSnapshots, parsePlanSnapshot, type PlanSnapshot } from "@/modules/test-suites/snapshot";

const approvalInclude = {
  reviewer: { select: { name: true } },
  requestedBy: { select: { id: true, name: true } },
  planVersion: {
    select: {
      id: true,
      version: true,
      caseCount: true,
      contentHash: true,
      snapshot: true,
      snapshotFormat: true,
      changeSummary: true,
      suite: {
        select: {
          id: true,
          name: true,
          kind: true,
          application: { select: { name: true, projectId: true, authorizedUrl: true, environment: true, project: { select: { name: true } } } },
        },
      },
    },
  },
} as const;

const visible = (actor: Actor) => ({ planVersion: { suite: { application: { project: projectScope(actor) } } } });

const snapshotOf = (v: { snapshot: unknown; snapshotFormat: number }) => (v.snapshotFormat === 2 ? (parsePlanSnapshot(2, v.snapshot).snapshot as PlanSnapshot) : null);

/** Pending requests with the content under review and what changed since the last approval. */
export async function listPendingApprovals(actor: Actor) {
  const approvals = await db().approval.findMany({ where: { status: "PENDING", ...visible(actor) }, orderBy: { requestedAt: "asc" }, include: approvalInclude });
  const memberships = await db().projectMember.findMany({ where: { userId: actor.id }, select: { projectId: true, role: true } });
  const roles = new Map(memberships.map((m) => [m.projectId, m.role]));

  return Promise.all(
    approvals.map(async (approval) => {
      const role = roles.get(approval.planVersion.suite.application.projectId) ?? null;
      const ownRequest = approval.requestedBy?.id === actor.id;
      const snapshot = snapshotOf(approval.planVersion);
      const previous = await db().planVersion.findFirst({
        where: { suiteId: approval.planVersion.suite.id, status: { in: ["APPROVED", "SUPERSEDED"] }, version: { lt: approval.planVersion.version } },
        orderBy: { version: "desc" },
        select: { version: true, snapshot: true, snapshotFormat: true },
      });
      return {
        ...approval,
        snapshot,
        previousVersion: previous?.version ?? null,
        diff: snapshot ? diffSnapshots(previous ? snapshotOf(previous) : null, snapshot) : null,
        canDecide: can(actor.role, role, "plan.review") && !ownRequest,
        ownRequest,
      };
    }),
  );
}

export function listRecentDecisions(actor: Actor, limit = 20) {
  return db().approval.findMany({
    where: { status: { not: "PENDING" }, ...visible(actor) },
    orderBy: { decidedAt: "desc" },
    take: limit,
    include: { reviewer: { select: { name: true } }, planVersion: { select: { version: true, contentHash: true, suite: { select: { id: true, name: true } } } } },
  });
}
