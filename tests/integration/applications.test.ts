import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { Actor } from "@/modules/auth/service";
import {
  addSecretReference,
  createApplication,
  deleteApplication,
  removeSecretReference,
  updateApplication,
} from "@/modules/applications/actions";
import { getApplication, listApplications } from "@/modules/applications/service";
import { createApplication as seedApp, createProject, createUser, resetDatabase, signInAs, signOut, submit } from "../helpers/fixtures";

let owner: Actor, editor: Actor, viewer: Actor, outsider: Actor, admin: Actor, globalViewer: Actor;
let projectId: string;

const appInput = (overrides: Record<string, string> = {}) => ({
  projectId,
  name: "Storefront",
  authorizedUrl: "https://staging.example.com/",
  environment: "STAGING",
  type: "WEB",
  repoUrl: "https://github.com/acme/storefront",
  repoBranch: "main",
  ...overrides,
});

beforeEach(async () => {
  await resetDatabase();
  [owner, editor, viewer, outsider, admin, globalViewer] = await Promise.all([
    createUser("QA_ENGINEER"),
    createUser("QA_ENGINEER"),
    createUser("QA_ENGINEER"),
    createUser("QA_ENGINEER"),
    createUser("ADMIN"),
    createUser("VIEWER"),
  ]);
  ({ id: projectId } = await createProject([
    [owner, "OWNER"],
    [editor, "EDITOR"],
    [viewer, "VIEWER"],
    [globalViewer, "OWNER"],
  ]));
});

describe("create", () => {
  it("lets an editor create an application with normalised, validated fields", async () => {
    await signInAs(editor);
    const result = await submit(createApplication, appInput());
    expect(result.redirect).toMatch(/^\/applications\/c[a-z0-9]+$/);

    const app = await db().application.findFirstOrThrow({ where: { projectId } });
    expect(app).toMatchObject({
      name: "Storefront",
      authorizedUrl: "https://staging.example.com",
      environment: "STAGING",
      repoUrl: "https://github.com/acme/storefront",
      repoBranch: "main",
    });
  });

  it("creates without a repository (branch and repo are optional)", async () => {
    await signInAs(owner);
    const result = await submit(createApplication, appInput({ repoUrl: "", repoBranch: "" }));
    expect(result.redirect).toBeDefined();
    expect(await db().application.findFirstOrThrow({ where: { projectId } })).toMatchObject({ repoUrl: null, repoBranch: null });
  });

  it("returns field errors and keeps the input when validation fails", async () => {
    await signInAs(editor);
    const result = await submit(
      createApplication,
      appInput({ name: "", authorizedUrl: "https://user:pass@staging.example.com", repoUrl: "", repoBranch: "main" }),
    );
    expect(result.status).toBe("error");
    expect(Object.keys(result.fieldErrors ?? {}).sort()).toEqual(["authorizedUrl", "name", "repoBranch"]);
    expect(result.values?.authorizedUrl).toBe("https://user:pass@staging.example.com");
    expect(await db().application.count()).toBe(0);
  });

  it("rejects repository URLs carrying tokens", async () => {
    await signInAs(editor);
    const result = await submit(createApplication, appInput({ repoUrl: "https://ghp_abc123@github.com/acme/storefront" }));
    expect(result.fieldErrors?.repoUrl?.[0]).toContain("credentials");
    expect(await db().application.count()).toBe(0);
  });

  it("refuses project viewers and global viewers", async () => {
    for (const actor of [viewer, globalViewer]) {
      await signInAs(actor);
      expect(await submit(createApplication, appInput())).toMatchObject({ status: "error", message: "You don't have permission to do that." });
    }
    expect(await db().application.count()).toBe(0);
  });

  it("hides the project's existence from non-members", async () => {
    await signInAs(outsider);
    expect(await submit(createApplication, appInput())).toMatchObject({ status: "error", message: "Project not found." });
  });

  it("lets a global admin create in any project", async () => {
    await signInAs(admin);
    expect((await submit(createApplication, appInput())).redirect).toBeDefined();
  });

  it("requires authentication", async () => {
    signOut();
    expect((await submit(createApplication, appInput())).redirect).toBe("/login");
    expect(await db().application.count()).toBe(0);
  });

  it("rejects duplicate names within a project and archived projects", async () => {
    await signInAs(editor);
    await submit(createApplication, appInput());
    expect((await submit(createApplication, appInput())).message).toContain("conflicts with an existing record");

    await db().project.update({ where: { id: projectId }, data: { status: "ARCHIVED" } });
    expect((await submit(createApplication, appInput({ name: "Other" }))).message).toBe(
      "Applications can only be added to active projects.",
    );
  });
});

