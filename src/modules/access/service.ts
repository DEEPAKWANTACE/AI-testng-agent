import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { ProjectRole } from "@/generated/prisma/enums";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import type { Actor } from "@/modules/auth/service";
import { can, type Permission } from "./policy";

/** The actor may know the project exists but lacks the permission. */
export class ForbiddenError extends DomainError {
  constructor(message = "You don't have permission to do that.") {
    super(message);
  }
}

/**
 * The record doesn't exist *or* the actor can't see it. Callers can't tell the two apart,
 * so IDs don't leak which projects and applications exist.
 */
export class NotFoundError extends DomainError {
  constructor(what = "Record") {
    super(`${what} not found.`);
  }
}

/** Prisma filter limiting projects to those the actor can view. */
export function projectScope(actor: Actor): Prisma.ProjectWhereInput {
  return actor.role === "ADMIN" ? {} : { members: { some: { userId: actor.id } } };
}

type Client = Prisma.TransactionClient | ReturnType<typeof db>;

export async function getProjectRole(actor: Actor, projectId: string, client: Client = db()): Promise<ProjectRole | null> {
  const member = await client.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: actor.id } },
    select: { role: true },
  });
  return member?.role ?? null;
}

/**
 * Throws unless the actor holds `permission` on the project. Non-members (and missing
 * projects) get NotFoundError; members without the permission get ForbiddenError.
 */
export async function assertProjectPermission(
  actor: Actor,
  projectId: string,
  permission: Permission,
  client: Client = db(),
): Promise<void> {
  const [exists, role] = await Promise.all([
    client.project.count({ where: { id: projectId } }),
    getProjectRole(actor, projectId, client),
  ]);
  if (!exists || (!role && actor.role !== "ADMIN")) throw new NotFoundError("Project");
  if (!can(actor.role, role, permission)) throw new ForbiddenError();
}

/** Resolves an application to its project, then checks the permission there. */
export async function assertApplicationPermission(
  actor: Actor,
  applicationId: string,
  permission: Permission,
  client: Client = db(),
): Promise<{ projectId: string }> {
  const app = await client.application.findUnique({ where: { id: applicationId }, select: { projectId: true } });
  if (!app) throw new NotFoundError("Application");
  try {
    await assertProjectPermission(actor, app.projectId, permission, client);
  } catch (error) {
    if (error instanceof NotFoundError) throw new NotFoundError("Application");
    throw error;
  }
  return app;
}

/** Permission check for UI decisions (showing or hiding controls); never a substitute for the asserts. */
export async function projectPermissions(actor: Actor, projectId: string, permissions: Permission[]) {
  const role = await getProjectRole(actor, projectId);
  return Object.fromEntries(permissions.map((p) => [p, can(actor.role, role, p)])) as Record<Permission, boolean>;
}
