"use server";

import { redirect } from "next/navigation";
import { failure, success, toActionError, validationError, type ActionState } from "@/lib/action-state";
import { revalidateDashboard } from "@/lib/revalidate";
import { formDataToObject, idSchema } from "@/lib/validation";
import { requireActor } from "@/modules/auth/session";
import { secretReferenceInputSchema } from "@/modules/secrets/schemas";
import { applicationInputSchema } from "./schemas";
import * as service from "./service";

// Every action authenticates first; authorization happens in the service layer.

export async function createApplication(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const parsed = applicationInputSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  let applicationId: string;
  try {
    ({ id: applicationId } = await service.createApplication(actor, parsed.data));
  } catch (error) {
    return toActionError(error, values);
  }

  revalidateDashboard();
  redirect(`/applications/${applicationId}`);
}

export async function updateApplication(id: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const applicationId = idSchema.safeParse(id);
  if (!applicationId.success) return failure("Invalid application");
  const parsed = applicationInputSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  try {
    await service.updateApplication(actor, applicationId.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }

  revalidateDashboard();
  return success("Application saved.");
}

export async function deleteApplication(id: string): Promise<ActionState> {
  const actor = await requireActor();
  const applicationId = idSchema.safeParse(id);
  if (!applicationId.success) return failure("Invalid application");

  try {
    await service.deleteApplication(actor, applicationId.data);
  } catch (error) {
    return toActionError(error);
  }

  revalidateDashboard();
  redirect("/applications");
}

export async function addSecretReference(applicationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const id = idSchema.safeParse(applicationId);
  if (!id.success) return failure("Invalid application");
  const parsed = secretReferenceInputSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  try {
    await service.addSecretReference(actor, id.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }

  revalidateDashboard();
  return success("Secret reference added.");
}

export async function removeSecretReference(secretId: string): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(secretId);
  if (!id.success) return failure("Invalid secret reference");

  try {
    await service.removeSecretReference(actor, id.data);
  } catch (error) {
    return toActionError(error);
  }

  revalidateDashboard();
  return success("Secret reference removed.");
}
