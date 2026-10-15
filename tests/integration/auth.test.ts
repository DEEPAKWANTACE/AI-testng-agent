import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { login, logout } from "@/modules/auth/actions";
import { authenticate, createSession, findSessionActor, purgeExpiredSessions, setPassword } from "@/modules/auth/service";
import { getCurrentActor, requireActor, SESSION_COOKIE } from "@/modules/auth/session";
import { hashSessionToken } from "@/modules/auth/tokens";
import { createUser, PASSWORD, resetDatabase, submit } from "../helpers/fixtures";
import { cookieJar, RedirectError, requestHeaders } from "../helpers/next-mocks";

beforeEach(resetDatabase);

describe("authenticate", () => {
  it("returns the user for correct credentials, case-insensitively by email", async () => {
    const user = await createUser("QA_ENGINEER");
    await expect(authenticate(user.email.toUpperCase(), PASSWORD)).resolves.toMatchObject({ id: user.id });
    const { lastLoginAt } = await db().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(lastLoginAt).toBeInstanceOf(Date);
  });

  it("rejects wrong passwords, unknown users and inactive accounts identically", async () => {
    const user = await createUser();
    const disabled = await createUser("QA_ENGINEER", { status: "DISABLED" });
    const invited = await createUser("QA_ENGINEER", { status: "INVITED" });
    await expect(authenticate(user.email, "wrong-password-123")).resolves.toBeNull();
    await expect(authenticate("nobody@test.local", PASSWORD)).resolves.toBeNull();
    await expect(authenticate(disabled.email, PASSWORD)).resolves.toBeNull();
    await expect(authenticate(invited.email, PASSWORD)).resolves.toBeNull();
  });

  it("rejects accounts without a password", async () => {
    const user = await createUser();
    await db().user.update({ where: { id: user.id }, data: { passwordHash: null } });
    await expect(authenticate(user.email, PASSWORD)).resolves.toBeNull();
  });
});

describe("sessions", () => {
  it("stores only a hash of the token", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    const stored = await db().session.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored.tokenHash).toBe(hashSessionToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("resolves valid sessions and rejects expired ones, unknown tokens and disabled users", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    await expect(findSessionActor(token)).resolves.toMatchObject({ id: user.id });
    await expect(findSessionActor("forged-token")).resolves.toBeNull();

    await db().session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(findSessionActor(token)).resolves.toBeNull();
    expect(await purgeExpiredSessions()).toBe(1);

    const { token: fresh } = await createSession(user.id);
    await db().user.update({ where: { id: user.id }, data: { status: "DISABLED" } });
    await expect(findSessionActor(fresh)).resolves.toBeNull();
  });

  it("revokes every session when the password changes", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    await setPassword(user.id, "brand-new-password-1");
    await expect(findSessionActor(token)).resolves.toBeNull();
    await expect(authenticate(user.email, "brand-new-password-1")).resolves.toMatchObject({ id: user.id });
    await expect(authenticate(user.email, PASSWORD)).resolves.toBeNull();
  });

  it("requireActor redirects to /login without a valid session", async () => {
    await expect(requireActor()).rejects.toThrow(RedirectError);
    cookieJar.set(SESSION_COOKIE, { value: "not-a-real-session" });
    await expect(getCurrentActor()).resolves.toBeNull();
  });
});

describe("login and logout actions", () => {
  it("signs in, sets a hardened cookie and redirects to a safe destination", async () => {
    const user = await createUser();
    const result = await submit(login, { email: user.email, password: PASSWORD, next: "/applications" });
    expect(result.redirect).toBe("/applications");

    const cookie = cookieJar.get(SESSION_COOKIE);
    expect(cookie?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    await expect(findSessionActor(cookie!.value)).resolves.toMatchObject({ id: user.id });
  });

  it.each(["//evil.example.com", "https://evil.example.com", "/\\evil.example.com"])(
    "ignores the open-redirect attempt %s",
    async (next) => {
      const user = await createUser();
      expect((await submit(login, { email: user.email, password: PASSWORD, next })).redirect).toBe("/");
    },
  );

  it("returns one generic error, sets no cookie and never echoes the password", async () => {
    const user = await createUser();
    const result = await submit(login, { email: user.email, password: "wrong-password-123" });
    expect(result).toMatchObject({ status: "error", message: "Invalid email or password." });
    expect(result.values).toEqual({ email: user.email });
    expect(JSON.stringify(result)).not.toContain("wrong-password-123");
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
  });

  it("validates input on the server", async () => {
    const result = await submit(login, { email: "not-an-email", password: "" });
    expect(result.status).toBe("error");
    expect(Object.keys(result.fieldErrors ?? {}).sort()).toEqual(["email", "password"]);
  });

  it("rate-limits repeated failures, even for the right password", async () => {
    const user = await createUser();
    requestHeaders.set("x-forwarded-for", "198.51.100.7");
    for (let i = 0; i < 5; i++) await submit(login, { email: user.email, password: `wrong-${i}-password` });
    const result = await submit(login, { email: user.email, password: PASSWORD });
    expect(result.message).toContain("Too many failed attempts");
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
  });

  it("logout deletes the session server-side and clears the cookie", async () => {
    const user = await createUser();
    const { token } = await createSession(user.id);
    cookieJar.set(SESSION_COOKIE, { value: token });
    await expect(logout()).rejects.toMatchObject({ location: "/login" });
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
    await expect(findSessionActor(token)).resolves.toBeNull();
  });
});
