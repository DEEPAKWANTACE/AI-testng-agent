import "server-only";
import { db } from "@/lib/db";
import { projectScope } from "@/modules/access/service";
import type { Actor } from "@/modules/auth/service";

export async function getDashboardOverview(actor: Actor) {
  const client = db();
  const project = projectScope(actor);
  const app = { project };
  const suite = { application: app };
  const [projects, applications, discoveryQueued, suites, pendingApprovals, queuedRuns, openDefects, recentRuns, recentSuites] =
    await Promise.all([
      client.project.count({ where: { ...project, status: "ACTIVE" } }),
      client.application.count({ where: app }),
      client.discoveryRun.count({ where: { application: app, status: { in: ["QUEUED", "RUNNING"] } } }),
      client.testSuite.count({ where: { ...suite, status: "ACTIVE" } }),
      client.approval.count({ where: { planVersion: { suite }, status: "PENDING" } }),
      client.testRun.count({ where: { planVersion: { suite }, status: { in: ["QUEUED", "RUNNING"] } } }),
      client.defect.count({ where: { application: app, status: { in: ["OPEN", "IN_PROGRESS"] } } }),
      client.testRun.findMany({
        where: { planVersion: { suite } },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { planVersion: { select: { version: true, suite: { select: { id: true, name: true } } } } },
      }),
      client.testSuite.findMany({
        where: suite,
        orderBy: { updatedAt: "desc" },
        take: 5,
        include: {
          application: { select: { name: true } },
          planVersions: { orderBy: { version: "desc" }, take: 1, select: { version: true, status: true } },
        },
      }),
    ]);

  return {
    counts: { projects, applications, discoveryQueued, suites, pendingApprovals, queuedRuns, openDefects },
    recentRuns,
    recentSuites,
  };
}
