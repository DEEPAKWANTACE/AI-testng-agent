import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_CREDENTIALS, DEMO_OPENAPI, startCanary, startDemoApp, type DemoApp } from "../../demo/target-app";
import { db } from "@/lib/db";
import type { Actor } from "@/modules/auth/service";
import { applicationCoverage } from "@/modules/coverage/service";
import { HeuristicProvider } from "@/modules/generation/providers";
import { processGeneration } from "@/modules/generation/service";
import { addInventoryDocument } from "@/modules/inventory/service";
import { processRun, runnerConfigFromEnv } from "@/worker/execution/runner";
import { createProject, createUser, resetDatabase } from "../helpers/fixtures";
import { approve } from "../helpers/plans";

let demo: DemoApp;
let canary: Awaited<ReturnType<typeof startCanary>>;
let storageDir: string;
let engineer: Actor, lead: Actor;
let applicationId: string;

beforeAll(async () => {
  canary = await startCanary();
  demo = await startDemoApp({ canaryPort: canary.port });
  storageDir = await mkdtemp(path.join(tmpdir(), "qa-gen-inv-"));
  process.env.ARTIFACT_STORAGE_DIR = storageDir;
  process.env.DISCOVERY_PRIVATE_ALLOWLIST = `127.0.0.1:${demo.port}`;
  process.env.QA_DEMO_EMAIL = DEMO_CREDENTIALS.email;
  process.env.QA_DEMO_PASSWORD = DEMO_CREDENTIALS.password;
});

afterAll(async () => {
  await demo.close();
  await canary.close();
  await rm(storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase();
  demo.clearFaults();
  [engineer, lead] = await Promise.all([createUser("QA_ENGINEER"), createUser("QA_LEAD")]);
  const project = await createProject([[engineer, "EDITOR"], [lead, "EDITOR"]]);
  const app = await db().application.create({
    data: {
      projectId: project.id,
      name: "Demo Shop",
      authorizedUrl: demo.url,
      environment: "STAGING",
      secrets: { create: [{ name: "DEMO_EMAIL", provider: "ENV", reference: "env://QA_DEMO_EMAIL" }, { name: "DEMO_PASSWORD", provider: "ENV", reference: "env://QA_DEMO_PASSWORD" }] },
      features: { create: [{ name: "Home" }] },
    },
    include: { secrets: true, features: true },
  });
  applicationId = app.id;
  await db().discoveryAuthConfig.create({
    data: { applicationId, mode: "FORM_LOGIN", loginUrl: `${demo.url}/login`, usernameSecretId: app.secrets.find((s) => s.name === "DEMO_EMAIL")!.id, passwordSecretId: app.secrets.find((s) => s.name === "DEMO_PASSWORD")!.id },
  });
});

describe("generation from the inventory, executed against the real application", () => {
  it("generates contract, permission and boundary cases from the spec that all pass on the correct app", async () => {
    await addInventoryDocument(engineer, applicationId, { source: "OPENAPI", name: "demo-openapi.json", content: JSON.stringify(DEMO_OPENAPI) });
    const feature = await db().feature.findFirstOrThrow({ where: { applicationId } });
    const job = await db().generationJob.create({ data: { applicationId, featureIds: [feature.id], requestedById: engineer.id } });
    await processGeneration(job.id, new HeuristicProvider());

    const generated = await db().generationJob.findUniqueOrThrow({ where: { id: job.id }, include: { suite: { include: { testCases: { orderBy: { position: "asc" } } } } } });
    expect(generated.status).toBe("SUCCEEDED");
    const cases = generated.suite!.testCases;
    expect(cases.map((c) => c.title)).toEqual([
      "GET /api/cart returns 200 matching its documented schema",
      "GET /api/products returns 200 matching its documented schema",
      "GET /api/products: limit=50 (maximum) is accepted",
      "GET /api/products: limit above its maximum is refused",
      "GET /api/products: limit=1 (minimum) is accepted",
      "GET /api/products: limit below its minimum is refused",
      "GET /api/profile returns 200 matching its documented schema",
      "GET /api/profile refuses signed-out requests",
    ]);
    expect(cases.every((c) => c.reviewState === "PROPOSED" && c.featureId === null && c.requirementRefs.length > 0)).toBe(true);

    // A reviewer accepts them; the plan is approved and executed.
    await db().testCase.updateMany({ where: { suiteId: generated.suite!.id }, data: { reviewState: "ACCEPTED" } });
    const version = await approve(generated.suite!.id, engineer, lead);
    const app = await db().application.findUniqueOrThrow({ where: { id: applicationId } });
    const run = await db().testRun.create({ data: { planVersionId: version.id, baseUrl: app.authorizedUrl, environment: app.environment, contentHash: version.contentHash, progressTotal: cases.length } });
    await processRun(run.id, runnerConfigFromEnv("gen-inv-worker", { stepTimeoutMs: 3_000, heartbeatMs: 500 }));

    const done = await db().testRun.findUniqueOrThrow({ where: { id: run.id }, include: { results: true } });
    const failing = done.results.filter((r) => r.status !== "PASSED").map((r) => `${r.caseTitle}: ${r.errorMessage}`);
    expect(failing).toEqual([]);
    expect(done.status).toBe("PASSED");
    expect(done.results.every((r) => r.attemptCount === 1)).toBe(true);
    expect(await db().defect.count()).toBe(0);
    expect(canary.requests).toEqual([]);
    // Only GET requests reached the API.
    expect(demo.hits.get("/api/products")).toBeGreaterThan(0);

    // Coverage of the known inventory: the three GET endpoints are verified, the POST isn't planned.
    const { coverage, items, summary } = await applicationCoverage(applicationId);
    const level = (key: string) => coverage.find((c) => c.itemId === items.find((i) => i.key === key)!.id)!.level;
    expect(level("GET /api/cart")).toBe("VERIFIED");
    expect(level("GET /api/products")).toBe("VERIFIED");
    expect(level("GET /api/profile")).toBe("VERIFIED");
    expect(level("POST /cart")).toBe("NOT_PLANNED");
    expect(summary).toMatchObject({ known: 4, byLevel: { VERIFIED: 3, NOT_PLANNED: 1 } });
    // The same numbers are stored on the run's report, with the disclaimer.
    const report = await db().report.findUniqueOrThrow({ where: { testRunId: run.id } });
    expect((report.coverage as { inventory: unknown }).inventory).toMatchObject({ known: 4, byLevel: { VERIFIED: 3 }, notVerified: ["POST /cart"], disclaimer: expect.stringContaining("never a measure of complete coverage") });
    // What each case reached is recorded (paths only).
    const cart = done.results.find((r) => r.caseTitle.startsWith("GET /api/cart"))!;
    expect(cart.network).toEqual(expect.arrayContaining([{ type: "api", method: "GET", path: "/api/cart", status: 200 }]));
  });
});
