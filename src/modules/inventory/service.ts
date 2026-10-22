import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { Confidence, InventorySource } from "@/generated/prisma/enums";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import { assertApplicationPermission } from "@/modules/access/service";
import { audit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/auth/service";
import { SECRET_NAME } from "@/modules/execution/steps";
import { analyzeOpenApi, MAX_SPEC_BYTES, SpecError } from "./openapi";
import { analyzeRequirements, MAX_REQUIREMENTS_BYTES } from "./requirements";
import { normalizeRoutePath, type ExtractedItem } from "./types";

/**
 * The inventory is what the application is *known* to contain, merged from every authorized
 * source. Each origin (one uploaded document, the repository, discovery) contributes a set of
 * findings that is replaced as a whole when that origin is analysed again. Coverage is always
 * measured against this inventory, so it can never claim more than the sources tell.
 */

export type ItemSource = { source: InventorySource; origin: string; ref: string; documentId?: string; analysisId?: string };

const RANK: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/** Replaces `origin`'s findings in the application's inventory. Returns counts. */
export async function mergeInventory(applicationId: string, source: InventorySource, origin: string, found: ExtractedItem[], meta: { documentId?: string; analysisId?: string } = {}) {
  // Collapse duplicates within this batch.
  const incoming = new Map<string, ExtractedItem & { refs: string[] }>();
  for (const item of found) {
    const id = `${item.kind}:${item.key}`;
    const prior = incoming.get(id);
    if (!prior) incoming.set(id, { ...item, refs: [item.ref], roles: [...new Set(item.roles ?? [])] });
    else {
      prior.refs.push(item.ref);
      prior.roles = [...new Set([...(prior.roles ?? []), ...(item.roles ?? [])])];
      prior.protected = prior.protected || item.protected || null;
      if (RANK[item.confidence] > RANK[prior.confidence]) prior.confidence = item.confidence;
      prior.details = { ...(item.details ?? {}), ...(prior.details ?? {}) };
    }
  }

  return db().$transaction(
    async (tx) => {
      const existing = await tx.inventoryItem.findMany({ where: { applicationId } });
      const byId = new Map(existing.map((e) => [`${e.kind}:${e.key}`, e]));
      const now = new Date();
      let created = 0;
      let updated = 0;
      let deactivated = 0;

      for (const item of existing) {
        if (incoming.has(`${item.kind}:${item.key}`)) continue;
        const sources = (item.sources as ItemSource[]).filter((s) => s.origin !== origin);
        if (sources.length === (item.sources as ItemSource[]).length) continue;
        await tx.inventoryItem.update({ where: { id: item.id }, data: { sources: sources as unknown as Prisma.InputJsonValue, active: sources.length > 0 } });
        if (!sources.length) deactivated++;
      }

      for (const [id, item] of incoming) {
        const refs = item.refs.slice(0, 20).map((ref): ItemSource => ({ source, origin, ref, ...meta }));
        const prior = byId.get(id);
        if (!prior) {
          await tx.inventoryItem.create({
            data: {
              applicationId,
              kind: item.kind,
              key: item.key,
              title: item.title,
              details: (item.details ?? undefined) as Prisma.InputJsonValue | undefined,
              sources: refs as unknown as Prisma.InputJsonValue,
              confidence: item.confidence,
              protected: item.protected ?? null,
              roles: item.roles ?? [],
            },
          });
          created++;
          continue;
        }
        const others = (prior.sources as ItemSource[]).filter((s) => s.origin !== origin);
        // Other origins still vouch for the item at its previous confidence.
        const confidence = others.length && RANK[prior.confidence] > RANK[item.confidence] ? prior.confidence : item.confidence;
        await tx.inventoryItem.update({
          where: { id: prior.id },
          data: {
            // Documents name things better than code: keep a human title once we have one.
            title: prior.title === prior.key || source === "OPENAPI" || source === "REQUIREMENTS" ? item.title : prior.title,
            details: { ...((prior.details as Record<string, unknown>) ?? {}), ...(item.details ?? {}) } as Prisma.InputJsonValue,
            sources: [...others, ...refs] as unknown as Prisma.InputJsonValue,
            confidence,
            protected: item.protected ?? prior.protected,
            roles: [...new Set([...prior.roles, ...(item.roles ?? [])])],
            active: true,
            lastSeenAt: now,
          },
        });
        updated++;
      }
      return { created, updated, deactivated, total: incoming.size };
    },
    { timeout: 60_000 },
  );
}

export const inventoryDocumentSchema = z.object({
  source: z.enum(["OPENAPI", "REQUIREMENTS"]),
  name: z.string().trim().min(1, "Name the document").max(120),
  content: z.string().min(1, "Paste the document").max(MAX_SPEC_BYTES, "Documents are limited to 2 MB"),
});
export type InventoryDocumentInput = z.infer<typeof inventoryDocumentSchema>;

/** Stores an OpenAPI spec or requirements document and merges what it describes. */
export async function addInventoryDocument(actor: Actor, applicationId: string, input: InventoryDocumentInput) {
  const { projectId } = await assertApplicationPermission(actor, applicationId, "application.update");
  if (input.source === "REQUIREMENTS" && Buffer.byteLength(input.content) > MAX_REQUIREMENTS_BYTES) throw new DomainError("Requirements documents are limited to 500 KB.");
  let items: ExtractedItem[];
  try {
    items = input.source === "OPENAPI" ? analyzeOpenApi(input.content, input.name) : analyzeRequirements(input.content, input.name);
  } catch (error) {
    // Parse problems (invalid spec, oversized document) are the user's to fix.
    throw new DomainError(error instanceof SpecError || error instanceof Error ? error.message : "The document couldn't be analysed.");
  }
  if (!items.length) throw new DomainError(input.source === "OPENAPI" ? "The specification describes no operations." : "No requirements, roles or workflows were recognised in this document.");

  const document = await db().inventoryDocument.create({
    data: { applicationId, source: input.source, name: input.name, content: input.content, sha256: createHash("sha256").update(input.content).digest("hex"), itemCount: items.length, createdById: actor.id },
    select: { id: true },
  });
  const counts = await mergeInventory(applicationId, input.source, `${input.source}:${input.name}`, items, { documentId: document.id });
  await audit({ actor, action: "inventory.updated", entityType: "InventoryDocument", entityId: document.id, projectId, data: { source: input.source, name: input.name, ...counts } });
  return { documentId: document.id, ...counts };
}

/** Feeds the latest completed discovery run's pages into the inventory as routes. */
export async function syncDiscoveryInventory(applicationId: string) {
  const run = await db().discoveryRun.findFirst({ where: { applicationId, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true, application: { select: { authorizedUrl: true } } } });
  if (!run) return null;
  const pages = await db().discoveredPage.findMany({ where: { runId: run.id, error: null }, select: { url: true, title: true, statusCode: true } });
  const origin = new URL(run.application.authorizedUrl).origin;
  const items: ExtractedItem[] = pages
    .filter((p) => p.url.startsWith(origin) && (p.statusCode ?? 200) < 400)
    .map((p) => {
      const path = normalizeRoutePath(new URL(p.url).pathname);
      return { kind: "ROUTE", key: path, title: p.title ? `${p.title} (${path})` : path, ref: p.url, confidence: "HIGH" };
    });
  return mergeInventory(applicationId, "DISCOVERY", "DISCOVERY", items, {});
}

export const sourceAnalysisSchema = z.object({
  tokenSecret: z.union([z.literal(""), z.string().regex(SECRET_NAME, "Secret names are UPPER_SNAKE_CASE")]).transform((v) => v || null),
});

/** Queues static analysis of the application's repository (picked up by the analysis worker). */
export async function requestSourceAnalysis(actor: Actor, applicationId: string, input: { tokenSecret: string | null }) {
  const { projectId } = await assertApplicationPermission(actor, applicationId, "application.update");
  const app = await db().application.findUniqueOrThrow({ where: { id: applicationId }, select: { repoUrl: true, repoBranch: true, secrets: { select: { name: true } } } });
  if (!app.repoUrl) throw new DomainError("Add the application's repository URL first.");
  if (!/^https:\/\//i.test(app.repoUrl)) throw new DomainError("Only https:// repositories can be analysed.");
  if (input.tokenSecret && !app.secrets.some((s) => s.name === input.tokenSecret)) throw new DomainError(`This application has no secret named ${input.tokenSecret}.`);
  const active = await db().sourceAnalysis.count({ where: { applicationId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (active) throw new DomainError("An analysis of this repository is already in progress.");
  const analysis = await db().sourceAnalysis.create({
    data: { applicationId, repoUrl: app.repoUrl, repoBranch: app.repoBranch, tokenSecret: input.tokenSecret, triggeredById: actor.id },
    select: { id: true },
  });
  await audit({ actor, action: "inventory.analysis.requested", entityType: "SourceAnalysis", entityId: analysis.id, projectId, data: { repoUrl: app.repoUrl, branch: app.repoBranch } });
  return analysis;
}
