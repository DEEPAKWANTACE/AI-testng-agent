import "server-only";
import { z } from "zod";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import { assertApplicationPermission, NotFoundError } from "@/modules/access/service";
import { audit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/auth/service";

export const baselineReviewSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  /** The image hash the reviewer looked at: approval is bound to those exact bytes. */
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/, "Reload the page and review the image again"),
  note: z.string().trim().max(1000).optional().transform((v) => v || null),
});
export type BaselineReview = z.infer<typeof baselineReviewSchema>;

/**
 * Approves or rejects a candidate baseline. Approval supersedes the previous approved image
 * for the same key, atomically; the database allows only one approved baseline per key.
 */
export async function reviewBaseline(actor: Actor, baselineId: string, input: BaselineReview) {
  const baseline = await db().visualBaseline.findUnique({ where: { id: baselineId }, select: { applicationId: true, caseKey: true, name: true, status: true, sha256: true } });
  if (!baseline) throw new NotFoundError("Baseline");
  const { projectId } = await assertApplicationPermission(actor, baseline.applicationId, "plan.review");
  if (baseline.status !== "PENDING") throw new DomainError("This baseline has already been reviewed or replaced.");
  if (input.expectedHash !== baseline.sha256) throw new DomainError("This image isn't the one you reviewed. Reload the page and review it again.");

  await db().$transaction(async (tx) => {
    const reviewedAt = new Date();
    if (input.decision === "APPROVED") {
      await tx.visualBaseline.updateMany({
        where: { applicationId: baseline.applicationId, caseKey: baseline.caseKey, name: baseline.name, status: "APPROVED" },
        data: { status: "SUPERSEDED" },
      });
    }
    const { count } = await tx.visualBaseline.updateMany({
      where: { id: baselineId, status: "PENDING", sha256: input.expectedHash },
      data: { status: input.decision, reviewerId: actor.id, reviewedAt, reviewNote: input.note },
    });
    if (!count) throw new DomainError("This baseline has already been reviewed or replaced.");
    await audit(
      { actor, action: input.decision === "APPROVED" ? "baseline.approved" : "baseline.rejected", entityType: "VisualBaseline", entityId: baselineId, projectId, data: { name: baseline.name, caseKey: baseline.caseKey, sha256: baseline.sha256, note: input.note } },
      tx,
    );
  });
}
