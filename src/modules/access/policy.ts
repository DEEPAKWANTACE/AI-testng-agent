import type { ProjectRole, UserRole } from "@/generated/prisma/enums";

/**
 * Authorization policy. Pure (no I/O) so it can be tested exhaustively.
 *
 * - Global ADMIN: every permission on every project.
 * - Global VIEWER: read-only, whatever their project role.
 * - Everyone else: permissions come from their role in the project.
 * - Reviewing plans and verifying defects also need a global reviewer role (ADMIN or QA_LEAD).
 */
export type Permission =
  | "project.view"
  | "project.update"
  | "project.delete"
  | "project.members"
  | "application.create"
  | "application.update"
  | "application.delete"
  | "secret.manage"
  | "discovery.run"
  | "suite.edit"
  | "suite.delete"
  | "plan.review"
  | "defect.verify"
  | "run.manage";

const VIEWER: Permission[] = ["project.view"];
const EDITOR: Permission[] = [
  ...VIEWER,
  "application.create",
  "application.update",
  "secret.manage",
  "discovery.run",
  "suite.edit",
  "plan.review",
  "defect.verify",
  "run.manage",
];
const OWNER: Permission[] = [
  ...EDITOR,
  "project.update",
  "project.delete",
  "project.members",
  "application.delete",
  "suite.delete",
];

export const PROJECT_ROLE_PERMISSIONS: Record<ProjectRole, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER),
  EDITOR: new Set(EDITOR),
  OWNER: new Set(OWNER),
};

export const REVIEWER_ROLES: readonly UserRole[] = ["ADMIN", "QA_LEAD"];

export function can(userRole: UserRole, projectRole: ProjectRole | null, permission: Permission): boolean {
  if (userRole === "ADMIN") return true;
  if (!projectRole) return false;
  if (userRole === "VIEWER") return permission === "project.view";
  if ((permission === "plan.review" || permission === "defect.verify") && !REVIEWER_ROLES.includes(userRole)) return false;
  return PROJECT_ROLE_PERMISSIONS[projectRole].has(permission);
}

/** Anyone but a global VIEWER may create a project (and becomes its OWNER). */
export function canCreateProject(userRole: UserRole): boolean {
  return userRole !== "VIEWER";
}
