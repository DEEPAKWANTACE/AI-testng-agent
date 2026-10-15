import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnrecoverableError } from "bullmq";
import type { ResultStatus, TestRunStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { removeArtifactPrefix, writeArtifact } from "@/modules/artifacts/storage";
import { audit } from "@/modules/audit/audit";
import { verifyRunForExecution } from "@/modules/execution/verify";
import { buildReport, SEVERITY_FOR_PRIORITY } from "@/modules/reports/build";
import { resolveSecret } from "@/modules/secrets/resolver";
import { launchSandbox, TargetBlockedError, type Sandbox } from "@/worker/browser/sandbox";
import { executeCase, InfrastructureError, type CaseOutcome } from "./executor";

export type RunnerConfig = {
  workerId: string;
  stepTimeoutMs: number;
  runTimeoutMs: number;
  staleAfterMs: number;
  heartbeatMs: number;
  allowExternalAssets: boolean;
  /** Test hook: called before the browser starts (used to simulate infrastructure failures). */
  beforeLaunch?: (attempt: number) => void | Promise<void>;
};

export function runnerConfigFromEnv(workerId: string, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
  return {
    workerId,
    stepTimeoutMs: num("EXECUTION_STEP_TIMEOUT_MS", 10_000),
    runTimeoutMs: num("EXECUTION_RUN_TIMEOUT_MS", 15 * 60_000),
    staleAfterMs: num("EXECUTION_STALE_AFTER_MS", 60_000),
    heartbeatMs: num("EXECUTION_HEARTBEAT_MS", 5_000),
    allowExternalAssets: process.env.EXECUTION_ALLOW_EXTERNAL_ASSETS === "true",
    ...overrides,
  };
}

const utcNow = () => new Date();

/**
 * Atomically claims a run for this worker. Succeeds only if the run is QUEUED, or RUNNING
 * with a stale heartbeat (its worker died). Duplicate or redelivered jobs get null.
 */
export async function claimRun(runId: string, workerId: string, staleAfterMs: number) {
  const rows = await db().$queryRaw<{ attempts: number; maxAttempts: number }[]>`
    UPDATE "TestRun"
    SET "status" = 'RUNNING', "workerId" = ${workerId}, "attempts" = "attempts" + 1,
        "startedAt" = COALESCE("startedAt", now() AT TIME ZONE 'UTC'),
        "heartbeatAt" = now() AT TIME ZONE 'UTC', "updatedAt" = now() AT TIME ZONE 'UTC', "errorMessage" = NULL
    WHERE "id" = ${runId}
      AND ("status" = 'QUEUED'
           OR ("status" = 'RUNNING' AND "heartbeatAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => ${staleAfterMs / 1000})))
    RETURNING "attempts", "maxAttempts"`;
  return rows[0] ?? null;
}

const owned = (runId: string, workerId: string) => ({ id: runId, workerId, status: "RUNNING" as const });

/** Any failure fails the run; a run only passes if every case passed; otherwise it's blocked. */
export function overallStatus(statuses: ResultStatus[]): TestRunStatus {
  if (statuses.some((s) => s === "FAILED" || s === "ERROR")) return "FAILED";
  if (statuses.length > 0 && statuses.every((s) => s === "PASSED")) return "PASSED";
  return "BLOCKED";
}

export type ProcessOutcome = "completed" | "blocked" | "cancelled" | "duplicate";

/**
 * Executes one test run end to end. Test failures are results, not errors; only
 * infrastructure failures throw (so BullMQ can retry within the run's attempt budget).
 */
export async function processRun(runId: string, config: RunnerConfig, hooks: { onProgress?: (done: number, total: number) => Promise<void> | void } = {}): Promise<ProcessOutcome> {
  const claim = await claimRun(runId, config.workerId, config.staleAfterMs);
  if (!claim) return "duplicate";

  const heartbeat = setInterval(() => {
    void db().testRun.updateMany({ where: owned(runId, config.workerId), data: { heartbeatAt: utcNow() } }).catch(() => {});
  }, config.heartbeatMs);
  const stillMine = async () => (await db().testRun.count({ where: owned(runId, config.workerId) })) === 1;

  let sandbox: Sandbox | undefined;
  try {
    // 1. Verify approval, hashes, target and environment again — right before execution.
    const verification = await verifyRunForExecution(runId);
    if (!verification.ok) {
      await db().testRun.updateMany({ where: owned(runId, config.workerId), data: { status: "BLOCKED", blockedReason: verification.reason, finishedAt: utcNow() } });
      const run = await db().testRun.findUniqueOrThrow({ where: { id: runId }, select: { planVersion: { select: { suite: { select: { application: { select: { projectId: true } } } } } } } });
      await audit({ actor: null, action: "run.blocked", entityType: "TestRun", entityId: runId, projectId: run.planVersion.suite.application.projectId, data: { reason: verification.reason } });
      await buildReport(runId);
      return "blocked";
    }
    const plan = verification.run;
    await audit({ actor: null, action: "run.started", entityType: "TestRun", entityId: runId, projectId: plan.projectId, data: { attempt: claim.attempts, worker: config.workerId, contentHash: plan.contentHash } });

    // A retry starts clean.
    await db().testResult.deleteMany({ where: { testRunId: runId } });
    await removeArtifactPrefix(`runs/${runId}`);
    await db().testRun.update({ where: { id: runId }, data: { progressDone: 0, progressTotal: plan.snapshot.cases.length } });

    await config.beforeLaunch?.(claim.attempts);
    try {
      sandbox = await launchSandbox({ authorizedUrl: plan.authorizedUrl, allowExternalAssets: config.allowExternalAssets });
    } catch (error) {
      if (error instanceof TargetBlockedError) {
        await db().testRun.updateMany({ where: owned(runId, config.workerId), data: { status: "BLOCKED", blockedReason: error.message, finishedAt: utcNow() } });
        await audit({ actor: null, action: "run.blocked", entityType: "TestRun", entityId: runId, projectId: plan.projectId, data: { reason: error.message } });
        await buildReport(runId);
        return "blocked";
      }
      throw new InfrastructureError(`Browser failed to start: ${String(error).split("\n")[0]}`);
    }

    const deadline = Date.now() + config.runTimeoutMs;
    const shouldContinue = async () => Date.now() < deadline && (await stillMine());
    const resolve = async (name: string) => resolveSecret(plan.secrets.get(name)!);
    let done = 0;

    for (const testCase of plan.snapshot.cases) {
      let outcome: CaseOutcome;
      let trace: Buffer | null = null;
      const startedAt = utcNow();
      if (!(await shouldContinue())) {
        outcome = { status: "SKIPPED", error: Date.now() >= deadline ? "The run reached its time limit." : "The run was cancelled.", suspectedCause: null, steps: [] };
      } else {
        // Each case gets a fresh, isolated browser context and its own trace.
        const context = await sandbox.newContext();
        const traceDir = await mkdtemp(path.join(tmpdir(), "qa-trace-"));
        try {
          await context.tracing.start({ screenshots: true, snapshots: true });
          const page = await sandbox.newPage(context);
          outcome = await executeCase(page, testCase, { authorizedUrl: plan.authorizedUrl, stepTimeoutMs: config.stepTimeoutMs, resolveSecret: resolve, shouldContinue });
          const tracePath = path.join(traceDir, "trace.zip");
          await context.tracing.stop({ path: tracePath }).catch(() => {});
          trace = await readFile(tracePath).catch(() => null);
        } finally {
          await context.close().catch(() => {});
          await rm(traceDir, { recursive: true, force: true });
        }
      }
      await saveCaseResult(runId, testCase, outcome, trace, startedAt, plan.applicationId, ++done);
      await db().testRun.updateMany({ where: { id: runId, workerId: config.workerId }, data: { progressDone: done } });
      await hooks.onProgress?.(done, plan.snapshot.cases.length);
    }

    // 2. Finish: cancelled runs stay CANCELLED; otherwise derive the status from results.
    const results = await db().testResult.findMany({ where: { testRunId: runId }, select: { status: true } });
    const timedOut = Date.now() >= deadline;
    const final = overallStatus(results.map((r) => r.status));
    const { count } = await db().testRun.updateMany({
      where: owned(runId, config.workerId),
      data: timedOut
        ? { status: "ERROR", errorMessage: `The run exceeded its time limit (${Math.round(config.runTimeoutMs / 1000)}s).`, finishedAt: utcNow() }
        : { status: final, finishedAt: utcNow() },
    });
    if (count === 0) {
      await db().testRun.updateMany({ where: { id: runId, status: "CANCELLED", finishedAt: null }, data: { finishedAt: utcNow() } });
    }
    const totals = await buildReport(runId);
    const status = (await db().testRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true } })).status;
    await audit({ actor: null, action: "run.finished", entityType: "TestRun", entityId: runId, projectId: plan.projectId, data: { status, ...totals } });
    return status === "CANCELLED" ? "cancelled" : "completed";
  } catch (error) {
    if (!(error instanceof InfrastructureError) && !(error instanceof Error && /Browser|Target page|Protocol/.test(error.message))) throw error;
    // Infrastructure failure: retry within the attempt budget, then give up.
    const projectId = (await db().testRun.findUnique({ where: { id: runId }, select: { planVersion: { select: { suite: { select: { application: { select: { projectId: true } } } } } } } }))?.planVersion.suite.application.projectId ?? null;
    const message = String((error as Error).message).slice(0, 500);
    if (claim.attempts < claim.maxAttempts) {
      await db().testRun.updateMany({ where: owned(runId, config.workerId), data: { status: "QUEUED", workerId: null, errorMessage: `Attempt ${claim.attempts} failed: ${message}` } });
      await audit({ actor: null, action: "run.retry", entityType: "TestRun", entityId: runId, projectId, data: { attempt: claim.attempts, error: message } });
      throw new InfrastructureError(message);
    }
    await db().testRun.updateMany({
      where: owned(runId, config.workerId),
      data: { status: "ERROR", errorMessage: `Infrastructure failure after ${claim.attempts} attempts: ${message}`, finishedAt: utcNow() },
    });
    await buildReport(runId).catch(() => {});
    await audit({ actor: null, action: "run.finished", entityType: "TestRun", entityId: runId, projectId, data: { status: "ERROR", error: message } });
    throw new UnrecoverableError(message);
  } finally {
    clearInterval(heartbeat);
    await sandbox?.close();
  }
}

