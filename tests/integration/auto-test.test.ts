import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_CREDENTIALS, startCanary, startDemoApp, type DemoApp } from "../../demo/target-app";
import { db } from "@/lib/db";
import type { Actor } from "@/modules/auth/service";
import { autoTestInputSchema } from "@/modules/auto-test/schemas";
import { addSecretReference } from "@/modules/applications/actions";
import { startAutoTest } from "@/modules/auto-test/service";
import { processGeneration } from "@/modules/generation/service";
import { resolveSecret } from "@/modules/secrets/resolver";
import { processNextRun, workerConfigFromEnv } from "@/worker/discovery/worker";
import { createProject, createUser, resetDatabase, signInAs, submit } from "../helpers/fixtures";

let demo: DemoApp;
let canary: Awaited<ReturnType<typeof startCanary>>;
let storageDir: string;
let editor: Actor, viewer: Actor;
let projectId: string;

const parse = (extra: Record<string, string>) =>
  autoTestInputSchema.parse({ projectId, url: demo.url, environment: "STAGING", authorized: "on", ...extra });

const workerConfig = () => workerConfigFromEnv({ pageTimeoutMs: 2_500, runTimeoutMs: 60_000, allowExternalAssets: false });

beforeAll(async () => {
  canary = await startCanary();
  demo = await startDemoApp({ canaryPort: canary.port });
  storageDir = await mkdtemp(path.join(tmpdir(), "qa-artifacts-"));
  process.env.ARTIFACT_STORAGE_DIR = storageDir;
  process.env.DISCOVERY_PRIVATE_ALLOWLIST = `127.0.0.1:${demo.port}`;
});

