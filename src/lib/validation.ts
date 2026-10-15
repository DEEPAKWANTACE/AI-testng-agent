import { z } from "zod";

/** Required trimmed text field. */
export const requiredText = (label: string, max = 200) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`);

/** Optional trimmed text field; empty strings become `null` so they clear the column. */
export const optionalText = (label: string, max = 2000) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .optional()
    .transform((value) => (value ? value : null));

/** An http(s) URL, normalised without a trailing slash. */
export const httpUrl = (label: string) =>
  z
    .url({ protocol: /^https?$/, error: `${label} must be a valid http(s) URL` })
    .trim()
    .transform((value) => value.replace(/\/+$/, ""));

export const idSchema = z.cuid({ error: "Invalid id" });

/** Converts FormData into a plain object; repeated keys are dropped in favour of the first value. */
export function formDataToObject(formData: FormData): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("$ACTION")) continue;
    if (typeof value === "string" && !(key in result)) result[key] = value;
  }
  return result;
}
