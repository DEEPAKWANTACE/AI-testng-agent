import { z } from "zod";
import { Priority, TestCaseType } from "@/generated/prisma/enums";
import { executableStepsSchema } from "@/modules/execution/steps";
import { optionalText, requiredText } from "@/lib/validation";

export const testSuiteInputSchema = z.object({
  applicationId: z.cuid({ error: "Select an application" }),
  name: requiredText("Name", 160),
  description: optionalText("Description", 4000),
});

export const testSuiteUpdateSchema = testSuiteInputSchema.omit({ applicationId: true });

const lines = (label: string, maxItems: number, maxLength = 300) =>
  z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().max(maxLength, `Each ${label} line must be at most ${maxLength} characters`)).max(maxItems, `At most ${maxItems} ${label} lines`));

/**
 * Steps are either executable (a JSON array of step objects, see execution/steps.ts) or
 * descriptive (one per line). Descriptive-only cases are kept but can't run automatically.
 */
export const stepsInputSchema = z
  .string({ error: "Add at least one step" })
  .trim()
  .min(1, "Add at least one step")
  .max(50_000, "Steps are too long")
  .transform((value, ctx) => {
    if (value.startsWith("[")) {
      let raw: unknown;
      try {
        raw = JSON.parse(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "Steps JSON is not valid JSON" });
        return z.NEVER;
      }
      const parsed = executableStepsSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        ctx.addIssue({ code: "custom", message: typeof issue.path[0] === "number" ? `Step ${issue.path[0] + 1}: ${issue.message} (${issue.path.slice(1).join(".")})` : issue.message });
        return z.NEVER;
      }
      return parsed.data.map((step) => ({ action: step.description, expectedResult: step.expected ?? null, kind: step.kind, params: step.params }));
    }
    const descriptive = value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (descriptive.length > 50) {
      ctx.addIssue({ code: "custom", message: "At most 50 steps" });
      return z.NEVER;
    }
    if (descriptive.some((line) => line.length > 500)) {
      ctx.addIssue({ code: "custom", message: "Each step must be at most 500 characters" });
      return z.NEVER;
    }
    return descriptive.map((action) => ({ action, expectedResult: null, kind: null, params: null }));
  });

export const testCaseInputSchema = z.object({
  title: requiredText("Title", 200),
  steps: stepsInputSchema,
  expectedResult: requiredText("Expected result", 2000),
  priority: z.enum(Priority),
  type: z.enum(TestCaseType),
  prerequisites: lines("prerequisite", 10),
  requirementRefs: lines("requirement", 10, 200),
});

export const caseReviewSchema = z.object({
  decision: z.enum(["ACCEPTED", "REJECTED", "PROPOSED"], { error: "Choose accept or reject" }),
  caseIds: z.array(z.cuid()).min(1, "Select at least one case").max(500),
});

export type TestSuiteInput = z.infer<typeof testSuiteInputSchema>;
export type TestCaseInput = z.infer<typeof testCaseInputSchema>;
