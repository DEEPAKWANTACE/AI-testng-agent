import { z } from "zod";

export const emailSchema = z
  .string({ error: "Email is required" })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Enter a valid email address" }).max(254));

/** Upper bound stops very long inputs being used to make hashing expensive. */
export const passwordSchema = z
  .string({ error: "Password is required" })
  .min(12, "Password must be at least 12 characters")
  .max(128, "Password must be at most 128 characters");

export const loginSchema = z.object({
  email: emailSchema,
  // Don't reveal the policy on login; any non-empty value is checked against the hash.
  password: z.string({ error: "Password is required" }).min(1, "Password is required").max(128),
});
