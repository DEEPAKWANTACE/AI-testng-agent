import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, isVaultConfigured } from "@/modules/secrets/vault";
import { secretReferenceInputSchema } from "@/modules/secrets/schemas";

const original = process.env.SECRETS_ENCRYPTION_KEY;
beforeEach(() => {
  process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterEach(() => {
  if (original === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = original;
});

describe("credential vault", () => {
  it("round-trips a value and never stores it in the clear", () => {
    const encrypted = encryptSecret("hunter2-Password!", "secret1");
    expect(encrypted).not.toContain("hunter2");
    expect(decryptSecret(encrypted, "secret1")).toBe("hunter2-Password!");
  });

  it("uses a fresh IV, so equal values encrypt differently", () => {
    expect(encryptSecret("same", "a")).not.toBe(encryptSecret("same", "a"));
  });

  it("refuses ciphertext moved to another secret, tampered data, or a different key", () => {
    const encrypted = encryptSecret("value", "secret1");
    expect(() => decryptSecret(encrypted, "secret2")).toThrow(/couldn't be decrypted/);
    const [iv, tag, data] = encrypted.split(".");
    const flipped = Buffer.from(data!, "base64url");
    flipped[0] ^= 1;
    expect(() => decryptSecret([iv, tag, flipped.toString("base64url")].join("."), "secret1")).toThrow();
    process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptSecret(encrypted, "secret1")).toThrow();
  });

  it("fails clearly without a valid key", () => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    expect(isVaultConfigured()).toBe(false);
    expect(() => encryptSecret("x", "a")).toThrow(/SECRETS_ENCRYPTION_KEY/);
    process.env.SECRETS_ENCRYPTION_KEY = "c2hvcnQ=";
    expect(isVaultConfigured()).toBe(false);
  });

  it("local:// references can't be typed in by hand", () => {
    const result = secretReferenceInputSchema.safeParse({ name: "X_Y", reference: "local://abc123" });
    expect(result.success).toBe(false);
  });
});

import { normalizeSecretName, secretValueInputSchema } from "@/modules/secrets/schemas";

describe("typed secret values", () => {
  it("normalises free-form names", () => {
    expect(normalizeSecretName("superayuadmincrm")).toBe("SUPERAYUADMINCRM");
    expect(normalizeSecretName("User name- crm admin")).toBe("USER_NAME_CRM_ADMIN");
    expect(normalizeSecretName("1st user")).toBe("S_1ST_USER");
  });

  it("accepts a value with any name and rejects empty ones", () => {
    expect(secretValueInputSchema.parse({ name: "crm admin", value: "Superadmin@ayucrm123" })).toMatchObject({ name: "CRM_ADMIN", value: "Superadmin@ayucrm123" });
    expect(secretValueInputSchema.safeParse({ name: "crm", value: "" }).success).toBe(false);
    expect(secretValueInputSchema.safeParse({ name: "---", value: "x" }).success).toBe(false);
  });
});
