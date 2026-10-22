import { z } from "zod";
import type { SecretProvider } from "@/generated/prisma/enums";
import { optionalText } from "@/lib/validation";

/**
 * Secret references point at a value held in a secret manager; the value itself is never
 * accepted or stored. Patterns mirror the database CHECK constraint.
 */
export const SECRET_REFERENCE_FORMATS: Record<SecretProvider, { scheme: string; pattern: RegExp; example: string }> = {
  // Restricted to QA_-prefixed variables so a reference can't expose the server's own
  // configuration (e.g. env://DATABASE_URL).
  ENV: { scheme: "env://", pattern: /^env:\/\/QA_[A-Z0-9_]+$/, example: "env://QA_STOREFRONT_PASSWORD" },
  VAULT: { scheme: "vault://", pattern: /^vault:\/\/[A-Za-z0-9_./-]+#[A-Za-z0-9_.-]+$/, example: "vault://kv/qa/storefront#password" },
  AWS_SECRETS_MANAGER: {
    scheme: "aws-sm://",
    pattern: /^aws-sm:\/\/[A-Za-z0-9_+=.@/:-]+(#[A-Za-z0-9_.-]+)?$/,
    example: "aws-sm://qa/storefront#password",
  },
  GCP_SECRET_MANAGER: {
    scheme: "gcp-sm://",
    pattern: /^gcp-sm:\/\/projects\/[a-z0-9-]+\/secrets\/[A-Za-z0-9_-]+(\/versions\/(latest|[0-9]+))?$/,
    example: "gcp-sm://projects/acme-qa/secrets/storefront-password/versions/latest",
  },
  AZURE_KEY_VAULT: {
    scheme: "azure-kv://",
    pattern: /^azure-kv:\/\/[a-z0-9-]+\/[A-Za-z0-9-]+(\/[0-9a-f]{32})?$/,
    example: "azure-kv://acme-qa-vault/storefront-password",
  },
  // Created only by the dashboard's credential form (encrypted at rest); can't be typed in.
  LOCAL: { scheme: "local://", pattern: /^local:\/\/[a-z0-9]+$/, example: "local://cm0abc123" },
};

export function providerForReference(reference: string): SecretProvider | null {
  const entry = Object.entries(SECRET_REFERENCE_FORMATS).find(([, f]) => reference.startsWith(f.scheme));
  return (entry?.[0] as SecretProvider | undefined) ?? null;
}

export const secretReferenceInputSchema = z
  .object({
    name: z
      .string({ error: "Name is required" })
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use UPPER_SNAKE_CASE, e.g. TEST_USER_PASSWORD"),
    // Validated on the field itself so it's reported even when other fields are invalid.
    reference: z
      .string({ error: "Reference is required" })
      .trim()
      .min(1, "Reference is required")
      .max(512)
      .superRefine((reference, ctx) => {
        const provider = providerForReference(reference);
        if (provider === "LOCAL") {
          ctx.addIssue({ code: "custom", message: "local:// references are created by the credentials form, not entered by hand" });
        } else if (!provider) {
          ctx.addIssue({
            code: "custom",
            message: "Enter a reference such as env://QA_NAME or vault://path#key — never the secret value itself",
          });
        } else if (!SECRET_REFERENCE_FORMATS[provider].pattern.test(reference)) {
          const { scheme, example } = SECRET_REFERENCE_FORMATS[provider];
          ctx.addIssue({ code: "custom", message: `Invalid ${scheme} reference, e.g. ${example}` });
        }
      }),
    description: optionalText("Description", 500),
  })
  .transform((value) => ({ ...value, provider: providerForReference(value.reference)! }));

export type SecretReferenceInput = z.infer<typeof secretReferenceInputSchema>;
