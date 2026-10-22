import { z } from "zod";
import { httpUrl } from "@/lib/validation";

export const discoveryInputSchema = z.object({
  applicationId: z.cuid({ error: "Select an application" }),
  startUrl: httpUrl("Start URL"),
  maxDepth: z.coerce
    .number({ error: "Max depth must be a number" })
    .int("Max depth must be a whole number")
    .min(1, "Max depth must be at least 1")
    .max(10, "Max depth can be at most 10"),
  maxPages: z.coerce
    .number({ error: "Max pages must be a number" })
    .int("Max pages must be a whole number")
    .min(1, "Max pages must be at least 1")
    .max(1000, "Max pages can be at most 1000")
    .default(25),
});

export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;
