import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Queue, QueueEvents, UnrecoverableError, Worker } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_CREDENTIALS, startCanary, startDemoApp, type DemoApp } from "../../demo/target-app";
import { db } from "@/lib/db";
import { artifactPath } from "@/modules/artifacts/storage";
import { decideApproval } from "@/modules/approvals/service";
import type { Actor } from "@/modules/auth/service";
import { cancelRun, queueRun } from "@/modules/execution/runs";
import type { ExecutableStep } from "@/modules/execution/steps";
import { closeQueues, QUEUE_NAMES, queueConfig, runJobId, workerConnection } from "@/modules/jobs/queues";
import { loadReportData } from "@/modules/reports/build";
import { submitForApproval } from "@/modules/test-suites/service";
import { InfrastructureError } from "@/worker/execution/executor";
import { claimRun, processRun, runnerConfigFromEnv, type RunnerConfig } from "@/worker/execution/runner";
import { recoverRuns } from "@/worker/jobs/recovery";
import { createProject, createUser, resetDatabase } from "../helpers/fixtures";
import { approve, createSuiteWithCases, type CaseSpec } from "../helpers/plans";

let demo: DemoApp;
let canary: Awaited<ReturnType<typeof startCanary>>;
let storageDir: string;
let engineer: Actor, lead: Actor;
let projectId: string, applicationId: string;

const config = (overrides: Partial<RunnerConfig> = {}) =>
  runnerConfigFromEnv(`test-worker-${Math.random().toString(36).slice(2, 8)}`, { stepTimeoutMs: 3_000, runTimeoutMs: 60_000, heartbeatMs: 500, staleAfterMs: 30_000, ...overrides });

const NAV = (url: string): ExecutableStep => ({ kind: "NAVIGATE", description: `Open ${url}`, params: { url } });
const HEADING = (name: string): ExecutableStep => ({ kind: "ASSERT", description: `See "${name}"`, expected: `Heading ${name}`, params: { check: "visible", target: { by: "role", role: "heading", name } } });
const totalHits = () => [...demo.hits.values()].reduce((a, b) => a + b, 0);

async function approvedRun(cases: CaseSpec[], options: { name?: string } = {}) {
  const suite = await createSuiteWithCases(applicationId, cases, options.name);
  const version = await approve(suite.id, engineer, lead);
  const run = await queueRunWithoutQueue(version.id);
  return { suite, version, run };
}

/** Creates the run exactly like queueRun, but leaves enqueueing to the test. */
async function queueRunWithoutQueue(planVersionId: string) {
  const version = await db().planVersion.findUniqueOrThrow({ where: { id: planVersionId }, select: { contentHash: true, caseCount: true } });
  const app = await db().application.findUniqueOrThrow({ where: { id: applicationId } });
  return db().testRun.create({
    data: { planVersionId, baseUrl: app.authorizedUrl, environment: app.environment, contentHash: version.contentHash, progressTotal: version.caseCount, triggeredById: engineer.id },
  });
}

const loadRun = (id: string) => db().testRun.findUniqueOrThrow({ where: { id }, include: { results: { include: { stepResults: { include: { artifacts: true } }, artifacts: true, defects: true } }, report: true } });

beforeAll(async () => {
  canary = await startCanary();
  demo = await startDemoApp({ canaryPort: canary.port });
  storageDir = await mkdtemp(path.join(tmpdir(), "qa-exec-"));
  process.env.ARTIFACT_STORAGE_DIR = storageDir;
  process.env.DISCOVERY_PRIVATE_ALLOWLIST = `127.0.0.1:${demo.port}`;
  process.env.QA_DEMO_EMAIL = DEMO_CREDENTIALS.email;
  process.env.QA_DEMO_PASSWORD = DEMO_CREDENTIALS.password;
});

