import "server-only";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import {
  assertApplicationPermission,
  assertProjectPermission,
  getProjectRole,
  NotFoundError,
  projectScope,
} from "@/modules/access/service";
import { can } from "@/modules/access/policy";
import type { Actor } from "@/modules/auth/service";
import { secretAvailability } from "@/modules/secrets/resolver";
import type { SecretReferenceInput } from "@/modules/secrets/schemas";
import { BLOCK_REASON_LABELS, staticUrlBlockReason } from "@/modules/discovery/network-policy";
import type { ApplicationInput } from "./schemas";

/** The agent may only be pointed at public hosts (local/private/metadata targets are refused). */
function assertTestableUrl(authorizedUrl: string) {
  const reason = staticUrlBlockReason(authorizedUrl);
  if (reason) {
    throw new DomainError(
      `The authorized URL points to a ${BLOCK_REASON_LABELS[reason].toLowerCase()}, which the agent isn't allowed to test.`,
    );
  }
}

async function assertProjectActive(projectId: string) {
  const project = await db().project.findUnique({ where: { id: projectId }, select: { status: true } });
  if (project?.status !== "ACTIVE") throw new DomainError("Applications can only be added to active projects.");
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export function listApplications(actor: Actor) {
  return db().application.findMany({
    where: { project: projectScope(actor) },
    orderBy: { createdAt: "desc" },
    include: {
      project: { select: { id: true, name: true } },
      _count: { select: { testSuites: true, discoveryRuns: true } },
    },
  });
}

/** Applications in active projects the actor can see (for pickers). */
export function listApplicationOptions(actor: Actor) {
  return db().application.findMany({
    where: { project: { ...projectScope(actor), status: "ACTIVE" } },
    orderBy: [{ project: { name: "asc" } }, { name: "asc" }],
    select: { id: true, name: true, authorizedUrl: true, project: { select: { name: true } } },
  });
}

/** Returns null when the application doesn't exist or the actor can't see it. */
export async function getApplication(actor: Actor, id: string) {
  const app = await db().application.findFirst({
    where: { id, project: projectScope(actor) },
    include: {
      project: { select: { id: true, name: true } },
      secrets: { orderBy: { name: "asc" } },
      discoveryAuth: true,
      features: { orderBy: { name: "asc" }, select: { id: true, name: true, status: true, source: true } },
      discoveryRuns: { orderBy: { createdAt: "desc" }, take: 10, include: { _count: { select: { features: true } } } },
      testSuites: {
        orderBy: { updatedAt: "desc" },
        include: {
          planVersions: { orderBy: { version: "desc" }, take: 1, select: { version: true, status: true } },
          _count: { select: { testCases: { where: { status: "ACTIVE" } } } },
        },
      },
    },
  });
  if (!app) return null;

  const role = await getProjectRole(actor, app.projectId);
  const permissions = {
    update: can(actor.role, role, "application.update"),
    delete: can(actor.role, role, "application.delete"),
    manageSecrets: can(actor.role, role, "secret.manage"),
  };

  // Secret references reveal where credentials live, so only people who can manage them see
  // the reference. Values are never loaded at all.
  const secrets = app.secrets.map(({ id, name, provider, description, reference, updatedAt }) => ({
    id,
    name,
    provider,
    description,
    updatedAt,
    reference: permissions.manageSecrets ? reference : null,
    availability: secretAvailability(reference),
  }));

  return { ...app, secrets, permissions };
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export async function createApplication(actor: Actor, input: ApplicationInput) {
  await assertProjectPermission(actor, input.projectId, "application.create");
  await assertProjectActive(input.projectId);
  assertTestableUrl(input.authorizedUrl);
  return db().application.create({ data: input, select: { id: true } });
}

export async function updateApplication(actor: Actor, id: string, input: ApplicationInput) {
  const { projectId } = await assertApplicationPermission(actor, id, "application.update");
  assertTestableUrl(input.authorizedUrl);
  if (input.projectId !== projectId) {
    // Moving an application needs the right to create applications in the target project.
    await assertProjectPermission(actor, input.projectId, "application.create");
    await assertProjectActive(input.projectId);
  }
  return db().application.update({ where: { id }, data: input, select: { id: true } });
}

export async function deleteApplication(actor: Actor, id: string) {
  await assertApplicationPermission(actor, id, "application.delete");
  const active = await db().testRun.count({
    where: { planVersion: { suite: { applicationId: id } }, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (active > 0) throw new DomainError("Cancel this application's queued or running test runs first.");
  await db().application.delete({ where: { id } });
}

export async function addSecretReference(actor: Actor, applicationId: string, input: SecretReferenceInput) {
  await assertApplicationPermission(actor, applicationId, "secret.manage");
  return db().applicationSecret.create({
    data: { ...input, applicationId, createdById: actor.id },
    select: { id: true },
  });
}

export async function removeSecretReference(actor: Actor, secretId: string) {
  const secret = await db().applicationSecret.findUnique({ where: { id: secretId }, select: { applicationId: true } });
  if (!secret) throw new NotFoundError("Secret reference");
  await assertApplicationPermission(actor, secret.applicationId, "secret.manage");
  const inUse = await db().discoveryAuthConfig.count({ where: { OR: [{ usernameSecretId: secretId }, { passwordSecretId: secretId }] } });
  if (inUse) throw new DomainError("This secret is used by discovery login. Change the login settings first.");
  await db().applicationSecret.delete({ where: { id: secretId } });
}