describe("read", () => {
  it("lists only applications in projects the actor belongs to", async () => {
    const { id: otherProject } = await createProject([[outsider, "OWNER"]]);
    await seedApp(projectId, "Mine");
    await seedApp(otherProject, "Theirs");

    expect((await listApplications(viewer)).map((a) => a.name)).toEqual(["Mine"]);
    expect((await listApplications(outsider)).map((a) => a.name)).toEqual(["Theirs"]);
    expect((await listApplications(admin)).map((a) => a.name).sort()).toEqual(["Mine", "Theirs"]);
  });

  it("returns null for applications the actor can't see", async () => {
    const app = await seedApp(projectId);
    await expect(getApplication(outsider, app.id)).resolves.toBeNull();
    await expect(getApplication(viewer, app.id)).resolves.toMatchObject({ id: app.id });
  });

  it("reports per-role permissions for the UI", async () => {
    const app = await seedApp(projectId);
    expect((await getApplication(viewer, app.id))?.permissions).toEqual({ update: false, delete: false, manageSecrets: false });
    expect((await getApplication(editor, app.id))?.permissions).toEqual({ update: true, delete: false, manageSecrets: true });
    expect((await getApplication(owner, app.id))?.permissions).toEqual({ update: true, delete: true, manageSecrets: true });
  });
});

describe("update", () => {
  it("lets an editor change every field, including clearing the repository", async () => {
    const app = await seedApp(projectId);
    await signInAs(editor);
    const result = await submit(
      updateApplication.bind(null, app.id),
      appInput({ name: "Renamed", authorizedUrl: "https://prod.example.com/shop", environment: "PRODUCTION", repoUrl: "git@github.com:acme/shop.git", repoBranch: "release/2.4" }),
    );
    expect(result).toMatchObject({ status: "success", message: "Application saved." });
    expect(await db().application.findUniqueOrThrow({ where: { id: app.id } })).toMatchObject({
      name: "Renamed",
      authorizedUrl: "https://prod.example.com/shop",
      environment: "PRODUCTION",
      repoUrl: "git@github.com:acme/shop.git",
      repoBranch: "release/2.4",
    });

    await submit(updateApplication.bind(null, app.id), appInput({ repoUrl: "", repoBranch: "" }));
    expect(await db().application.findUniqueOrThrow({ where: { id: app.id } })).toMatchObject({ repoUrl: null, repoBranch: null });
  });

  it("refuses viewers and non-members without changing anything", async () => {
    const app = await seedApp(projectId, "Original");
    await signInAs(viewer);
    expect((await submit(updateApplication.bind(null, app.id), appInput({ name: "Hacked" }))).message).toBe(
      "You don't have permission to do that.",
    );
    await signInAs(outsider);
    expect((await submit(updateApplication.bind(null, app.id), appInput({ name: "Hacked" }))).message).toBe("Application not found.");
    expect((await db().application.findUniqueOrThrow({ where: { id: app.id } })).name).toBe("Original");
  });

  it("only moves an application to a project where the actor may create applications", async () => {
    const app = await seedApp(projectId);
    const { id: foreign } = await createProject([[outsider, "OWNER"]]);
    const { id: shared } = await createProject([[editor, "EDITOR"]]);
    await signInAs(editor);

    expect((await submit(updateApplication.bind(null, app.id), appInput({ projectId: foreign }))).message).toBe("Project not found.");
    expect((await submit(updateApplication.bind(null, app.id), appInput({ projectId: shared }))).status).toBe("success");
    expect((await db().application.findUniqueOrThrow({ where: { id: app.id } })).projectId).toBe(shared);
  });

  it("rejects malformed ids", async () => {
    await signInAs(owner);
    expect((await submit(updateApplication.bind(null, "../../etc"), appInput())).message).toBe("Invalid application");
  });
});

