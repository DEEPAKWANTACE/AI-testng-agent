"use server";

import { z } from "zod";
import { failure, success, toActionError, type ActionState } from "@/lib/action-state";
import { revalidateDashboard } from "@/lib/revalidate";
import { idSchema, optionalText } from "@/lib/validation";
import { requireActor } from "@/modules/auth/session";
import { createRegressionSuite } from "@/modules/regression/service";
import { requestGeneration } from "./service";

const generationSchema = z.object({
  featureIds: z.array(z.cuid()).min(1, "Select at least one feature").max(15, "Select at most 15 features"),
  requirements: optionalText("Requirements", 4000),
  suiteId: z.union([z.literal(""), z.cuid()]).transform((v) => v || null),
});

/** Queues test-case generation. Cases arrive as PROPOSED drafts for review. */
export async function generateTestCases(applicationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(applicationId);
  if (!id.success) return failure("Invalid application");
  const parsed = generationSchema.safeParse({
    featureIds: formData.getAll("featureIds"),
    requirements: formData.get("requirements") ?? undefined,
    suiteId: formData.get("suiteId") ?? "",
  });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid input");
  try {
    await requestGeneration(actor, { applicationId: id.data, ...parsed.data });
  } catch (error) {
    return toActionError(error);
  }
  revalidateDashboard();
  return success("Generation queued. Proposed cases will appear in a draft suite for review.");
}

const regressionSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(160),
  selections: z.array(z.string().regex(/^c[a-z0-9]+:[\w-]+$/)).min(1, "Select at least one approved case").max(500),
});

/** Builds a regression suite from approved cases; it must be approved before it runs. */
export async function createRegressionSuiteAction(applicationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const id = idSchema.safeParse(applicationId);
  if (!id.success) return failure("Invalid application");
  const parsed = regressionSchema.safeParse({ name: formData.get("name"), selections: formData.getAll("selections") });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid input");
  try {
    await createRegressionSuite(actor, { applicationId: id.data, ...parsed.data });
  } catch (error) {
    return toActionError(error);
  }
  revalidateDashboard();
  return success("Regression suite created. Submit it for approval to run it.");
}
