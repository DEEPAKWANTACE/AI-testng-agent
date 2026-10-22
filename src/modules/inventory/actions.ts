"use server";

import { failure, success, toActionError, validationError, type ActionState } from "@/lib/action-state";
import { revalidateDashboard } from "@/lib/revalidate";
import { formDataToObject, idSchema } from "@/lib/validation";
import { requireActor } from "@/modules/auth/session";
import { addInventoryDocument, inventoryDocumentSchema, requestSourceAnalysis, sourceAnalysisSchema, syncDiscoveryInventory } from "./service";
import { assertApplicationPermission } from "@/modules/access/service";

export async function addInventoryDocumentAction(applicationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(applicationId);
  if (!id.success) return failure("Invalid application");
  const values = formDataToObject(formData);
  const parsed = inventoryDocumentSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, { source: values.source ?? "", name: values.name ?? "" });
  try {
    const result = await addInventoryDocument(actor, id.data, parsed.data);
    revalidateDashboard();
    return success(`Analysed: ${result.total} items (${result.created} new, ${result.updated} updated${result.deactivated ? `, ${result.deactivated} no longer listed` : ""}).`);
  } catch (error) {
    return toActionError(error, { source: values.source ?? "", name: values.name ?? "" });
  }
}

export async function requestSourceAnalysisAction(applicationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(applicationId);
  if (!id.success) return failure("Invalid application");
  const values = formDataToObject(formData);
  const parsed = sourceAnalysisSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);
  try {
    await requestSourceAnalysis(actor, id.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }
  revalidateDashboard();
  return success("Analysis queued. The worker reads the repository as text; nothing in it is executed.");
}

export async function syncDiscoveryInventoryAction(applicationId: string): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(applicationId);
  if (!id.success) return failure("Invalid application");
  try {
    await assertApplicationPermission(actor, id.data, "application.update");
    const result = await syncDiscoveryInventory(id.data);
    revalidateDashboard();
    return result ? success(`Synced ${result.total} discovered routes.`) : failure("No completed discovery run yet.");
  } catch (error) {
    return toActionError(error);
  }
}