afterAll(async () => {
  await demo.close();
  await canary.close();
  await rm(storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase();
  [editor, viewer] = await Promise.all([createUser("QA_ENGINEER"), createUser("VIEWER")]);
  ({ id: projectId } = await createProject([[editor, "EDITOR"], [viewer, "VIEWER"]]));
  // The demo app is on localhost, which application registration refuses; register it directly
  // so startAutoTest takes its "reuse the existing application" path.
  await db().application.create({ data: { projectId, name: "Demo", authorizedUrl: demo.url, environment: "STAGING", type: "WEB" } });
});

describe("input validation", () => {
  it("requires the authorization confirmation and both-or-neither credentials", () => {
    expect(autoTestInputSchema.safeParse({ projectId, url: demo.url, environment: "STAGING" }).success).toBe(false);
    expect(autoTestInputSchema.safeParse({ projectId, url: demo.url, environment: "STAGING", authorized: "on", username: "a@b.c" }).success).toBe(false);
    expect(autoTestInputSchema.safeParse({ projectId, url: demo.url, environment: "STAGING", authorized: "on" }).success).toBe(true);
  });
});

describe("startAutoTest", () => {
  it("stores credentials encrypted, configures login and queues an auto-generating crawl", async () => {
    const { applicationId, runId } = await startAutoTest(
      editor,
      parse({ username: DEMO_CREDENTIALS.email, password: DEMO_CREDENTIALS.password, loginUrl: `${demo.url}/login` }),
    );

    const secrets = await db().applicationSecret.findMany({ where: { applicationId } });
    expect(secrets.map((s) => s.name).sort()).toEqual(["AUTO_TEST_PASSWORD", "AUTO_TEST_USERNAME"]);
    for (const s of secrets) {
      expect(s.provider).toBe("LOCAL");
      expect(JSON.stringify(s)).not.toContain(DEMO_CREDENTIALS.password);
    }
    const password = secrets.find((s) => s.name === "AUTO_TEST_PASSWORD")!;
    expect(await resolveSecret(password.reference)).toBe(DEMO_CREDENTIALS.password);

    const auth = await db().discoveryAuthConfig.findUniqueOrThrow({ where: { applicationId } });
    expect(auth.mode).toBe("FORM_LOGIN");
    const run = await db().discoveryRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ autoGenerate: true, status: "QUEUED", triggeredById: editor.id });

    // The audit trail records that credentials were used, never their values.
    const audit = await db().auditLog.findMany({ where: { action: "autotest.started" } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit, (_, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(DEMO_CREDENTIALS.password);
  });

  it("re-running replaces the stored credentials instead of duplicating them", async () => {
    await startAutoTest(editor, parse({ username: "old@x.test", password: "old-password" }));
    const { applicationId } = await startAutoTest(editor, parse({ username: "new@x.test", password: "new-password" }));
    const secrets = await db().applicationSecret.findMany({ where: { applicationId } });
    expect(secrets).toHaveLength(2);
    expect(await resolveSecret(secrets.find((s) => s.name === "AUTO_TEST_USERNAME")!.reference)).toBe("new@x.test");
  });

  it("works without credentials (signed-out pages only)", async () => {
    const { applicationId } = await startAutoTest(editor, parse({}));
    expect(await db().applicationSecret.count({ where: { applicationId } })).toBe(0);
    expect(await db().discoveryAuthConfig.count({ where: { applicationId } })).toBe(0);
  });

  it("refuses viewers and private targets for new applications", async () => {
    await expect(startAutoTest(viewer, parse({}))).rejects.toThrow();
    await expect(startAutoTest(editor, parse({ url: "http://169.254.169.254" }))).rejects.toThrow(/isn't allowed to test/);
  });

  it("refuses to store credentials when no encryption key is configured", async () => {
    const key = process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.SECRETS_ENCRYPTION_KEY;
    try {
      await expect(startAutoTest(editor, parse({ username: "a@b.c", password: "pw" }))).rejects.toThrow(/SECRETS_ENCRYPTION_KEY/);
    } finally {
      process.env.SECRETS_ENCRYPTION_KEY = key;
    }
  });
});

describe("end to end: crawl → automatic generation → human review", () => {
  it("drafts cases for every discovered feature and approves nothing", async () => {
    const { applicationId, runId } = await startAutoTest(
      editor,
      parse({ username: DEMO_CREDENTIALS.email, password: DEMO_CREDENTIALS.password, loginUrl: `${demo.url}/login` }),
    );
    await processNextRun(workerConfig());

    const run = await db().discoveryRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("COMPLETED");
    expect(run.summary).toMatch(/signed in/);
    expect(run.summary).toMatch(/Auto-generation queued: \d+ job/);

    const jobs = await db().generationJob.findMany({ where: { applicationId } });
    expect(jobs.length).toBeGreaterThan(0);
    const featureCount = await db().feature.count({ where: { applicationId } });
    expect(jobs.flatMap((j) => j.featureIds)).toHaveLength(featureCount);

    for (const job of jobs) await processGeneration(job.id);
    const done = await db().generationJob.findMany({ where: { applicationId } });
    expect(done.every((j) => j.status === "SUCCEEDED")).toBe(true);

    const cases = await db().testCase.findMany({ where: { suite: { applicationId } }, include: { steps: true } });
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.reviewState === "PROPOSED" && c.source === "AI_GENERATED")).toBe(true);
    expect(await db().planVersion.count({ where: { suite: { applicationId } } })).toBe(0);
    // Steps reference credentials by name only.
    expect(JSON.stringify(cases)).not.toContain(DEMO_CREDENTIALS.password);
  });

  it("doesn't queue generation for a failed crawl", async () => {
    const { applicationId, runId } = await startAutoTest(
      editor,
      parse({ username: DEMO_CREDENTIALS.email, password: "wrong-password", loginUrl: `${demo.url}/login` }),
    );
    await processNextRun(workerConfig());
    expect((await db().discoveryRun.findUniqueOrThrow({ where: { id: runId } })).status).not.toBe("COMPLETED");
    expect(await db().generationJob.count({ where: { applicationId } })).toBe(0);
  });
});

describe("Secret references form with a typed value", () => {
  it("stores the value encrypted under a normalised name, and replaces it on re-save", async () => {
    const app = await db().application.findFirstOrThrow({ where: { projectId } });
    await signInAs(editor);

    const saved = await submit(addSecretReference.bind(null, app.id), { name: "User name- crm admin", value: "Superadmin@ayucrm123", reference: "" });
    expect(saved.status).toBe("success");
    const row = await db().applicationSecret.findFirstOrThrow({ where: { applicationId: app.id, name: "USER_NAME_CRM_ADMIN" } });
    expect(row.provider).toBe("LOCAL");
    expect(JSON.stringify(row)).not.toContain("Superadmin");
    expect(await resolveSecret(row.reference)).toBe("Superadmin@ayucrm123");

    await submit(addSecretReference.bind(null, app.id), { name: "user name- crm admin", value: "changed", reference: "" });
    expect(await db().applicationSecret.count({ where: { applicationId: app.id } })).toBe(1);
    expect(await resolveSecret(row.reference)).toBe("changed");
  });

  it("still validates references when no value is typed, and never echoes a value", async () => {
    const app = await db().application.findFirstOrThrow({ where: { projectId } });
    await signInAs(editor);
    const bad = await submit(addSecretReference.bind(null, app.id), { name: "CRM_USER", value: "", reference: "" });
    expect(bad.status).toBe("error");
    expect(bad.fieldErrors?.reference?.[0]).toMatch(/Type a value/);
    const emptyName = await submit(addSecretReference.bind(null, app.id), { name: "", value: "secret-pass", reference: "" });
    expect(emptyName.status).toBe("error");
    expect(emptyName.values?.value).toBe("");
  });

  it("viewers can't store credentials", async () => {
    const app = await db().application.findFirstOrThrow({ where: { projectId } });
    await signInAs(viewer);
    expect((await submit(addSecretReference.bind(null, app.id), { name: "X", value: "y", reference: "" })).status).toBe("error");
  });
});
