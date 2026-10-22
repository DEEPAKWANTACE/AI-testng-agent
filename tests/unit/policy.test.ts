import { describe, expect, it } from "vitest";
import { can, canCreateProject, PROJECT_ROLE_PERMISSIONS, type Permission } from "@/modules/access/policy";

const ALL: Permission[] = [
  "project.view",
  "project.update",
  "project.delete",
  "project.members",
  "application.create",
  "application.update",
  "application.delete",
  "secret.manage",
  "discovery.run",
  "suite.edit",
  "suite.delete",
  "plan.review",
  "defect.verify",
  "run.manage",
];

const allowed = (...args: Parameters<typeof can> extends [infer U, infer P, unknown] ? [U, P] : never) =>
  ALL.filter((permission) => can(args[0], args[1], permission));

describe("authorization policy", () => {
  it("gives global admins every permission, even without membership", () => {
    expect(allowed("ADMIN", null)).toEqual(ALL);
  });

  it("denies everything to non-members", () => {
    for (const role of ["QA_LEAD", "QA_ENGINEER", "VIEWER"] as const) expect(allowed(role, null)).toEqual([]);
  });

  it("lets project viewers only view", () => {
    expect(allowed("QA_ENGINEER", "VIEWER")).toEqual(["project.view"]);
  });

  it("lets editors manage applications, secrets and tests but not delete or manage members", () => {
    expect(allowed("QA_ENGINEER", "EDITOR")).toEqual([
      "project.view",
      "application.create",
      "application.update",
      "secret.manage",
      "discovery.run",
      "suite.edit",
      "run.manage",
    ]);
  });

  it("lets owners do everything except review without a reviewer role", () => {
    expect(allowed("QA_ENGINEER", "OWNER")).toEqual(ALL.filter((p) => p !== "plan.review" && p !== "defect.verify"));
    expect(allowed("QA_LEAD", "OWNER")).toEqual(ALL);
  });

  it("requires a reviewer role and at least editor access to review plans", () => {
    expect(can("QA_LEAD", "EDITOR", "plan.review")).toBe(true);
    expect(can("QA_LEAD", "VIEWER", "plan.review")).toBe(false);
    expect(can("QA_ENGINEER", "EDITOR", "plan.review")).toBe(false);
  });

  it("requires a reviewer role and at least editor access to verify defects", () => {
    expect(can("QA_LEAD", "EDITOR", "defect.verify")).toBe(true);
    expect(can("QA_LEAD", "VIEWER", "defect.verify")).toBe(false);
    expect(can("QA_ENGINEER", "OWNER", "defect.verify")).toBe(false);
    expect(can("VIEWER", "OWNER", "defect.verify")).toBe(false);
  });

  it("caps global viewers at read-only whatever their project role", () => {
    expect(allowed("VIEWER", "OWNER")).toEqual(["project.view"]);
  });

  it("keeps role permissions strictly nested", () => {
    for (const p of PROJECT_ROLE_PERMISSIONS.VIEWER) expect(PROJECT_ROLE_PERMISSIONS.EDITOR.has(p)).toBe(true);
    for (const p of PROJECT_ROLE_PERMISSIONS.EDITOR) expect(PROJECT_ROLE_PERMISSIONS.OWNER.has(p)).toBe(true);
  });

  it("lets everyone but global viewers create projects", () => {
    expect(["ADMIN", "QA_LEAD", "QA_ENGINEER", "VIEWER"].map((r) => canCreateProject(r as never))).toEqual([true, true, true, false]);
  });
});
