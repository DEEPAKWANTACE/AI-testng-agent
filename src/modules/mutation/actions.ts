"use server";

import { failure, success, toActionError, validationError, type ActionState } from "@/lib/action-state";
import { revalidateDashboard } from "@/lib/revalidate";
import { formDataToObject, idSchema } from "@/lib/validation";
import { requireActor } from "@/modules/auth/session";
import { mutationRequestSchema, requestMutationRun } from "./service";

export async function requestMutationRunAction(planVersionId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(planVersionId);
  if (!id.success) return failure("Invalid plan version");
  const values = formDataToObject(formData);
  const parsed = mutationRequestSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);
  try {
    await requestMutationRun(actor, id.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }
  revalidateDashboard();
  return success("Mutation analysis queued. It first runs the plan unchanged; that baseline must pass.");
}
