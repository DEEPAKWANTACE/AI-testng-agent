import { z } from "zod";
import { AppEnvironment } from "@/generated/prisma/enums";
import { authorizedUrlSchema } from "@/modules/applications/schemas";

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const autoTestInputSchema = z
  .object({
    projectId: z.cuid({ error: "Select a project" }),
    url: authorizedUrlSchema,
    name: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
    environment: z.enum(AppEnvironment, { error: "Select an environment" }),
    // Optional: omit both to test only what's reachable without signing in.
    username: z.preprocess(blankToUndefined, z.string().max(320).optional()),
    password: z.preprocess(blankToUndefined, z.string().max(512).optional()),
    loginUrl: z.preprocess(blankToUndefined, z.url({ protocol: /^https?$/, error: "Enter the full login page URL" }).optional()),
    maxPages: z.coerce.number({ error: "Max pages must be a number" }).int().min(1).max(1000).default(500),
    authorized: z.literal("on", { error: "Confirm you're authorized to test this application" }),
  })
  .refine((v) => !!v.username === !!v.password, { path: ["password"], message: "Provide both the username and the password, or neither" });

export type AutoTestInput = z.infer<typeof autoTestInputSchema>;
