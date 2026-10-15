import { z } from "zod";
import { optionalText } from "@/lib/validation";

/**
 * The reviewer is always the signed-in user. `expectedHash` is the content hash shown to the
 * reviewer; the decision only applies to a version with exactly that content.
 */
export const approvalDecisionSchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"], { error: "Choose approve or reject" }),
    comment: optionalText("Comment", 2000),
    expectedHash: z.string().regex(/^[0-9a-f]{64}$/, "Missing plan hash; reload the page"),
  })
  .refine((value) => value.decision === "APPROVED" || Boolean(value.comment), {
    message: "Explain why the plan is rejected",
    path: ["comment"],
  });

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