afterAll(async () => {
  await closeQueues();
  await demo.close();
  await canary.close();
  await rm(storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase();
  demo.hits.clear();
  demo.setBroken(false);
  canary.requests.length = 0;
  delete process.env.EXECUTION_ALLOWED_ENVIRONMENTS;
  [engineer, lead] = await Promise.all([createUser("QA_ENGINEER"), createUser("QA_LEAD")]);
  ({ id: projectId } = await createProject([[engineer, "EDITOR"], [lead, "EDITOR"]]));
  const app = await db().application.create({
    data: {
      projectId,
      name: "Demo Shop",
      authorizedUrl: demo.url,
      environment: "STAGING",
      secrets: { create: [{ name: "DEMO_EMAIL", provider: "ENV", reference: "env://QA_DEMO_EMAIL" }, { name: "DEMO_PASSWORD", provider: "ENV", reference: "env://QA_DEMO_PASSWORD" }] },
      features: { create: [{ name: "Products" }, { name: "My account" }, { name: "Cart" }] },
    },
  });
  applicationId = app.id;
});

describe("unapproved or unverifiable plans never execute", () => {
  const blocked = async (runId: string, reason: RegExp) => {
    expect(await processRun(runId, config())).toBe("blocked");
    const run = await loadRun(runId);
    expect(run.status).toBe("BLOCKED");
    expect(run.blockedReason).toMatch(reason);
    expect(run.results).toHaveLength(0);
    expect(totalHits()).toBe(0); // no browser ever reached the target
    const audit = await db().auditLog.findFirst({ where: { action: "run.blocked", entityId: runId } });
    expect(audit?.data).toMatchObject({ reason: run.blockedReason });
  };

  it("pending (not yet approved) version", async () => {
    const suite = await createSuiteWithCases(applicationId, [{ title: "Home", steps: [NAV("/")] }]);
    const version = await submitForApproval(engineer, suite.id);
    await expect(queueRun(engineer, version.id)).rejects.toThrow("Only the current approved version");
    await blocked((await queueRunWithoutQueue(version.id)).id, /pending approval, not approved/);
  });

  it("rejected version", async () => {
    const suite = await createSuiteWithCases(applicationId, [{ title: "Home", steps: [NAV("/")] }]);
    const version = await submitForApproval(engineer, suite.id);
    const approval = await db().approval.findFirstOrThrow({ where: { planVersionId: version.id } });
    await decideApproval(lead, approval.id, { decision: "REJECTED", comment: "No", expectedHash: version.contentHash });
    await blocked((await queueRunWithoutQueue(version.id)).id, /rejected, not approved/);
  });

  it("a newer version approved after queueing", async () => {
    const { suite, run } = await approvedRun([{ title: "Home", steps: [NAV("/")] }]);
    await db().testCase.updateMany({ where: { suiteId: suite.id }, data: { priority: "HIGH" } });
    await approve(suite.id, engineer, lead);
    await blocked(run.id, /newer version/);
  });

  it("content that differs from what was queued", async () => {
    const { run } = await approvedRun([{ title: "Home", steps: [NAV("/")] }]);
    await db().testRun.update({ where: { id: run.id }, data: { contentHash: "a".repeat(64) } });
    await blocked(run.id, /changed after the run was queued/);
  });

  it("an approval recorded for different content", async () => {
    const { version, run } = await approvedRun([{ title: "Home", steps: [NAV("/")] }]);
    await db().$executeRawUnsafe(`ALTER TABLE "Approval" DISABLE TRIGGER "Approval_immutable"`);
    try {
      await db().approval.updateMany({ where: { planVersionId: version.id }, data: { decidedHash: "b".repeat(64) } });
    } finally {
      await db().$executeRawUnsafe(`ALTER TABLE "Approval" ENABLE TRIGGER "Approval_immutable"`);
    }
    await blocked(run.id, /approval was given for different plan content/);
  });

  it("an approval by an unauthorized reviewer or by the submitter", async () => {
    const { version, run } = await approvedRun([{ title: "Home", steps: [NAV("/")] }]);
    await db().$executeRawUnsafe(`ALTER TABLE "Approval" DISABLE TRIGGER "Approval_immutable"`);
    try {
      await db().approval.updateMany({ where: { planVersionId: version.id }, data: { reviewerRole: "QA_ENGINEER" } });
      await blocked(run.id, /authorized reviewer/);
      await db().approval.updateMany({ where: { planVersionId: version.id }, data: { reviewerRole: "QA_LEAD", reviewerId: engineer.id } });
    } finally {
      await db().$executeRawUnsafe(`ALTER TABLE "Approval" ENABLE TRIGGER "Approval_immutable"`);
    }
    const second = await queueRunWithoutQueue(version.id);
    await blocked(second.id, /approved by the person who submitted it/);
  });

  it("a target or environment changed after queueing", async () => {
    const { version, run } = await approvedRun([{ title: "Home", steps: [NAV("/")] }]);
    await db().application.update({ where: { id: applicationId }, data: { environment: "DEVELOPMENT" } });
    await blocked(run.id, /environment changed/);
    await db().application.update({ where: { id: applicationId }, data: { environment: "STAGING", authorizedUrl: `${demo.url}/products` } });
    await blocked((await db().testRun.create({ data: { planVersionId: version.id, baseUrl: demo.url, environment: "STAGING", contentHash: version.contentHash } })).id, /authorized URL changed/);
  });

  it("an environment the worker isn't allowed to test", async () => {
    await db().application.update({ where: { id: applicationId }, data: { environment: "PRODUCTION" } });
    const { run } = await approvedRun([{ title: "Home", steps: [NAV("/")] }]);
    await blocked(run.id, /PRODUCTION is not allowed/);
  });

  it("a private target that isn't allowlisted", async () => {
    await db().application.update({ where: { id: applicationId }, data: { authorizedUrl: `http://127.0.0.1:${canary.port}` } });
    const { run } = await approvedRun([{ title: "Home", steps: [NAV("/")] }]);
    await blocked(run.id, /Target blocked/);
    expect(canary.requests).toEqual([]);
  });

  it("a step referencing a secret the application doesn't have", async () => {
    const { run } = await approvedRun([{ title: "Login", steps: [NAV("/login"), { kind: "FILL", description: "pw", params: { target: { by: "css", value: "#pw" }, value: { secret: "ROOT_PASSWORD" } } }] }]);
    await blocked(run.id, /uses secret ROOT_PASSWORD/);
  });

  it("a legacy plan version without executable steps", async () => {
    const { version, run } = await approvedRun([{ title: "Home", steps: [NAV("/")] }]);
    await db().$executeRawUnsafe(`ALTER TABLE "PlanVersion" DISABLE TRIGGER "PlanVersion_immutable"`);
    try {
      await db().planVersion.update({ where: { id: version.id }, data: { snapshotFormat: 1 } });
    } finally {
      await db().$executeRawUnsafe(`ALTER TABLE "PlanVersion" ENABLE TRIGGER "PlanVersion_immutable"`);
    }
    await blocked(run.id, /predates executable steps/);
  });
});

describe("executing an approved plan", () => {
  it("records step results, expected vs actual, screenshots, traces, defects and a report", async () => {
    const login: ExecutableStep[] = [
      NAV("/login"),
      { kind: "FILL", description: "Email", params: { target: { by: "label", value: "Email" }, value: { secret: "DEMO_EMAIL" } } },
      { kind: "FILL", description: "Password", params: { target: { by: "label", value: "Password" }, value: { secret: "DEMO_PASSWORD" } } },
      { kind: "CLICK", description: "Sign in", params: { target: { by: "css", value: 'form[aria-label="Sign in"] button[type="submit"]' } } },
    ];
    const { run } = await approvedRun([
      { title: "Products list", feature: "Products", steps: [NAV("/products"), HEADING("Products"), { kind: "ASSERT", description: "3 products", params: { check: "count", target: { by: "css", value: "main li" }, expected: 3 } }] },
      {
        title: "Sorting option exists",
        feature: "Products",
        priority: "HIGH",
        steps: [NAV("/products"), { kind: "SELECT", description: "Sort by name", params: { target: { by: "label", value: "Sort by" }, option: "Name" } }, { kind: "ASSERT", description: "Selected", params: { check: "valueEquals", target: { by: "label", value: "Sort by" }, expected: "Price" } }],
      },
      { title: "Signed-in account", feature: "My account", steps: [...login, HEADING("My account"), { kind: "ASSERT", description: "On account", params: { check: "urlContains", expected: "/account" } }] },
      { title: "Manual check of the cart", feature: "Cart", steps: ["Open the cart", "Check the totals"] },
    ]);

    const progress: Array<[number, number]> = [];
    expect(await processRun(run.id, config(), { onProgress: (d, t) => void progress.push([d, t]) })).toBe("completed");
    const done = await loadRun(run.id);
    const result = (title: string) => done.results.find((r) => r.caseTitle === title)!;

    expect(done.status).toBe("FAILED");
    expect(done).toMatchObject({ progressDone: 4, progressTotal: 4, attempts: 1 });
    expect(progress).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
    expect(result("Products list")).toMatchObject({ status: "PASSED", featureName: "Products" });
    expect(result("Signed-in account").status).toBe("PASSED");
    expect(result("Manual check of the cart")).toMatchObject({ status: "BLOCKED", errorMessage: "This case has manual steps without executable actions." });

    // Failure: expected vs actual, unconfirmed suspected cause, screenshot, defect with severity.
    const sorting = result("Sorting option exists");
    expect(sorting.status).toBe("FAILED");
    const failedStep = sorting.stepResults.find((s) => s.status === "FAILED")!;
    expect(failedStep).toMatchObject({ expectedResult: 'valueEquals "Price"', actualResult: "Name" });
    expect(sorting.suspectedCause).toContain("differs from the expected result");
    expect(failedStep.artifacts[0]?.kind).toBe("SCREENSHOT");
    expect(sorting.defects[0]).toMatchObject({ severity: "MAJOR", status: "OPEN" });

    // Evidence on disk: step screenshots (PNG) and a Playwright trace per executed case.
    const trace = result("Products list").artifacts.find((a) => a.kind === "TRACE")!;
    expect((await readFile(artifactPath(trace.storageKey))).subarray(0, 2).toString()).toBe("PK");
    const shot = result("Products list").stepResults[0].artifacts[0];
    expect((await readFile(artifactPath(shot.storageKey))).subarray(0, 4).toString("hex")).toBe("89504e47");

    // Secrets were used but never recorded.
    const recorded = JSON.stringify(done);
    expect(recorded).not.toContain(DEMO_CREDENTIALS.password);
    expect(recorded).toContain("Filled with secret value (hidden)");

    // Report
    expect(done.report).toMatchObject({ passed: 2, failed: 1, blocked: 1, skipped: 0 });
    const report = await loadReportData(run.id);
    expect(report!.results.find((r) => r.caseTitle === "Sorting option exists")).toMatchObject({ suggestedSeverity: "MAJOR" });
    expect((done.report!.coverage as { uncovered: string[] }).uncovered).toEqual([]);
    expect(canary.requests).toEqual([]);
    expect(demo.hits.get("/logout") ?? 0).toBe(0);
  });

  it("never reports a partly unexecuted run as passed", async () => {
    const { run } = await approvedRun([
      { title: "Products list", steps: [NAV("/products"), HEADING("Products")] },
      { title: "Manual check", steps: ["Look at the page"] },
    ]);
    await processRun(run.id, config());
    const done = await loadRun(run.id);
    expect(done.results.map((r) => r.status).sort()).toEqual(["BLOCKED", "PASSED"]);
    expect(done.status).toBe("BLOCKED");
  });

  it("flags regressions and fixes against earlier runs, across regression suites", async () => {
    const cases: CaseSpec[] = [{ title: "Products list", feature: "Products", steps: [NAV("/products"), HEADING("Products")] }];
    const { version } = await approvedRun(cases);
    await db().testRun.deleteMany({});
    const first = await queueRunWithoutQueue(version.id);
    await processRun(first.id, config());
    expect((await loadRun(first.id)).results[0]).toMatchObject({ status: "PASSED", comparison: "NEW" });

    demo.setBroken(true);
    const second = await queueRunWithoutQueue(version.id);
    await processRun(second.id, config({ stepTimeoutMs: 1_500 }));
    const broken = await loadRun(second.id);
    expect(broken.results[0]).toMatchObject({ status: "FAILED", comparison: "REGRESSED", previousStatus: "PASSED" });
    expect(broken.comparedToRunId).toBe(first.id);
    expect(broken.report).toMatchObject({ regressions: 1 });

    demo.setBroken(false);
    const third = await queueRunWithoutQueue(version.id);
    await processRun(third.id, config());
    expect((await loadRun(third.id)).results[0]).toMatchObject({ status: "PASSED", comparison: "FIXED", previousStatus: "FAILED" });
  });
});

describe("report downloads", () => {
  it("serves escaped HTML and JSON reports, filtered, to project members only", async () => {
    const { GET } = await import("@/app/api/runs/[runId]/report/route");
    const { signInAs, signOut } = await import("../helpers/fixtures");
    const xss = '<img src=x onerror="alert(1)"> Products';
    const { run } = await approvedRun([
      { title: xss, feature: "Products", steps: [NAV("/products"), HEADING("Products")] },
      { title: "Wrong heading", feature: "Products", priority: "CRITICAL", steps: [NAV("/products"), HEADING("Catalogue")] },
    ]);
    await processRun(run.id, config({ stepTimeoutMs: 1_500 }));
    const get = (query = "") => GET(new Request(`http://app.test/api/runs/${run.id}/report${query}`), { params: Promise.resolve({ runId: run.id }) });

    signOut();
    expect((await get()).status).toBe(401);
    const outsider = await createUser("QA_ENGINEER");
    await signInAs(outsider);
    expect((await get()).status).toBe(404);

    await signInAs(engineer);
    const html = await (await get("?format=html")).text();
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; Products");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("Suspected cause (AI/heuristic, unconfirmed)");
    expect(html).toContain("suggested severity Critical");

    const response = await get("?format=json&status=FAILED");
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="qa-report-.*\.json"/);
    const json = await response.json();
    expect(json.totals).toMatchObject({ passed: 1, failed: 1 });
    expect(json.results).toHaveLength(1); // filtered to failures
    expect(json.results[0]).toMatchObject({ title: "Wrong heading", status: "FAILED", priority: "CRITICAL", suggestedSeverity: "CRITICAL" });
    expect(json.results[0].suspectedCause).toMatchObject({ confirmed: false, label: "Suspected cause (AI/heuristic, unconfirmed)" });
    expect(json.results[0].steps.find((s: { status: string }) => s.status === "FAILED").evidence[0]).toMatch(/^http:\/\/app\.test\/api\/artifacts\/c/);
    expect(json.plan.contentHash).toBe(json.plan.approvedHash);
    expect(await db().auditLog.count({ where: { action: "report.downloaded", entityId: run.id } })).toBe(2);
  });
});

