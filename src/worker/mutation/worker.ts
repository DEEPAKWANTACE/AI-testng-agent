import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/modules/audit/audit";
import { verifyRunForExecution } from "@/modules/execution/verify";
import { applyMutant, enumerateMutants, type Mutant, type ObservedSample } from "@/modules/mutation/operators";
import { resolveSecret } from "@/modules/secrets/resolver";
import { launchSandbox, type InterceptedResponse, type ReplacementResponse, type Sandbox } from "@/worker/browser/sandbox";
import { executeCase, type NetworkHit } from "@/worker/execution/executor";
import { processRun, runnerConfigFromEnv, type RunnerConfig } from "@/worker/execution/runner";

/**
 * Mutation analysis of an approved plan, polled from the database:
 *
 * 1. Baseline: an ordinary, fully verified and persisted run of the plan, observing the
 *    application's same-origin responses. It must pass, otherwise there's nothing to measure.
 * 2. Mutants: one deliberate change per mutant, applied to matching responses only, while the
 *    cases that reached that response in the baseline run again. Mutant executions are not
 *    persisted as test runs: they never open defects or enter regression history.
 * 3. A mutant is KILLED if some case FAILS with it in place, SURVIVED if every case still
 *    passes, UNCLEAR otherwise (only inconclusive outcomes, or the change never applied).
 */

export type MutantOutcome = "KILLED" | "SURVIVED" | "UNCLEAR" | "NOT_RUN";
export type MutantResult = Mutant & { outcome: MutantOutcome; killedBy: string | null; note: string | null };

const STALE_AFTER_MS = 60 * 60_000;

export async function claimNextMutationRun(workerId: string): Promise<string | null> {
  const rows = await db().$queryRaw<{ id: string }[]>`
    UPDATE "MutationRun" SET "status" = 'RUNNING', "workerId" = ${workerId}, "startedAt" = now() AT TIME ZONE 'UTC'
    WHERE "id" = (SELECT "id" FROM "MutationRun" WHERE "status" = 'QUEUED' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING "id"`;
  return rows[0]?.id ?? null;
}

/** Claims one specific queued analysis (the benchmark processes its own analyses this way). */
export async function claimMutationRun(id: string, workerId: string): Promise<boolean> {
  const { count } = await db().mutationRun.updateMany({ where: { id, status: "QUEUED" }, data: { status: "RUNNING", workerId, startedAt: new Date() } });
  return count === 1;
}

export async function recoverStaleMutationRuns(): Promise<number> {
  const { count } = await db().mutationRun.updateMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
    data: { status: "FAILED", errorMessage: "The worker stopped before the analysis finished.", finishedAt: new Date() },
  });
  return count;
}

