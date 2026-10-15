"use server";

import { redirect } from "next/navigation";
import { failure, success, toActionError, validationError, type ActionState } from "@/lib/action-state";
import { revalidateDashboard } from "@/lib/revalidate";
import { formDataToObject, idSchema } from "@/lib/validation";
import { requireActor } from "@/modules/auth/session";
import { memberInputSchema, memberRoleSchema, projectInputSchema } from "./schemas";
import * as service from "./service";

export async function createProject(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const parsed = projectInputSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  let projectId: string;
  try {
    ({ id: projectId } = await service.createProject(actor, parsed.data));
  } catch (error) {
    return toActionError(error, values);
  }

  revalidateDashboard();
  redirect(`/projects/${projectId}`);
}

export async function updateProject(id: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const projectId = idSchema.safeParse(id);
  if (!projectId.success) return failure("Invalid project");
  const parsed = projectInputSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  try {
    await service.updateProject(actor, projectId.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }

  revalidateDashboard();
  return success("Project saved.");
}

export async function deleteProject(id: string): Promise<ActionState> {
  const actor = await requireActor();
  const projectId = idSchema.safeParse(id);
  if (!projectId.success) return failure("Invalid project");

  try {
    await service.deleteProject(actor, projectId.data);
  } catch (error) {
    return toActionError(error);
  }

  revalidateDashboard();
  redirect("/projects");
}

export async function addMember(projectId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const id = idSchema.safeParse(projectId);
  if (!id.success) return failure("Invalid project");
  const parsed = memberInputSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  try {
    await service.addMember(actor, id.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }

  revalidateDashboard();
  return success("Member added.");
}

export async function updateMemberRole(memberId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(memberId);
  if (!id.success) return failure("Invalid member");
  const parsed = memberRoleSchema.safeParse(formDataToObject(formData));
  if (!parsed.success) return validationError(parsed.error);

  try {
    await service.updateMemberRole(actor, id.data, parsed.data.role);
  } catch (error) {
    return toActionError(error);
  }

  revalidateDashboard();
  return success("Role updated.");
}

export async function removeMember(memberId: string): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(memberId);
  if (!id.success) return failure("Invalid member");

  try {
    await service.removeMember(actor, id.data);
  } catch (error) {
    return toActionError(error);
  }

  revalidateDashboard();
  return success("Member removed.");
}
