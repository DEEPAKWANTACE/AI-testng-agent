import "server-only";
import type { ProjectRole } from "@/generated/prisma/enums";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import { assertProjectPermission, ForbiddenError, getProjectRole, NotFoundError, projectScope } from "@/modules/access/service";
import { can, canCreateProject } from "@/modules/access/policy";
import type { Actor } from "@/modules/auth/service";
import type { MemberInput, ProjectInput } from "./schemas";

// ─── Reads ──────────────────────────────────────────────────────────────────

export function listProjects(actor: Actor) {
  return db().project.findMany({
    where: projectScope(actor),
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { applications: true, members: true } } },
  });
}

/** Active projects where the actor may create applications. */
export async function listProjectsForNewApplications(actor: Actor) {
  if (actor.role === "VIEWER") return [];
  return db().project.findMany({
    where:
      actor.role === "ADMIN"
        ? { status: "ACTIVE" }
        : { status: "ACTIVE", members: { some: { userId: actor.id, role: { in: ["OWNER", "EDITOR"] } } } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

/** Returns null when the project doesn't exist or the actor can't see it. */
export async function getProject(actor: Actor, id: string) {
  const project = await db().project.findFirst({
    where: { id, ...projectScope(actor) },
    include: {
      applications: {
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { testSuites: true, discoveryRuns: true } } },
      },
      members: {
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
        include: { user: { select: { id: true, name: true, email: true, status: true } } },
      },
    },
  });
  if (!project) return null;

  const role = await getProjectRole(actor, id);
  return {
    ...project,
    myRole: role,
    permissions: {
      update: can(actor.role, role, "project.update"),
      delete: can(actor.role, role, "project.delete"),
      members: can(actor.role, role, "project.members"),
      createApplication: can(actor.role, role, "application.create"),
    },
  };
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export async function createProject(actor: Actor, input: ProjectInput) {
  if (!canCreateProject(actor.role)) throw new ForbiddenError("Viewers can't create projects.");
  // The creator becomes the project's first owner.
  return db().project.create({
    data: { ...input, members: { create: { userId: actor.id, role: "OWNER" } } },
    select: { id: true },
  });
}

export async function updateProject(actor: Actor, id: string, input: ProjectInput) {
  await assertProjectPermission(actor, id, "project.update");
  return db().project.update({ where: { id }, data: input, select: { id: true } });
}

export async function deleteProject(actor: Actor, id: string) {
  await assertProjectPermission(actor, id, "project.delete");
  const active = await db().testRun.count({
    where: { planVersion: { suite: { application: { projectId: id } } }, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (active > 0) throw new DomainError("Cancel this project's queued or running test runs first.");
  await db().project.delete({ where: { id } });
}

export async function addMember(actor: Actor, projectId: string, input: MemberInput) {
  await assertProjectPermission(actor, projectId, "project.members");
  const user = await db().user.findUnique({ where: { email: input.email }, select: { id: true, status: true } });
  // Same message for unknown and disabled users, so this can't be used to enumerate accounts.
  if (!user || user.status === "DISABLED") throw new DomainError("No active user with that email.");
  const existing = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
    select: { id: true },
  });
  if (existing) throw new DomainError("That user is already a member of this project.");
  return db().projectMember.create({ data: { projectId, userId: user.id, role: input.role }, select: { id: true } });
}

/** Changes or removes a membership without ever leaving the project ownerless. */
async function changeMembership(actor: Actor, memberId: string, nextRole: ProjectRole | null) {
  const member = await db().projectMember.findUnique({ where: { id: memberId }, select: { projectId: true, role: true } });
  if (!member) throw new NotFoundError("Member");
  await assertProjectPermission(actor, member.projectId, "project.members");

  await db().$transaction(async (tx) => {
    // Lock the project's owner rows so concurrent changes can't remove the last owner.
    const owners = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ProjectMember" WHERE "projectId" = ${member.projectId} AND "role" = 'OWNER' FOR UPDATE`;
    const losingOwner = member.role === "OWNER" && nextRole !== "OWNER";
    if (losingOwner && owners.length <= 1) throw new DomainError("A project must keep at least one owner.");

    if (nextRole) await tx.projectMember.update({ where: { id: memberId }, data: { role: nextRole } });
    else await tx.projectMember.delete({ where: { id: memberId } });
  });
}

export function updateMemberRole(actor: Actor, memberId: string, role: ProjectRole) {
  return changeMembership(actor, memberId, role);
}

export function removeMember(actor: Actor, memberId: string) {
  return changeMembership(actor, memberId, null);
}
