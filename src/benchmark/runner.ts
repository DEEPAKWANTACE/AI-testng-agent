import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEMO_CREDENTIALS, DEMO_OPENAPI, startCanary, startDemoApp, type DemoApp, type DemoFault } from "../../demo/target-app";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { decideApproval } from "@/modules/approvals/service";
import { hashPassword } from "@/modules/auth/password";
import type { Actor } from "@/modules/auth/service";
import { applicationCoverage } from "@/modules/coverage/service";
import { HeuristicProvider } from "@/modules/generation/providers";
import { processGeneration } from "@/modules/generation/service";
import { addInventoryDocument } from "@/modules/inventory/service";
import { submitForApproval } from "@/modules/test-suites/service";
import { reviewBaseline } from "@/modules/visual-baselines/service";
import { InfrastructureError } from "@/worker/execution/executor";
import { processRun, runnerConfigFromEnv, type RunnerConfig } from "@/worker/execution/runner";
import { claimMutationRun, processClaimedMutationRun } from "@/worker/mutation/worker";
import { CORPUS_VERSION, DEMO_REQUIREMENTS, KNOWN_FLAKY, NOISE_VARIANTS, REFERENCE_CASES, SEEDED_FAULTS } from "./corpus";
import { computeMetrics, type RunVerdicts } from "./metrics";

/**
 * Runs the accuracy benchmark end to end, through the same code paths as real use: inventory
 * from the Demo Shop's spec and requirements, generation, human-style review and approval,
 * verified execution with reproduction, reports, coverage and (optionally) mutation analysis.
 *
 * Everything happens in a scratch project that is deleted afterwards; only the BenchmarkRun
 * row (and the append-only audit entries) remain. Never runs in production.
 */

export type BenchmarkOptions = {
  faults?: DemoFault[];
  /** Clean runs used for the reliability measure (≥ 2 to measure anything). */
  repeats?: number;
  mutation?: boolean;
  mutantLimit?: number;
  noise?: boolean;
  runner?: Partial<RunnerConfig>;
  gitCommit?: string | null;
  log?: (message: string) => void;
};

async function scratchUser(role: "QA_ENGINEER" | "QA_LEAD", tag: string): Promise<Actor> {
  // Random password, never shown: these accounts can't be used to sign in meaningfully.
  return db().user.create({
    data: { email: `benchmark-${role.toLowerCase()}-${tag}@benchmark.invalid`, name: `Benchmark ${role === "QA_LEAD" ? "reviewer" : "author"}`, role, passwordHash: await hashPassword(randomBytes(24).toString("base64url")) },
    select: { id: true, email: true, name: true, role: true },
  });
}

