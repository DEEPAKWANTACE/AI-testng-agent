"use server";

import { failure, toActionError, validationError, type ActionState } from "@/lib/action-state";
import { revalidateDashboard } from "@/lib/revalidate";
import { formDataToObject, idSchema } from "@/lib/validation";
import { requireActor } from "@/modules/auth/session";
import { baselineReviewSchema, reviewBaseline } from "./service";

export async function reviewBaselineAction(baselineId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(baselineId);
  if (!id.success) return failure("Invalid baseline");
  const values = formDataToObject(formData);
  const parsed = baselineReviewSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);
  try {
    await reviewBaseline(actor, id.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }
  revalidateDashboard();
  return { status: "success", message: parsed.data.decision === "APPROVED" ? "Baseline approved." : "Baseline rejected." };
}