describe("delete", () => {
  it("is owner-only and cascades to secret references", async () => {
    const app = await seedApp(projectId);
    await db().applicationSecret.create({
      data: { applicationId: app.id, name: "TOKEN", provider: "ENV", reference: "env://QA_TOKEN" },
    });

    await signInAs(editor);
    expect((await submit(deleteApplication.bind(null, app.id))).message).toBe("You don't have permission to do that.");

    await signInAs(owner);
    expect((await submit(deleteApplication.bind(null, app.id))).redirect).toBe("/applications");
    expect(await db().application.count()).toBe(0);
    expect(await db().applicationSecret.count()).toBe(0);
  });

  it("is blocked while test runs are queued", async () => {
    const app = await seedApp(projectId);
    const suite = await db().testSuite.create({ data: { applicationId: app.id, name: "Suite" } });
    const version = await db().planVersion.create({
      data: { suiteId: suite.id, version: 1, status: "APPROVED", snapshot: {}, caseCount: 0 },
    });
    await db().testRun.create({ data: { planVersionId: version.id, baseUrl: app.authorizedUrl } });

    await signInAs(owner);
    expect((await submit(deleteApplication.bind(null, app.id))).message).toContain("Cancel this application's queued");
    expect(await db().application.count()).toBe(1);
  });
});

describe("secret references", () => {
  it("stores a reference — never a value — and attributes it to the creator", async () => {
    const app = await seedApp(projectId);
    await signInAs(editor);
    const result = await submit(addSecretReference.bind(null, app.id), {
      name: "TEST_USER_PASSWORD",
      reference: "vault://kv/qa/storefront#password",
      description: "Shared test customer",
    });
    expect(result).toMatchObject({ status: "success" });
    expect(await db().applicationSecret.findFirstOrThrow()).toMatchObject({
      name: "TEST_USER_PASSWORD",
      provider: "VAULT",
      reference: "vault://kv/qa/storefront#password",
      createdById: editor.id,
    });
  });

  it("rejects pasted secret values and server-config references", async () => {
    const app = await seedApp(projectId);
    await signInAs(editor);
    for (const reference of ["hunter2-the-actual-password", "env://DATABASE_URL"]) {
      const result = await submit(addSecretReference.bind(null, app.id), { name: "TEST_PASSWORD", reference });
      expect(result.fieldErrors?.reference).toBeDefined();
    }
    expect(await db().applicationSecret.count()).toBe(0);
  });

  it("hides references from viewers and blocks them from changing secrets", async () => {
    const app = await seedApp(projectId);
    const secret = await db().applicationSecret.create({
      data: { applicationId: app.id, name: "TOKEN", provider: "ENV", reference: "env://QA_TOKEN" },
    });

    const asViewer = await getApplication(viewer, app.id);
    expect(asViewer?.secrets).toEqual([expect.objectContaining({ name: "TOKEN", reference: null, availability: "missing" })]);
    expect((await getApplication(editor, app.id))?.secrets[0].reference).toBe("env://QA_TOKEN");

    await signInAs(viewer);
    expect((await submit(addSecretReference.bind(null, app.id), { name: "X", reference: "env://QA_X" })).message).toBe(
      "You don't have permission to do that.",
    );
    expect((await submit(removeSecretReference.bind(null, secret.id))).message).toBe("You don't have permission to do that.");

    await signInAs(outsider);
    expect((await submit(removeSecretReference.bind(null, secret.id))).message).toBe("Application not found.");
    expect(await db().applicationSecret.count()).toBe(1);

    await signInAs(editor);
    expect((await submit(removeSecretReference.bind(null, secret.id))).status).toBe("success");
    expect(await db().applicationSecret.count()).toBe(0);
  });

  it("rejects duplicate names per application", async () => {
    const app = await seedApp(projectId);
    await signInAs(editor);
    await submit(addSecretReference.bind(null, app.id), { name: "TOKEN", reference: "env://QA_TOKEN" });
    expect((await submit(addSecretReference.bind(null, app.id), { name: "TOKEN", reference: "env://QA_OTHER" })).message).toContain(
      "conflicts with an existing record",
    );
  });
});
