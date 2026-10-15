import { z } from "zod";
import { ProjectRole, ProjectStatus } from "@/generated/prisma/enums";
import { optionalText, requiredText } from "@/lib/validation";
import { emailSchema } from "@/modules/auth/schemas";

export const projectInputSchema = z.object({
  name: requiredText("Name", 120),
  description: optionalText("Description", 2000),
  status: z.enum(ProjectStatus).default(ProjectStatus.ACTIVE),
});

export const memberInputSchema = z.object({
  email: emailSchema,
  role: z.enum(ProjectRole, { error: "Select a role" }),
});

export const memberRoleSchema = z.object({ role: z.enum(ProjectRole, { error: "Select a role" }) });

export type ProjectInput = z.infer<typeof projectInputSchema>;
export type MemberInput = z.infer<typeof memberInputSchema>;