export async function runBenchmark(options: BenchmarkOptions = {}) {
  if (process.env.NODE_ENV === "production") throw new Error("The benchmark doesn't run in production.");
  const log = options.log ?? (() => {});
  const faults = SEEDED_FAULTS.filter((f) => !options.faults || options.faults.includes(f.fault));
  const repeats = Math.max(1, options.repeats ?? 3);
  const started = Date.now();
  const benchmark = await db().benchmarkRun.create({
    data: { corpusVersion: CORPUS_VERSION, gitCommit: options.gitCommit ?? null, config: { faults: faults.map((f) => f.fault), repeats, mutation: Boolean(options.mutation), noise: options.noise !== false } },
    select: { id: true },
  });

  // Isolated environment: local artifact storage in a temp dir, the demo app allowlisted.
  const saved = { storage: process.env.ARTIFACT_STORAGE_DIR, bucket: process.env.ARTIFACT_S3_BUCKET, allow: process.env.DISCOVERY_PRIVATE_ALLOWLIST, email: process.env.QA_BENCH_EMAIL, password: process.env.QA_BENCH_PASSWORD };
  const storage = await mkdtemp(path.join(tmpdir(), "qa-benchmark-"));
  let demo: DemoApp | undefined;
  let canary: Awaited<ReturnType<typeof startCanary>> | undefined;
  let projectId: string | undefined;
  const users: Actor[] = [];
  try {
    canary = await startCanary();
    demo = await startDemoApp({ canaryPort: canary.port });
    process.env.ARTIFACT_STORAGE_DIR = storage;
    delete process.env.ARTIFACT_S3_BUCKET;
    process.env.DISCOVERY_PRIVATE_ALLOWLIST = [saved.allow, `127.0.0.1:${demo.port}`].filter(Boolean).join(",");
    process.env.QA_BENCH_EMAIL = DEMO_CREDENTIALS.email;
    process.env.QA_BENCH_PASSWORD = DEMO_CREDENTIALS.password;

    // 1. Scratch project, application, inventory.
    const tag = randomBytes(4).toString("hex");
    const [author, reviewer] = [await scratchUser("QA_ENGINEER", tag), await scratchUser("QA_LEAD", tag)];
    users.push(author, reviewer);
    const project = await db().project.create({ data: { name: `Benchmark ${tag}`, members: { create: [{ userId: author.id, role: "EDITOR" }, { userId: reviewer.id, role: "EDITOR" }] } } });
    projectId = project.id;
    const app = await db().application.create({
      data: {
        projectId,
        name: "Demo Shop (benchmark)",
        authorizedUrl: demo.url,
        environment: "STAGING",
        secrets: { create: [{ name: "DEMO_EMAIL", provider: "ENV", reference: "env://QA_BENCH_EMAIL" }, { name: "DEMO_PASSWORD", provider: "ENV", reference: "env://QA_BENCH_PASSWORD" }] },
        features: { create: [{ name: "Shop" }] },
      },
      include: { secrets: true, features: true },
    });
    await db().discoveryAuthConfig.create({
      data: { applicationId: app.id, mode: "FORM_LOGIN", loginUrl: `${demo.url}/login`, usernameSecretId: app.secrets.find((s) => s.name === "DEMO_EMAIL")!.id, passwordSecretId: app.secrets.find((s) => s.name === "DEMO_PASSWORD")!.id },
    });
    await addInventoryDocument(author, app.id, { source: "OPENAPI", name: "demo-openapi.json", content: JSON.stringify(DEMO_OPENAPI) });
    await addInventoryDocument(author, app.id, { source: "REQUIREMENTS", name: "demo-requirements.md", content: DEMO_REQUIREMENTS });
    log("inventory ready");

    // 2. Plan: reference cases + generated cases, reviewed and approved.
    const suite = await db().testSuite.create({
      data: {
        applicationId: app.id,
        name: `Benchmark plan ${CORPUS_VERSION}`,
        testCases: {
          create: REFERENCE_CASES.map((c, position) => ({
            title: c.title,
            expectedResult: `${c.title}.`,
            priority: c.priority ?? "MEDIUM",
            position,
            requirementRefs: c.refs ?? [],
            steps: { create: c.steps.map((s, i) => ({ position: i, action: s.description, expectedResult: s.expected ?? null, kind: s.kind, params: s.params as Prisma.InputJsonValue })) },
          })),
        },
      },
      select: { id: true },
    });
    const job = await db().generationJob.create({ data: { applicationId: app.id, featureIds: [app.features[0].id], suiteId: suite.id, requestedById: author.id } });
    await processGeneration(job.id, new HeuristicProvider());
    await db().testCase.updateMany({ where: { suiteId: suite.id, reviewState: "PROPOSED" }, data: { reviewState: "ACCEPTED" } });
    const version = await submitForApproval(author, suite.id);
    const approval = await db().approval.findFirstOrThrow({ where: { planVersionId: version.id } });
    await decideApproval(reviewer, approval.id, { decision: "APPROVED", comment: "Benchmark plan", expectedHash: version.contentHash });
    const caseCount = await db().testCase.count({ where: { suiteId: suite.id } });
    log(`plan approved: ${caseCount} cases`);

    const config = runnerConfigFromEnv(`benchmark-${tag}`, { stepTimeoutMs: 5_000, heartbeatMs: 1_000, reproduceAttempts: 2, ...options.runner });
    const execute = async (label: string): Promise<RunVerdicts & { runId: string }> => {
      const run = await db().testRun.create({ data: { planVersionId: version.id, baseUrl: app.authorizedUrl, environment: app.environment, contentHash: version.contentHash, progressTotal: caseCount, trigger: "CI", triggeredById: author.id }, select: { id: true } });
      for (let attempt = 1; ; attempt++) {
        try {
          await processRun(run.id, config);
          break;
        } catch (error) {
          // Infrastructure retries re-queue the run; process it again within its budget.
          if (!(error instanceof InfrastructureError) || attempt >= 3) break;
        }
      }
      const done = await db().testRun.findUniqueOrThrow({ where: { id: run.id }, select: { status: true, results: { select: { caseTitle: true, status: true, failureClass: true, flaky: true } } } });
      log(`${label}: ${done.status}`);
      return { runId: run.id, runStatus: done.status, cases: Object.fromEntries(done.results.map((r) => [r.caseTitle, { status: r.status, failureClass: r.failureClass, flaky: r.flaky }])) };
    };

    // 3. Calibration: capture visual candidates, approve them as the reviewer would.
    demo.clearFaults();
    await execute("calibration");
    for (const candidate of await db().visualBaseline.findMany({ where: { applicationId: app.id, status: "PENDING" } })) {
      await reviewBaseline(reviewer, candidate.id, { decision: "APPROVED", expectedHash: candidate.sha256, note: "Benchmark calibration" });
    }

    // 4. Repeated clean runs (reliability), then one run per seeded fault and noise variant.
    const cleanRuns: RunVerdicts[] = [];
    for (let i = 1; i <= repeats; i++) cleanRuns.push(await execute(`clean ${i}/${repeats}`));
    const faultRuns: Array<{ fault: string; run: RunVerdicts }> = [];
    for (const spec of faults) {
      demo.clearFaults();
      demo.setFault(spec.fault, true);
      faultRuns.push({ fault: spec.fault, run: await execute(`fault ${spec.fault}`) });
    }
    const noiseRuns: Array<{ fault: string; run: RunVerdicts }> = [];
    if (options.noise !== false) {
      for (const variant of NOISE_VARIANTS) {
        demo.clearFaults();
        demo.setFault(variant.fault, true);
        noiseRuns.push({ fault: variant.fault, run: await execute(`noise ${variant.fault}`) });
      }
    }
    demo.clearFaults();

    // 5. Coverage of the known inventory; optional mutation score.
    const { summary } = await applicationCoverage(app.id);
    let mutationScore: number | null = null;
    if (options.mutation) {
      const mutation = await db().mutationRun.create({ data: { planVersionId: version.id, mutantLimit: options.mutantLimit ?? 20, triggeredById: author.id } });
      if (await claimMutationRun(mutation.id, config.workerId)) await processClaimedMutationRun(mutation.id, config.workerId, { ...options.runner, stepTimeoutMs: config.stepTimeoutMs, reproduceAttempts: 1 });
      mutationScore = (await db().mutationRun.findUniqueOrThrow({ where: { id: mutation.id } })).score;
      log(`mutation score: ${mutationScore}`);
    }
    if (canary.requests.length) throw new Error(`The egress canary was reached ${canary.requests.length} time(s): the sandbox leaked.`);

    const result = computeMetrics({ faults, cleanRuns, faultRuns, noiseRuns, knownFlaky: KNOWN_FLAKY, coverage: summary, mutationScore });
    await db().benchmarkRun.update({
      where: { id: benchmark.id },
      data: { status: "SUCCEEDED", metrics: result.metrics as Prisma.InputJsonValue, details: { ...result.details, planCases: caseCount } as unknown as Prisma.InputJsonValue, durationMs: Date.now() - started, finishedAt: new Date() },
    });
    return { id: benchmark.id, ...result };
  } catch (error) {
    await db().benchmarkRun.update({ where: { id: benchmark.id }, data: { status: "FAILED", errorMessage: String((error as Error).message ?? error).slice(0, 1000), durationMs: Date.now() - started, finishedAt: new Date() } });
    throw error;
  } finally {
    if (projectId) await db().project.delete({ where: { id: projectId } }).catch(() => {});
    for (const user of users) await db().user.delete({ where: { id: user.id } }).catch(() => db().user.update({ where: { id: user.id }, data: { status: "DISABLED" } }).catch(() => {}));
    await demo?.close();
    await canary?.close();
    await rm(storage, { recursive: true, force: true });
    const restore = (key: string, value: string | undefined) => (value === undefined ? delete process.env[key] : (process.env[key] = value));
    restore("ARTIFACT_STORAGE_DIR", saved.storage);
    restore("ARTIFACT_S3_BUCKET", saved.bucket);
    restore("DISCOVERY_PRIVATE_ALLOWLIST", saved.allow);
    restore("QA_BENCH_EMAIL", saved.email);
    restore("QA_BENCH_PASSWORD", saved.password);
  }
}
