"use server";

import { failure, toActionError, validationError, type ActionState } from "@/lib/action-state";
import { revalidateDashboard } from "@/lib/revalidate";
import { formDataToObject, idSchema } from "@/lib/validation";
import { requireActor } from "@/modules/auth/session";
import { defectVerificationSchema, verifyDefect } from "./service";

export async function verifyDefectAction(defectId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(defectId);
  if (!id.success) return failure("Invalid defect");
  const values = formDataToObject(formData);
  const parsed = defectVerificationSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);
  try {
    await verifyDefect(actor, id.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }
  revalidateDashboard();
  return { status: "success", message: parsed.data.decision === "CONFIRMED" ? "Defect confirmed." : "Defect marked as not confirmed." };
}
