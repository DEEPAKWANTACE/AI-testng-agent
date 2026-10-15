import "server-only";
import { db } from "@/lib/db";
import { getDummyHash, hashPassword, needsRehash, verifyPassword } from "./password";
import { generateSessionToken, hashSessionToken } from "./tokens";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The authenticated principal passed to every authorization check. */
export type Actor = { id: string; email: string; name: string; role: "ADMIN" | "QA_LEAD" | "QA_ENGINEER" | "VIEWER" };

const actorSelect = { id: true, email: true, name: true, role: true } as const;

/**
 * Checks credentials. Returns the user only when the password matches an ACTIVE account.
 * Unknown emails still pay for a hash comparison so response time doesn't reveal which
 * accounts exist.
 */
export async function authenticate(email: string, password: string): Promise<Actor | null> {
  const user = await db().user.findUnique({
    where: { email: email.toLowerCase() },
    select: { ...actorSelect, status: true, passwordHash: true },
  });

  const valid = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !user.passwordHash || !valid || user.status !== "ACTIVE") return null;

  // Transparently upgrade hashes created with older parameters.
  const data: { lastLoginAt: Date; passwordHash?: string } = { lastLoginAt: new Date() };
  if (needsRehash(user.passwordHash)) data.passwordHash = await hashPassword(password);
  await db().user.update({ where: { id: user.id }, data });

  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db().session.create({ data: { userId, tokenHash: hashSessionToken(token), expiresAt } });
  return { token, expiresAt };
}

/** Resolves a session token to its user; expired sessions and inactive users resolve to null. */
export async function findSessionActor(token: string): Promise<Actor | null> {
  const session = await db().session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: { expiresAt: true, user: { select: { ...actorSelect, status: true } } },
  });
  if (!session || session.expiresAt <= new Date() || session.user.status !== "ACTIVE") return null;
  const { id, email, name, role } = session.user;
  return { id, email, name, role };
}

export async function deleteSession(token: string): Promise<void> {
  await db().session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
}

/** Signs a user out everywhere, e.g. after a password change or when disabling an account. */
export async function deleteUserSessions(userId: string): Promise<void> {
  await db().session.deleteMany({ where: { userId } });
}

export async function purgeExpiredSessions(): Promise<number> {
  const { count } = await db().session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  return count;
}

export async function setPassword(userId: string, password: string): Promise<void> {
  await db().user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password) } });
  await deleteUserSessions(userId);
}
