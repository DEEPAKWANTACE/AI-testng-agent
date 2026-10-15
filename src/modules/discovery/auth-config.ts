import "server-only";
import { z } from "zod";
import { DiscoveryAuthMode } from "@/generated/prisma/enums";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import { assertApplicationPermission } from "@/modules/access/service";
import { isWithinAuthorizedUrl } from "@/modules/applications/authorized-url";
import type { Actor } from "@/modules/auth/service";

const emptyToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);

/**
 * CSS selectors only. Playwright also accepts engine prefixes (xpath=, text=, internal:…) and
 * auto-detects XPath (`//`, `..`) and text (quoted) selectors; those are refused.
 */
const NON_CSS_SELECTOR = /^\s*(?:[a-z_][\w-]*\s*=|internal:|_react|_vue|\/\/|\.\.|["'])/i;
const selector = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .max(200, "Selector is too long")
    .refine((value) => !NON_CSS_SELECTOR.test(value) && !/[\u0000-\u001f]/.test(value), "Use a CSS selector, e.g. #email or form.login button")
    .nullable()
    .optional(),
);
const optionalId = z.preprocess(emptyToNull, z.cuid({ error: "Select a secret" }).nullable().optional());

export const discoveryAuthInputSchema = z
  .object({
    mode: z.enum(DiscoveryAuthMode, { error: "Choose how discovery signs in" }),
    loginUrl: z.preprocess(emptyToNull, z.url({ protocol: /^https?$/, error: "Enter the full login page URL" }).nullable().optional()),
    usernameSecretId: optionalId,
    passwordSecretId: optionalId,
    usernameSelector: selector,
    passwordSelector: selector,
    submitSelector: selector,
    successSelector: selector,
  })
  .superRefine((value, ctx) => {
    if (value.mode !== "FORM_LOGIN") return;
    if (!value.loginUrl) ctx.addIssue({ code: "custom", path: ["loginUrl"], message: "Login URL is required for form login" });
    if (!value.usernameSecretId) ctx.addIssue({ code: "custom", path: ["usernameSecretId"], message: "Select the username secret" });
    if (!value.passwordSecretId) ctx.addIssue({ code: "custom", path: ["passwordSecretId"], message: "Select the password secret" });
  });

export type DiscoveryAuthInput = z.infer<typeof discoveryAuthInputSchema>;

export async function saveDiscoveryAuth(actor: Actor, applicationId: string, input: DiscoveryAuthInput) {
  await assertApplicationPermission(actor, applicationId, "secret.manage");
  const app = await db().application.findUniqueOrThrow({
    where: { id: applicationId },
    select: { authorizedUrl: true, secrets: { select: { id: true } } },
  });

  if (input.mode === "FORM_LOGIN") {
    if (!isWithinAuthorizedUrl(input.loginUrl!, app.authorizedUrl)) {
      throw new DomainError(`The login URL must be within the authorized URL (${app.authorizedUrl}).`);
    }
    // Secrets must belong to this application; IDs from other applications are refused.
    const own = new Set(app.secrets.map((secret) => secret.id));
    if (!own.has(input.usernameSecretId!) || !own.has(input.passwordSecretId!)) {
      throw new DomainError("Choose secret references that belong to this application.");
    }
  }

  const data =
    input.mode === "FORM_LOGIN"
      ? input
      : { mode: input.mode, loginUrl: null, usernameSecretId: null, passwordSecretId: null, usernameSelector: null, passwordSelector: null, submitSelector: null, successSelector: null };
  await db().discoveryAuthConfig.upsert({ where: { applicationId }, create: { applicationId, ...data }, update: data });
}
