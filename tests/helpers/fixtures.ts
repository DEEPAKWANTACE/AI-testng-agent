import { randomBytes } from "node:crypto";
import type { ProjectRole, UserRole } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { initialActionState, type ActionState } from "@/lib/action-state";
import { hashPassword } from "@/modules/auth/password";
import { createSession, type Actor } from "@/modules/auth/service";
import { SESSION_COOKIE } from "@/modules/auth/session";
import { cookieJar, RedirectError } from "./next-mocks";

export const PASSWORD = "correct-horse-battery";
let passwordHash: Promise<string> | undefined;

/** Empties every application table between tests. */
export async function resetDatabase() {
  const [{ name }] = await db().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (!name.endsWith("_test")) throw new Error(`Refusing to truncate non-test database "${name}"`);
  const tables = await db().$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db().$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

export async function createUser(role: UserRole = "QA_ENGINEER", overrides: { status?: "ACTIVE" | "DISABLED" | "INVITED" } = {}): Promise<Actor> {
  passwordHash ??= hashPassword(PASSWORD);
  const tag = randomBytes(4).toString("hex");
  return db().user.create({
    data: { email: `${role.toLowerCase()}-${tag}@test.local`, name: `${role} ${tag}`, role, passwordHash: await passwordHash, ...overrides },
    select: { id: true, email: true, name: true, role: true },
  });
}

export async function createProject(members: Array<[Actor, ProjectRole]>, status: "ACTIVE" | "ARCHIVED" = "ACTIVE") {
  return db().project.create({
    data: {
      name: `Project ${randomBytes(3).toString("hex")}`,
      status,
      members: { create: members.map(([user, role]) => ({ userId: user.id, role })) },
    },
  });
}

export async function createApplication(projectId: string, name = "App") {
  return db().application.create({
    data: { projectId, name, authorizedUrl: "https://app.test.local", environment: "STAGING" },
  });
}

/** Starts a real session for `actor` and puts its cookie in the mocked cookie jar. */
export async function signInAs(actor: Actor) {
  const { token } = await createSession(actor.id);
  cookieJar.set(SESSION_COOKIE, { value: token });
}

export function signOut() {
  cookieJar.clear();
}

export function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

/** Calls a form action and returns its state, or the redirect location if it redirected. */
export async function submit(
  action: (state: ActionState, formData: FormData) => Promise<ActionState>,
  values: Record<string, string> = {},
): Promise<ActionState & { redirect?: string }> {
  try {
    return await action(initialActionState, form(values));
  } catch (error) {
    if (error instanceof RedirectError) return { status: "success", redirect: error.location };
    throw error;
  }
}
