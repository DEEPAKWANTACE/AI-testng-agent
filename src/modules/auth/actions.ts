"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { failure, validationError, type ActionState } from "@/lib/action-state";
import { formDataToObject } from "@/lib/validation";
import { clearFailures, isRateLimited, recordFailure } from "./rate-limit";
import { loginSchema } from "./schemas";
import { authenticate, createSession, deleteSession } from "./service";
import { clearSessionCookie, readSessionToken, setSessionCookie } from "./session";

const GENERIC_FAILURE = "Invalid email or password.";

/** Only same-site relative paths are allowed as post-login destinations (no open redirects). */
function safeNextPath(value: string | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}

export async function login(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = formDataToObject(formData);
  // Never echo the password back to the client.
  const echoed = { email: values.email ?? "" };
  const parsed = loginSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, echoed);

  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const keys = [`email:${parsed.data.email}`, `ip:${ip}`];
  if (isRateLimited(keys)) return failure("Too many failed attempts. Try again in a few minutes.", echoed);

  const actor = await authenticate(parsed.data.email, parsed.data.password);
  if (!actor) {
    recordFailure(keys);
    return failure(GENERIC_FAILURE, echoed);
  }

  clearFailures(keys);
  const { token, expiresAt } = await createSession(actor.id);
  await setSessionCookie(token, expiresAt);
  redirect(safeNextPath(values.next));
}

export async function logout(): Promise<void> {
  const token = await readSessionToken();
  if (token) await deleteSession(token);
  await clearSessionCookie();
  redirect("/login");
}
