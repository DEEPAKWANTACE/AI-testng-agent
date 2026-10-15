import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "@/modules/auth/password";
import { generateSessionToken, hashSessionToken } from "@/modules/auth/tokens";

describe("password hashing", () => {
  it("produces a self-describing scrypt hash that never contains the password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(hash).not.toContain("correct horse");
  });

  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("s3cure-passphrase!");
    await expect(verifyPassword("s3cure-passphrase!", hash)).resolves.toBe(true);
    await expect(verifyPassword("s3cure-passphrase", hash)).resolves.toBe(false);
    await expect(verifyPassword("", hash)).resolves.toBe(false);
  });

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password-1"), hashPassword("same-password-1")]);
    expect(a).not.toBe(b);
    await expect(verifyPassword("same-password-1", b)).resolves.toBe(true);
  });

  it("treats Unicode-equivalent passwords the same (NFKC)", async () => {
    const hash = await hashPassword("café-password");
    await expect(verifyPassword("café-password", hash)).resolves.toBe(true);
  });

  it("returns false instead of throwing for malformed or tampered hashes", async () => {
    const hash = await hashPassword("tamper-test-password");
    const parts = hash.split("$");
    const flipped = [...parts.slice(0, 5), parts[5].replace(/^./, (c) => (c === "A" ? "B" : "A"))].join("$");
    for (const bad of ["", "plaintext-password", "bcrypt$foo", "scrypt$x$8$1$abc$def", flipped]) {
      await expect(verifyPassword("tamper-test-password", bad)).resolves.toBe(false);
    }
  });

  it("flags hashes made with other parameters for rehashing", async () => {
    expect(needsRehash(await hashPassword("rehash-check-pass"))).toBe(false);
    expect(needsRehash("scrypt$16384$8$1$c2FsdA$aGFzaA")).toBe(true);
  });
});

describe("session tokens", () => {
  it("are 256-bit random values, stored only as a SHA-256 digest", () => {
    const token = generateSessionToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(generateSessionToken()).not.toBe(token);
    const digest = hashSessionToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
    expect(hashSessionToken(token)).toBe(digest);
  });
});
