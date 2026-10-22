import "server-only";
import { z } from "zod";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import { assertApplicationPermission, NotFoundError } from "@/modules/access/service";
import { audit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/auth/service";

export const defectVerificationSchema = z.object({
  decision: z.enum(["CONFIRMED", "NOT_CONFIRMED"]),
  note: z.string().trim().min(3, "Say what you checked").max(2000),
});
export type DefectVerificationInput = z.infer<typeof defectVerificationSchema>;

/**
 * Records a person's verdict on a reproduced defect. Only defects with automated reproduction
 * evidence can be confirmed, by a reviewer of the project. Confirmation is about the defect
 * existing as described; it says nothing about any suggested cause.
 */
export async function verifyDefect(actor: Actor, defectId: string, input: DefectVerificationInput) {
  const defect = await db().defect.findUnique({ where: { id: defectId }, select: { applicationId: true, verification: true, evidence: true } });
  if (!defect) throw new NotFoundError("Defect");
  const { projectId } = await assertApplicationPermission(actor, defect.applicationId, "defect.verify");
  if (defect.verification !== "REPRODUCED") throw new DomainError("This defect has already been reviewed.");
  const attempts = (defect.evidence as { attempts?: unknown[] } | null)?.attempts ?? [];
  if (input.decision === "CONFIRMED" && attempts.length < 2) {
    throw new DomainError("A defect can only be confirmed with reproduction evidence from at least two attempts.");
  }

  const { count } = await db().defect.updateMany({
    where: { id: defectId, verification: "REPRODUCED" },
    data: { verification: input.decision, verifiedById: actor.id, verifiedAt: new Date(), verificationNote: input.note, ...(input.decision === "NOT_CONFIRMED" ? { status: "CLOSED" as const } : {}) },
  });
  if (!count) throw new DomainError("This defect has already been reviewed.");
  await audit({ actor, action: "defect.verified", entityType: "Defect", entityId: defectId, projectId, data: { decision: input.decision, note: input.note } });
}