async function saveCaseResult(
  runId: string,
  testCase: Parameters<typeof executeCase>[1],
  outcome: CaseOutcome,
  trace: Buffer | null,
  startedAt: Date,
  applicationId: string,
  index: number,
) {
  const liveCase = await db().testCase.findUnique({ where: { id: testCase.caseId }, select: { id: true } });
  const prefix = `runs/${runId}/case-${String(index).padStart(3, "0")}`;
  const result = await db().testResult.create({
    data: {
      testRunId: runId,
      testCaseId: liveCase?.id ?? null,
      caseKey: testCase.caseKey,
      caseTitle: testCase.title,
      casePriority: testCase.priority,
      featureName: testCase.featureName,
      category: testCase.type,
      status: outcome.status,
      errorMessage: outcome.error,
      suspectedCause: outcome.suspectedCause,
      durationMs: outcome.steps.reduce((sum, s) => sum + s.durationMs, 0),
      startedAt,
      finishedAt: new Date(),
    },
    select: { id: true },
  });

  for (const step of outcome.steps) {
    const saved = await db().stepResult.create({
      data: {
        testResultId: result.id,
        position: step.position,
        kind: step.kind,
        action: step.action.slice(0, 1000),
        expectedResult: step.expected,
        actualResult: step.actual,
        status: step.status,
        durationMs: step.durationMs,
        errorMessage: step.error,
      },
      select: { id: true },
    });
    if (step.screenshot) {
      const key = `${prefix}/step-${String(step.position + 1).padStart(2, "0")}.png`;
      const sizeBytes = await writeArtifact(key, step.screenshot, "image/png");
      await db().artifact.create({ data: { kind: "SCREENSHOT", name: `Step ${step.position + 1} screenshot`, storageKey: key, mimeType: "image/png", sizeBytes, stepResultId: saved.id } });
    }
  }
  if (trace) {
    const key = `${prefix}/trace.zip`;
    const sizeBytes = await writeArtifact(key, trace, "application/zip");
    await db().artifact.create({ data: { kind: "TRACE", name: `Playwright trace — ${testCase.title}`.slice(0, 500), storageKey: key, mimeType: "application/zip", sizeBytes, testResultId: result.id } });
  }

  // Failures open a defect (unless one is already open for this case).
  if ((outcome.status === "FAILED" || outcome.status === "ERROR") && liveCase) {
    const open = await db().defect.count({ where: { testCaseId: liveCase.id, status: { in: ["OPEN", "IN_PROGRESS"] } } });
    if (!open) {
      const failed = outcome.steps.find((s) => s.status === "FAILED");
      await db().defect.create({
        data: {
          applicationId,
          testResultId: result.id,
          testCaseId: liveCase.id,
          title: `${testCase.title} fails`.slice(0, 300),
          description: failed ? `Expected: ${failed.expected ?? "—"}\nActual: ${failed.actual ?? failed.error ?? "—"}` : outcome.error,
          stepsToReproduce: outcome.steps.filter((s) => s.status !== "SKIPPED").map((s, i) => `${i + 1}. ${s.action}`).join("\n"),
          severity: SEVERITY_FOR_PRIORITY[testCase.priority],
        },
      });
    }
  }
}