const header = (headers: InterceptedResponse["headers"], name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
const sampleKey = (s: { type: string; method: string; path: string }) => `${s.type} ${s.method} ${s.path}`;

/** Response hook that applies one mutant; `applied` reports whether it ever matched. */
function mutatorFor(mutant: Mutant) {
  const state = { applied: false };
  const mutate = (response: InterceptedResponse): ReplacementResponse | null => {
    const changed = applyMutant(mutant, {
      type: response.type,
      method: response.method,
      path: new URL(response.url).pathname,
      status: response.status,
      contentType: header(response.headers, "content-type"),
      body: response.body.toString("utf8"),
    });
    if (!changed) return null;
    state.applied = true;
    // The body we hand back is decoded; drop length/encoding headers and set the type.
    const headers = response.headers.filter((h) => !["content-length", "content-encoding", "transfer-encoding", "content-type"].includes(h.name.toLowerCase()));
    return { status: changed.status, headers: [...headers, { name: "content-type", value: changed.contentType }], body: Buffer.from(changed.body) };
  };
  return { mutate, state };
}

export async function processNextMutationRun(workerId: string, overrides: Partial<RunnerConfig> = {}): Promise<string | null> {
  const id = await claimNextMutationRun(workerId);
  if (!id) return null;
  await processClaimedMutationRun(id, workerId, overrides);
  return id;
}

/** Processes an analysis this worker has already claimed. */
export async function processClaimedMutationRun(id: string, workerId: string, overrides: Partial<RunnerConfig> = {}): Promise<void> {
  const mutationRun = await db().mutationRun.findUniqueOrThrow({
    where: { id },
    select: {
      mutantLimit: true,
      triggeredById: true,
      planVersion: { select: { id: true, contentHash: true, caseCount: true, suite: { select: { application: { select: { projectId: true, authorizedUrl: true, environment: true } } } } } },
    },
  });
  const { planVersion } = mutationRun;
  const app = planVersion.suite.application;
  const finish = async (data: Prisma.MutationRunUpdateInput, summary: Record<string, unknown>) => {
    await db().mutationRun.update({ where: { id }, data: { ...data, finishedAt: new Date() } });
    await audit({ actor: null, action: "mutation.finished", entityType: "MutationRun", entityId: id, projectId: app.projectId, data: summary });
  };

  let sandbox: Sandbox | undefined;
  try {
    // 1. Baseline run (verified, persisted), observing responses.
    const baseline = await db().testRun.create({
      data: { planVersionId: planVersion.id, baseUrl: app.authorizedUrl, environment: app.environment, contentHash: planVersion.contentHash, progressTotal: planVersion.caseCount, trigger: "MUTATION", triggeredById: mutationRun.triggeredById },
      select: { id: true },
    });
    await db().mutationRun.update({ where: { id }, data: { baselineRunId: baseline.id } });
    const samples = new Map<string, ObservedSample>();
    const config = runnerConfigFromEnv(workerId, {
      ...overrides,
      responseHooks: {
        observe: (r) => {
          const sample = { type: r.type, method: r.method, path: new URL(r.url).pathname, status: r.status, contentType: header(r.headers, "content-type"), body: r.body.toString("utf8") };
          if (!samples.has(sampleKey(sample)) && sample.status >= 200 && sample.status < 300) samples.set(sampleKey(sample), sample);
        },
      },
    });
    await processRun(baseline.id, config);
    const baselineRun = await db().testRun.findUniqueOrThrow({ where: { id: baseline.id }, select: { status: true, blockedReason: true, results: { select: { caseKey: true, network: true } } } });
    if (baselineRun.status !== "PASSED") {
      const reason = `The plan must pass on the unmodified application before mutation testing; the baseline run was ${baselineRun.status.toLowerCase()}${baselineRun.blockedReason ? ` (${baselineRun.blockedReason})` : ""}.`;
      await finish({ status: "BLOCKED", blockedReason: reason }, { status: "BLOCKED", reason });
      return;
    }

    // 2. Mutants, re-verifying the plan right before they execute.
    const mutants = enumerateMutants([...samples.values()], mutationRun.mutantLimit);
    const verification = await verifyRunForExecution(baseline.id);
    if (!verification.ok) {
      await finish({ status: "BLOCKED", blockedReason: verification.reason }, { status: "BLOCKED", reason: verification.reason });
      return;
    }
    const plan = verification.run;
    const hitsByCase = new Map(baselineRun.results.map((r) => [r.caseKey!, (r.network as NetworkHit[] | null) ?? []]));
    sandbox = await launchSandbox({ authorizedUrl: plan.authorizedUrl, allowExternalAssets: config.allowExternalAssets });
    const deadline = Date.now() + config.runTimeoutMs;
    const results: MutantResult[] = [];

    for (const mutant of mutants) {
      if (Date.now() >= deadline) {
        results.push({ ...mutant, outcome: "NOT_RUN", killedBy: null, note: "The analysis reached its time limit." });
        continue;
      }
      const hitType = mutant.target.type === "document" ? "page" : "api";
      const cases = plan.snapshot.cases.filter((c) => (hitsByCase.get(c.caseKey) ?? []).some((h) => h.type === hitType && h.method === mutant.target.method && h.path === mutant.target.path));
      const { mutate, state } = mutatorFor(mutant);
      let killedBy: string | null = null;
      let inconclusive = false;
      for (const testCase of cases) {
        const context = await sandbox.newContext();
        try {
          const page = await sandbox.newPage(context, { mutate });
          const outcome = await executeCase(page, testCase, {
            authorizedUrl: plan.authorizedUrl,
            stepTimeoutMs: config.stepTimeoutMs,
            resolveSecret: async (name) => resolveSecret(plan.secrets.get(name)!),
            shouldContinue: async () => Date.now() < deadline,
          });
          if (outcome.status === "FAILED") killedBy = testCase.title;
          else if (outcome.status !== "PASSED") inconclusive = true;
        } finally {
          await context.close().catch(() => {});
        }
        if (killedBy) break;
      }
      const outcome: MutantOutcome = killedBy ? "KILLED" : !state.applied ? "UNCLEAR" : inconclusive ? "UNCLEAR" : "SURVIVED";
      const note = killedBy ? null : !state.applied ? "The change never applied during the run." : inconclusive ? "Some cases were inconclusive with the change in place." : `${cases.length} case${cases.length === 1 ? "" : "s"} reached this response and still passed.`;
      results.push({ ...mutant, outcome, killedBy, note });
    }

    const count = (o: MutantOutcome) => results.filter((r) => r.outcome === o).length;
    const [killed, survived, unclear] = [count("KILLED"), count("SURVIVED"), count("UNCLEAR")];
    const evaluated = killed + survived + unclear;
    const score = evaluated ? Math.round((killed / evaluated) * 1000) / 1000 : null;
    await finish(
      { status: "SUCCEEDED", killed, survived, unclear, score, mutants: results as unknown as Prisma.InputJsonValue },
      { status: "SUCCEEDED", mutants: results.length, killed, survived, unclear, score },
    );
  } catch (error) {
    const message = String((error as Error).message ?? error).split("\n")[0].slice(0, 500);
    console.error(`[mutation] ${id} failed`, error);
    await finish({ status: "FAILED", errorMessage: `Mutation analysis failed: ${message}` }, { status: "FAILED", error: message });
  } finally {
    await sandbox?.close();
  }
}
