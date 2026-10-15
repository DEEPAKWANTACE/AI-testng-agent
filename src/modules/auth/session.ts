import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { findSessionActor, type Actor } from "./service";

export const SESSION_COOKIE = "qa_session";

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * The signed-in user for this request, verified against the database (Data Access Layer).
 * Memoised per request with React `cache`, deliberately not `use cache: private`, so a
 * revoked session or disabled account takes effect on the very next request.
 */
export const getCurrentActor = cache(async (): Promise<Actor | null> => {
  const token = await readSessionToken();
  return token ? findSessionActor(token) : null;
});

/** For pages and Server Actions: the signed-in user, or a redirect to the sign-in page. */
export async function requireActor(): Promise<Actor> {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  return actor;
}
