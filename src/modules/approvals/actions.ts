"use server";

import { failure, success, toActionError, validationError, type ActionState } from "@/lib/action-state";
import { revalidateDashboard } from "@/lib/revalidate";
import { formDataToObject, idSchema } from "@/lib/validation";
import { requireActor } from "@/modules/auth/session";
import { approvalDecisionSchema } from "./schemas";
import * as service from "./service";

export async function decideApproval(approvalId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const id = idSchema.safeParse(approvalId);
  if (!id.success) return failure("Invalid approval");
  const parsed = approvalDecisionSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  try {
    await service.decideApproval(actor, id.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }
  revalidateDashboard();
  return success(parsed.data.decision === "APPROVED" ? "Plan version approved." : "Plan version rejected.");
}