describe("job lifecycle", () => {
  it("lets exactly one worker claim a run and skips duplicates", async () => {
    const { run } = await approvedRun([{ title: "Products", steps: [NAV("/products")] }]);
    const claims = await Promise.all(Array.from({ length: 5 }, (_, i) => claimRun(run.id, `w${i}`, 30_000)));
    expect(claims.filter(Boolean)).toHaveLength(1);

    const { run: other } = await approvedRun([{ title: "Products", steps: [NAV("/products")] }], { name: "Second" });
    const outcomes = await Promise.all([processRun(other.id, config()), processRun(other.id, config())]);
    expect(outcomes.sort()).toEqual(["completed", "duplicate"]);
    expect(demo.hits.get("/products")).toBe(1);
  });

  it("stops a running run when it's cancelled", async () => {
    const wait: ExecutableStep = { kind: "WAIT", description: "Pause", params: { for: "time", ms: 1_500 } };
    const { run } = await approvedRun([
      { title: "First", steps: [NAV("/"), wait, wait] },
      { title: "Second", steps: [NAV("/products")] },
    ]);
    const processing = processRun(run.id, config());
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await cancelRun(engineer, run.id);
    expect(await processing).toBe("cancelled");
    const done = await loadRun(run.id);
    expect(done.status).toBe("CANCELLED");
    expect(done.finishedAt).not.toBeNull();
    expect(done.results.find((r) => r.caseTitle === "Second")?.status).toBe("SKIPPED");
    expect(demo.hits.get("/products") ?? 0).toBe(0);
  });

  it("retries infrastructure failures within the attempt budget, then gives up", async () => {
    const { run } = await approvedRun([{ title: "Products", steps: [NAV("/products")] }]);
    const flaky = config({ beforeLaunch: (attempt) => { if (attempt === 1) throw new InfrastructureError("browser crashed"); } });
    await expect(processRun(run.id, flaky)).rejects.toBeInstanceOf(InfrastructureError);
    expect(await db().testRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "QUEUED", attempts: 1 });
    expect(await processRun(run.id, flaky)).toBe("completed");
    expect(await db().testRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "PASSED", attempts: 2 });

    const { run: doomed } = await approvedRun([{ title: "Products", steps: [NAV("/products")] }], { name: "Doomed" });
    await db().testRun.update({ where: { id: doomed.id }, data: { maxAttempts: 2 } });
    const broken = config({ beforeLaunch: () => { throw new InfrastructureError("browser crashed"); } });
    await expect(processRun(doomed.id, broken)).rejects.toBeInstanceOf(InfrastructureError);
    await expect(processRun(doomed.id, broken)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await db().testRun.findUniqueOrThrow({ where: { id: doomed.id } })).toMatchObject({ status: "ERROR", attempts: 2 });
    expect(await db().auditLog.count({ where: { action: "run.retry", entityId: doomed.id } })).toBe(1);
  });

  it("ends runs that exceed their time limit", async () => {
    const { run } = await approvedRun([{ title: "Slow", steps: [NAV("/"), { kind: "WAIT", description: "Pause", params: { for: "time", ms: 3_000 } }] }, { title: "Next", steps: [NAV("/products")] }]);
    await processRun(run.id, config({ runTimeoutMs: 2_000 }));
    const done = await loadRun(run.id);
    expect(done.status).toBe("ERROR");
    expect(done.errorMessage).toContain("time limit");
  });

  it("recovers runs from crashed workers", async () => {
    const { run } = await approvedRun([{ title: "Products", steps: [NAV("/products")] }]);
    await db().testRun.update({ where: { id: run.id }, data: { status: "RUNNING", attempts: 1, workerId: "dead", heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await recoverRuns({ staleAfterMs: 60_000 })).toMatchObject({ requeued: 1 });
    expect(await db().testRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "QUEUED", workerId: null });
    const queue = new Queue(QUEUE_NAMES.runs, { connection: workerConnection(), prefix: queueConfig().QUEUE_PREFIX });
    expect(await (await queue.getJob(runJobId(run.id)))?.getState()).toBe("waiting");
    await queue.obliterate({ force: true });
    await queue.close();

    await db().testRun.update({ where: { id: run.id }, data: { status: "RUNNING", attempts: 3, heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await recoverRuns({ staleAfterMs: 60_000 })).toMatchObject({ failed: 1 });
    expect((await db().testRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("ERROR");
  });
});

describe("BullMQ queue", () => {
  it("executes queued runs through Redis, deduplicates jobs and retries infrastructure failures", async () => {
    const { prefix } = { prefix: queueConfig().QUEUE_PREFIX };
    let attempt = 0;
    const worker = new Worker(
      QUEUE_NAMES.runs,
      async (job) => processRun(String(job.data.runId), config({ beforeLaunch: () => { if (++attempt === 1) throw new InfrastructureError("flaky"); } }), { onProgress: (d, t) => job.updateProgress({ d, t }) }),
      { connection: workerConnection(), prefix, concurrency: 1 },
    );
    const events = new QueueEvents(QUEUE_NAMES.runs, { connection: workerConnection(), prefix });
    try {
      const suite = await createSuiteWithCases(applicationId, [{ title: "Products", steps: [NAV("/products"), HEADING("Products")] }]);
      const version = await approve(suite.id, engineer, lead);
      const { id } = await queueRun(engineer, version.id);

      // Enqueueing the same run again is a no-op (same job id).
      const queue = new Queue(QUEUE_NAMES.runs, { connection: workerConnection(), prefix });
      await queue.add("execute", { runId: id }, { jobId: runJobId(id) });
      expect(await queue.getJobCountByTypes("waiting", "active", "delayed")).toBe(1);

      const job = (await queue.getJob(runJobId(id)))!;
      await job.waitUntilFinished(events, 60_000);
      await queue.close();

      const run = await db().testRun.findUniqueOrThrow({ where: { id } });
      expect(run).toMatchObject({ status: "PASSED", attempts: 2 });
      expect(attempt).toBe(2);
      expect(demo.hits.get("/products")).toBe(1);
    } finally {
      await worker.close();
      await events.close();
    }
  });

  it("reports an unavailable queue instead of hanging", async () => {
    const suite = await createSuiteWithCases(applicationId, [{ title: "Products", steps: [NAV("/products")] }]);
    const version = await approve(suite.id, engineer, lead);
    await closeQueues();
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:1/15";
    try {
      const started = Date.now();
      await expect(queueRun(engineer, version.id)).rejects.toThrow("job queue is unavailable");
      expect(Date.now() - started).toBeLessThan(5_000);
      const run = await db().testRun.findFirstOrThrow({ where: { planVersionId: version.id } });
      expect(run).toMatchObject({ status: "ERROR" });
      expect(run.errorMessage).toContain("unavailable");
    } finally {
      process.env.REDIS_URL = previous;
      await closeQueues();
    }
  });
});
