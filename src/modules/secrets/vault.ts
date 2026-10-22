import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption for credentials typed into the dashboard (LOCAL secrets). AES-256-GCM with a
 * random IV per value; the key comes from SECRETS_ENCRYPTION_KEY (32 bytes, base64) and is
 * never stored in the database. Ciphertext format: iv.tag.data (base64url).
 * Prefer an external secret manager (env://, vault://…) for anything beyond test accounts.
 */

export class VaultKeyError extends Error {}

function key(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) {
    throw new VaultKeyError("SECRETS_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32");
  }
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length !== 32) throw new VaultKeyError("SECRETS_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).");
  return buffer;
}

export function isVaultConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/** `context` (e.g. the secret's id) is authenticated, so ciphertext can't be moved between secrets. */
export function encryptSecret(value: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(payload: string, context: string): string {
  const [iv, tag, data] = payload.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !data) throw new Error("Stored secret is corrupted");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Stored secret couldn't be decrypted (wrong SECRETS_ENCRYPTION_KEY?)");
  }
}
