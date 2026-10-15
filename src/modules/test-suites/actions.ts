"use server";

import { redirect } from "next/navigation";
import { failure, success, toActionError, validationError, type ActionState } from "@/lib/action-state";
import { revalidateDashboard } from "@/lib/revalidate";
import { formDataToObject, idSchema, optionalText } from "@/lib/validation";
import { requireActor } from "@/modules/auth/session";
import { caseReviewSchema, testCaseInputSchema, testSuiteInputSchema, testSuiteUpdateSchema } from "./schemas";
import * as service from "./service";

export async function createTestSuite(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const parsed = testSuiteInputSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  let suiteId: string;
  try {
    ({ id: suiteId } = await service.createSuite(actor, parsed.data));
  } catch (error) {
    return toActionError(error, values);
  }
  revalidateDashboard();
  redirect(`/test-plans/${suiteId}`);
}

export async function updateTestSuite(id: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const suiteId = idSchema.safeParse(id);
  if (!suiteId.success) return failure("Invalid test suite");
  const parsed = testSuiteUpdateSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);
  try {
    await service.updateSuite(actor, suiteId.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }
  revalidateDashboard();
  return success("Test suite saved.");
}

export async function deleteTestSuite(id: string): Promise<ActionState> {
  const actor = await requireActor();
  const suiteId = idSchema.safeParse(id);
  if (!suiteId.success) return failure("Invalid test suite");
  try {
    await service.deleteSuite(actor, suiteId.data);
  } catch (error) {
    return toActionError(error);
  }
  revalidateDashboard();
  redirect("/test-plans");
}

export async function archiveTestSuite(id: string): Promise<ActionState> {
  const actor = await requireActor();
  const suiteId = idSchema.safeParse(id);
  if (!suiteId.success) return failure("Invalid test suite");
  try {
    await service.archiveSuite(actor, suiteId.data);
  } catch (error) {
    return toActionError(error);
  }
  revalidateDashboard();
  return success("Suite archived.");
}

export async function addTestCase(suiteId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const id = idSchema.safeParse(suiteId);
  if (!id.success) return failure("Invalid test suite");
  const parsed = testCaseInputSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);
  try {
    await service.addCase(actor, id.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }
  revalidateDashboard();
  return success("Test case added.");
}

export async function updateTestCase(caseId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const id = idSchema.safeParse(caseId);
  if (!id.success) return failure("Invalid test case");
  const parsed = testCaseInputSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);
  try {
    await service.updateCase(actor, id.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }
  revalidateDashboard();
  return success("Test case saved. Changes need a new approved version before they run.");
}

/** Bulk review: the form posts one `caseIds` value per selected checkbox. */
export async function reviewTestCases(suiteId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(suiteId);
  if (!id.success) return failure("Invalid test suite");
  const parsed = caseReviewSchema.safeParse({ decision: formData.get("decision"), caseIds: formData.getAll("caseIds") });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid selection");
  try {
    const count = await service.reviewCases(actor, id.data, parsed.data.caseIds, parsed.data.decision);
    revalidateDashboard();
    const verb = { ACCEPTED: "Accepted", REJECTED: "Rejected", PROPOSED: "Re-opened" }[parsed.data.decision];
    return success(`${verb} ${count} case${count === 1 ? "" : "s"}.`);
  } catch (error) {
    return toActionError(error);
  }
}

export async function archiveTestCase(caseId: string): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(caseId);
  if (!id.success) return failure("Invalid test case");
  try {
    await service.archiveCase(actor, id.data);
  } catch (error) {
    return toActionError(error);
  }
  revalidateDashboard();
  return success("Test case removed.");
}

const summarySchema = optionalText("Change summary", 500);

export async function submitForApproval(suiteId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(suiteId);
  if (!id.success) return failure("Invalid test suite");
  const summary = summarySchema.safeParse(formData.get("changeSummary") ?? undefined);
  try {
    const version = await service.submitForApproval(actor, id.data, summary.success ? summary.data : null);
    revalidateDashboard();
    return success(`Submitted v${version.version} for approval.`);
  } catch (error) {
    return toActionError(error);
  }
}
