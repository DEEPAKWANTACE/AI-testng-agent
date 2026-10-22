import "server-only";
import { z } from "zod";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import { assertApplicationPermission, NotFoundError } from "@/modules/access/service";
import { audit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/auth/service";

export const mutationRequestSchema = z.object({ mutantLimit: z.coerce.number().int().min(1, "At least 1 mutant").max(100, "At most 100 mutants") });

/** Queues mutation analysis of an approved plan version (it executes like a run of that plan). */
export async function requestMutationRun(actor: Actor, planVersionId: string, input: { mutantLimit: number }) {
  const version = await db().planVersion.findUnique({ where: { id: planVersionId }, select: { status: true, snapshotFormat: true, suite: { select: { applicationId: true } } } });
  if (!version) throw new NotFoundError("Plan version");
  const { projectId } = await assertApplicationPermission(actor, version.suite.applicationId, "run.manage");
  if (version.status !== "APPROVED") throw new DomainError("Only approved plan versions can be mutation-tested.");
  if (version.snapshotFormat !== 2) throw new DomainError("This plan version predates executable steps.");
  const active = await db().mutationRun.count({ where: { planVersionId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (active) throw new DomainError("A mutation analysis of this version is already in progress.");
  const run = await db().mutationRun.create({ data: { planVersionId, mutantLimit: input.mutantLimit, triggeredById: actor.id }, select: { id: true } });
  await audit({ actor, action: "mutation.requested", entityType: "MutationRun", entityId: run.id, projectId, data: { planVersionId, mutantLimit: input.mutantLimit } });
  return run;
}
