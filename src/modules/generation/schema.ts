import { z } from "zod";
import { executableStepSchema, stepSequenceIssues } from "@/modules/execution/steps";

/** Test categories the generator must produce (subset of TestCaseType). */
export const GENERATED_CATEGORIES = ["END_TO_END", "POSITIVE", "NEGATIVE", "BOUNDARY", "PERMISSION", "REGRESSION"] as const;

/**
 * Contract for generator output. Everything from the model is untrusted: it is parsed with
 * this strict schema, every step must be a valid executable step, and each case is validated
 * on its own so one bad case can't poison the batch.
 */
export const generatedCaseSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    feature: z.string().trim().min(1).max(120),
    category: z.enum(GENERATED_CATEGORIES),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    prerequisites: z.array(z.string().trim().min(1).max(300)).max(10),
    steps: z.array(executableStepSchema).min(1).max(30),
    expectedResult: z.string().trim().min(3).max(1000),
    coverage: z
      .object({
        requirements: z.array(z.string().trim().min(1).max(200)).max(10),
        notes: z.string().trim().max(500).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const message of stepSequenceIssues(value.steps)) ctx.addIssue({ code: "custom", path: ["steps"], message });
  });

export type GeneratedCase = z.infer<typeof generatedCaseSchema>;

/** Envelope: validated loosely first so valid cases survive alongside invalid ones. */
export const generationEnvelopeSchema = z.object({ cases: z.array(z.unknown()).max(100) }).strict();

/** JSON Schema sent to providers that support structured output (kept in sync by tests). */
export const GENERATION_JSON_SCHEMA = z.toJSONSchema(z.object({ cases: z.array(generatedCaseSchema).max(100) }).strict(), {
  target: "draft-7",
  io: "input",
  unrepresentable: "any",
});
