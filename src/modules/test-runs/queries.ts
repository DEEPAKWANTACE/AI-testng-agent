import "server-only";
import { db } from "@/lib/db";
import { can } from "@/modules/access/policy";
import { getProjectRole, projectScope } from "@/modules/access/service";
import type { Actor } from "@/modules/auth/service";
import { loadReportData } from "@/modules/reports/build";

const visible = (actor: Actor) => ({ planVersion: { suite: { application: { project: projectScope(actor) } } } });

export function listTestRuns(actor: Actor) {
  return db().testRun.findMany({
    where: visible(actor),
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      planVersion: { select: { id: true, version: true, suite: { select: { id: true, name: true, kind: true, application: { select: { name: true } } } } } },
      report: { select: { passed: true, failed: true, errored: true, blocked: true, regressions: true } },
    },
  });
}

/** Approved (not superseded) plan versions in projects where the actor may manage runs. */
export function listRunnableVersions(actor: Actor) {
  if (actor.role === "VIEWER") return Promise.resolve([]);
  const project = actor.role === "ADMIN" ? {} : { members: { some: { userId: actor.id, role: { in: ["OWNER" as const, "EDITOR" as const] } } } };
  return db().planVersion.findMany({
    where: { status: "APPROVED", snapshotFormat: 2, suite: { status: "ACTIVE", application: { project } } },
    orderBy: { approvedAt: "desc" },
    select: { id: true, version: true, contentHash: true, suite: { select: { name: true, kind: true, application: { select: { name: true } } } } },
  });
}

/** Run + report data, or null when the actor can't see it. */
export async function getRunReport(actor: Actor, runId: string) {
  const data = await loadReportData(runId);
  if (!data) return null;
  const role = await getProjectRole(actor, data.planVersion.suite.application.projectId);
  if (!can(actor.role, role, "project.view")) return null;
  return { ...data, permissions: { manage: can(actor.role, role, "run.manage") } };
}

export function listReports(actor: Actor) {
  return db().testRun.findMany({
    where: { ...visible(actor), report: { isNot: null } },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      report: true,
      planVersion: { select: { version: true, suite: { select: { name: true, kind: true, application: { select: { name: true } } } } } },
    },
  });
}
