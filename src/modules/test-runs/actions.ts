"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { failure, toActionError, validationError, type ActionState } from "@/lib/action-state";
import { revalidateDashboard } from "@/lib/revalidate";
import { formDataToObject, idSchema } from "@/lib/validation";
import { requireActor } from "@/modules/auth/session";
import { cancelRun, queueRun } from "@/modules/execution/runs";

const queueSchema = z.object({ planVersionId: z.cuid({ error: "Select an approved plan version" }) });

/** Queues an approved plan version (also used for "Rerun"). */
export async function createTestRun(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const parsed = queueSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  let runId: string;
  try {
    ({ id: runId } = await queueRun(actor, parsed.data.planVersionId));
  } catch (error) {
    return toActionError(error, values);
  }
  revalidateDashboard();
  redirect(`/test-runs/${runId}`);
}

export async function rerunVersion(planVersionId: string): Promise<ActionState> {
  const data = new FormData();
  data.set("planVersionId", planVersionId);
  return createTestRun({ status: "idle" }, data);
}

export async function cancelTestRun(runId: string): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(runId);
  if (!id.success) return failure("Invalid test run");
  try {
    await cancelRun(actor, id.data);
  } catch (error) {
    return toActionError(error);
  }
  revalidateDashboard();
  return { status: "success", message: "Test run cancelled." };
}
