"use server";

import { redirect } from "next/navigation";
import { toActionError, validationError, type ActionState } from "@/lib/action-state";
import { revalidateDashboard } from "@/lib/revalidate";
import { formDataToObject } from "@/lib/validation";
import { requireActor } from "@/modules/auth/session";
import { autoTestInputSchema } from "./schemas";
import { startAutoTest } from "./service";

/** Registers the app, stores the test account, and queues discovery + automatic test generation. */
export async function startAutoTestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const parsed = autoTestInputSchema.safeParse(values);
  // Never echo the password back into the form.
  const echo = { ...values, password: "" };
  if (!parsed.success) {
    // The confirmation checkbox has no inline error slot, so say it in the form message.
    const state = validationError(parsed.error, echo);
    const confirm = state.fieldErrors?.authorized?.[0];
    return confirm ? { ...state, message: confirm } : state;
  }

  let applicationId: string;
  try {
    ({ applicationId } = await startAutoTest(actor, parsed.data));
  } catch (error) {
    return toActionError(error, echo);
  }
  revalidateDashboard();
  redirect(`/applications/${applicationId}`);
}
