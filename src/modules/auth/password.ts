import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt (memory-hard, built into Node — no native dependencies).
 * Hashes are self-describing (`scrypt$N$r$p$salt$hash`, base64url) so parameters can be
 * raised later without breaking existing hashes. Plaintext passwords are never stored.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
// scrypt needs ~128 * N * r bytes; allow headroom above Node's 32 MiB default.
const MAX_MEMORY = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEMORY });
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Constant-time comparison; returns false (never throws) for malformed hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isSafeInteger)) return false;

  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAX_MEMORY });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a hash was produced with weaker parameters than the current ones. */
export function needsRehash(stored: string): boolean {
  const [, N, r, p] = stored.split("$").map(Number);
  return N !== PARAMS.N || r !== PARAMS.r || p !== PARAMS.p;
}

// A real hash of a random password, used to equalise timing when the user doesn't exist.
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString("base64url"));
  return dummyHash;
}
