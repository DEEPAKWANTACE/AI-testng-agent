import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { can } from "@/modules/access/policy";
import { getProjectRole, projectScope } from "@/modules/access/service";
import type { Actor } from "@/modules/auth/service";
import { pageElementsSchema, EMPTY_PAGE_ELEMENTS } from "./page-elements";

export function listDiscoveryRuns(actor: Actor) {
  return db().discoveryRun.findMany({
    where: { application: { project: projectScope(actor) } },
    orderBy: { createdAt: "desc" },
    include: {
      application: { select: { id: true, name: true, project: { select: { name: true } } } },
      _count: { select: { features: true, pages: true } },
    },
  });
}

/** Display shape for `DiscoveryRun.stats` (written by the worker). */
const statsSchema = z
  .object({
    pagesVisited: z.number(),
    pagesFailed: z.number(),
    totals: z.object({ links: z.number(), forms: z.number(), buttons: z.number(), inputs: z.number(), navigation: z.number() }),
    skippedLinks: z.record(z.string(), z.number()),
    redirectsBlocked: z.array(z.object({ from: z.string(), to: z.string() })),
    blockedRequests: z.array(z.object({ target: z.string(), reason: z.string(), detail: z.string() })),
    stoppedBy: z.string(),
    authenticated: z.boolean(),
  })
  .partial();

/** Returns null when the run doesn't exist or the actor can't see it. */
export async function getDiscoveryRun(actor: Actor, id: string) {
  const run = await db().discoveryRun.findFirst({
    where: { id, application: { project: projectScope(actor) } },
    include: {
      application: { select: { id: true, name: true, projectId: true, authorizedUrl: true, project: { select: { name: true } } } },
      triggeredBy: { select: { name: true } },
      features: { orderBy: { name: "asc" }, include: { _count: { select: { pages: true } } } },
      pages: {
        orderBy: [{ depth: "asc" }, { createdAt: "asc" }],
        include: {
          feature: { select: { name: true } },
          artifacts: { where: { kind: "SCREENSHOT" }, select: { id: true } },
        },
      },
      artifacts: { select: { id: true, kind: true, name: true, sizeBytes: true } },
    },
  });
  if (!run) return null;

  const role = await getProjectRole(actor, run.application.projectId);
  const stats = statsSchema.safeParse(run.stats ?? {});
  return {
    ...run,
    stats: stats.success ? stats.data : {},
    pages: run.pages.map((page) => {
      const elements = pageElementsSchema.safeParse(page.elements);
      return { ...page, elements: elements.success ? elements.data : EMPTY_PAGE_ELEMENTS };
    }),
    permissions: { manage: can(actor.role, role, "discovery.run") },
  };
}
