import "server-only";
import { db } from "@/lib/db";
import { can } from "@/modules/access/policy";
import { getProjectRole, NotFoundError, projectScope } from "@/modules/access/service";
import type { Actor } from "@/modules/auth/service";
import { applicationCoverage } from "@/modules/coverage/service";
import type { ItemSource } from "./service";

/** Everything the inventory page shows, scoped to an application the actor can view. */
export async function getInventory(actor: Actor, applicationId: string) {
  const application = await db().application.findFirst({
    where: { id: applicationId, project: projectScope(actor) },
    select: { id: true, name: true, projectId: true, repoUrl: true, repoBranch: true, secrets: { select: { name: true }, orderBy: { name: "asc" } } },
  });
  if (!application) throw new NotFoundError("Application");
  const [items, documents, analyses, role, coverage] = await Promise.all([
    db().inventoryItem.findMany({ where: { applicationId }, orderBy: [{ active: "desc" }, { kind: "asc" }, { key: "asc" }] }),
    db().inventoryDocument.findMany({ where: { applicationId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, source: true, name: true, itemCount: true, sha256: true, createdAt: true, createdBy: { select: { name: true } } } }),
    db().sourceAnalysis.findMany({ where: { applicationId }, orderBy: { createdAt: "desc" }, take: 10 }),
    getProjectRole(actor, application.projectId),
    applicationCoverage(applicationId),
  ]);
  const byItem = new Map(coverage.coverage.map((c) => [c.itemId, c]));
  return {
    application,
    items: items.map((item) => ({ ...item, sources: item.sources as ItemSource[], coverage: byItem.get(item.id) ?? null })),
    coverageSummary: coverage.summary,
    documents,
    analyses,
    permissions: { update: can(actor.role, role, "application.update") },
  };
}
