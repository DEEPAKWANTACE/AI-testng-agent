import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { Actor } from "@/modules/auth/service";
import { addMember, createProject, deleteProject, removeMember, updateMemberRole, updateProject } from "@/modules/projects/actions";
import { getProject, listProjects } from "@/modules/projects/service";
import { createProject as seedProject, createUser, resetDatabase, signInAs, submit } from "../helpers/fixtures";

let owner: Actor, editor: Actor, newcomer: Actor, globalViewer: Actor;
let projectId: string;

beforeEach(async () => {
  await resetDatabase();
  [owner, editor, newcomer, globalViewer] = await Promise.all([
    createUser("QA_ENGINEER"),
    createUser("QA_ENGINEER"),
    createUser("QA_ENGINEER"),
    createUser("VIEWER"),
  ]);
  ({ id: projectId } = await seedProject([
    [owner, "OWNER"],
    [editor, "EDITOR"],
  ]));
});

const memberId = async (user: Actor) =>
  (await db().projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId, userId: user.id } } })).id;

describe("projects", () => {
  it("makes the creator the owner", async () => {
    await signInAs(newcomer);
    const result = await submit(createProject, { name: "New project" });
    const id = result.redirect!.split("/").pop()!;
    expect((await getProject(newcomer, id))?.myRole).toBe("OWNER");
    expect((await listProjects(newcomer)).map((p) => p.name)).toEqual(["New project"]);
  });

  it("stops global viewers creating projects", async () => {
    await signInAs(globalViewer);
    expect((await submit(createProject, { name: "Nope" })).message).toBe("Viewers can't create projects.");
  });

  it("lets only owners update or delete a project", async () => {
    await signInAs(editor);
    expect((await submit(updateProject.bind(null, projectId), { name: "Renamed" })).message).toBe("You don't have permission to do that.");
    expect((await submit(deleteProject.bind(null, projectId))).message).toBe("You don't have permission to do that.");

    await signInAs(owner);
    expect((await submit(updateProject.bind(null, projectId), { name: "Renamed" })).status).toBe("success");
    expect((await submit(deleteProject.bind(null, projectId))).redirect).toBe("/projects");
    expect(await db().project.count()).toBe(0);
  });
});

describe("members", () => {
  it("lets owners add members by email with a role", async () => {
    await signInAs(owner);
    expect((await submit(addMember.bind(null, projectId), { email: newcomer.email.toUpperCase(), role: "VIEWER" })).status).toBe("success");
    expect((await getProject(newcomer, projectId))?.myRole).toBe("VIEWER");
  });

  it("doesn't reveal whether an email has an account", async () => {
    await signInAs(owner);
    const disabled = await createUser("QA_ENGINEER", { status: "DISABLED" });
    for (const email of ["nobody@test.local", disabled.email]) {
      expect((await submit(addMember.bind(null, projectId), { email, role: "VIEWER" })).message).toBe("No active user with that email.");
    }
  });

  it("refuses editors managing members", async () => {
    await signInAs(editor);
    expect((await submit(addMember.bind(null, projectId), { email: newcomer.email, role: "OWNER" })).message).toBe(
      "You don't have permission to do that.",
    );
    expect((await submit(updateMemberRole.bind(null, await memberId(editor)), { role: "OWNER" })).message).toBe(
      "You don't have permission to do that.",
    );
  });

  it("never leaves a project without an owner", async () => {
    await signInAs(owner);
    const ownerMembership = await memberId(owner);
    expect((await submit(updateMemberRole.bind(null, ownerMembership), { role: "EDITOR" })).message).toBe(
      "A project must keep at least one owner.",
    );
    expect((await submit(removeMember.bind(null, ownerMembership))).message).toBe("A project must keep at least one owner.");

    // With a second owner, the first can step down.
    await submit(updateMemberRole.bind(null, await memberId(editor)), { role: "OWNER" });
    expect((await submit(updateMemberRole.bind(null, ownerMembership), { role: "VIEWER" })).status).toBe("success");
  });

  it("removing a member revokes their access immediately", async () => {
    await signInAs(owner);
    await submit(removeMember.bind(null, await memberId(editor)));
    await expect(getProject(editor, projectId)).resolves.toBeNull();
    expect(await listProjects(editor)).toEqual([]);
  });
});
