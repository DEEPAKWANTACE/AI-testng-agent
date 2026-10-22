import "server-only";
import { randomBytes } from "node:crypto";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import type { Actor } from "@/modules/auth/service";
import { encryptSecret, isVaultConfigured } from "./vault";

/**
 * Stores (or replaces) a value typed into the dashboard as an encrypted LOCAL secret and
 * returns its id. The value is never logged or returned.
 */
export async function upsertLocalSecret(
  actor: Actor,
  applicationId: string,
  name: string,
  value: string,
  description = "Entered in the dashboard (encrypted at rest).",
): Promise<string> {
  if (!isVaultConfigured()) {
    throw new DomainError("Credential storage isn't configured: set SECRETS_ENCRYPTION_KEY on the server (openssl rand -base64 32), or use an env:// reference.");
  }
  const existing = await db().applicationSecret.findUnique({ where: { applicationId_name: { applicationId, name } }, select: { id: true } });
  const id = existing?.id ?? `c${randomBytes(12).toString("hex")}`;
  const data = { provider: "LOCAL" as const, reference: `local://${id}`, encryptedValue: encryptSecret(value, id), description };
  if (existing) await db().applicationSecret.update({ where: { id }, data });
  else await db().applicationSecret.create({ data: { id, applicationId, name, createdById: actor.id, ...data } });
  return id;
}
