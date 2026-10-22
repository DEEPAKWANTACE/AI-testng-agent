import type { AppEnvironment } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { can } from "@/modules/access/policy";
import { defaultPort, resolveTarget, staticUrlBlockReason, BLOCK_REASON_LABELS } from "@/modules/discovery/network-policy";
import { parsePlanSnapshot, type PlanSnapshot } from "@/modules/test-suites/snapshot";
import { referencedSecrets, resolveNavigation, stepParamsSchemas, stepSequenceIssues, type StepKindName } from "./steps";

/**
 * Pre-execution verification, run by the worker immediately before a browser is launched.
 * Every check is repeated here even if it was done when the run was queued: approvals,
 * content hashes, targets and environments can all change in between.
 */

export type VerifiedRun = {
  runId: string;
  applicationId: string;
  projectId: string;
  authorizedUrl: string;
  environment: AppEnvironment;
  contentHash: string;
  snapshot: PlanSnapshot;
  secrets: Map<string, string>; // secret name -> reference (values are resolved later)
};

export type Verification = { ok: true; run: VerifiedRun } | { ok: false; reason: string };

export function allowedEnvironments(): Set<string> {
  return new Set(
    (process.env.EXECUTION_ALLOWED_ENVIRONMENTS ?? "DEVELOPMENT,STAGING")
      .split(",")
      .map((e) => e.trim().toUpperCase())
      .filter(Boolean),
  );
}

export async function verifyRunForExecution(runId: string, options: { resolveDns?: boolean } = {}): Promise<Verification> {
  const fail = (reason: string): Verification => ({ ok: false, reason });
  const run = await db().testRun.findUnique({
    where: { id: runId },
    select: {
      baseUrl: true,
      environment: true,
      contentHash: true,
      planVersion: {
        select: {
          id: true,
          status: true,
          snapshot: true,
          snapshotFormat: true,
          contentHash: true,
          approvals: {
            where: { status: "APPROVED" },
            select: { decidedHash: true, reviewerId: true, requestedById: true, reviewerRole: true, reviewerProjectRole: true },
          },
          suite: {
            select: {
              status: true,
              application: {
                select: { id: true, projectId: true, authorizedUrl: true, environment: true, secrets: { select: { name: true, reference: true } } },
              },
            },
          },
        },
      },
    },
  });
  if (!run) return fail("The run no longer exists.");
  const { planVersion: version } = run;
  const app = version.suite.application;

  // 1. Approval of this exact, immutable version.
  if (version.status !== "APPROVED") {
    return fail(version.status === "SUPERSEDED" ? "A newer version of this plan was approved after the run was queued." : `The plan version is ${version.status.toLowerCase().replace("_", " ")}, not approved.`);
  }
  if (version.suite.status !== "ACTIVE") return fail("The test suite has been archived.");
  const approval = version.approvals[0];
  if (!approval) return fail("No approval found for this plan version.");
  if (approval.reviewerId && approval.reviewerId === approval.requestedById) return fail("The plan was approved by the person who submitted it.");
  if (!approval.reviewerRole || !can(approval.reviewerRole, approval.reviewerProjectRole, "plan.review")) {
    return fail("The approval wasn't made by an authorized reviewer.");
  }

  // 2. Content integrity: stored content, version hash, approved hash and queued hash agree.
  const [{ recomputed }] = await db().$queryRaw<{ recomputed: string }[]>`
    SELECT qa_snapshot_hash("snapshot") AS recomputed FROM "PlanVersion" WHERE "id" = ${version.id}`;
  if (recomputed !== version.contentHash) return fail("The plan content doesn't match its hash.");
  if (approval.decidedHash !== version.contentHash) return fail("The approval was given for different plan content.");
  if (run.contentHash !== version.contentHash) return fail("The plan content changed after the run was queued.");
  if (version.snapshotFormat !== 2) return fail("This plan version predates executable steps. Submit a new version to run it.");

  let snapshot: PlanSnapshot;
  try {
    const parsed = parsePlanSnapshot(version.snapshotFormat, version.snapshot);
    if (parsed.format !== 2) return fail("Unsupported plan format.");
    snapshot = parsed.snapshot;
  } catch {
    return fail("The plan content is not valid.");
  }

  // 3. Target and environment.
  if (run.baseUrl !== app.authorizedUrl) return fail("The application's authorized URL changed after the run was queued.");
  if (run.environment !== app.environment) return fail("The application's environment changed after the run was queued.");
  if (!allowedEnvironments().has(app.environment)) return fail(`Execution against ${app.environment} is not allowed on this worker (EXECUTION_ALLOWED_ENVIRONMENTS).`);
  const staticBlock = staticUrlBlockReason(app.authorizedUrl);
  if (staticBlock) return fail(`Target blocked: ${BLOCK_REASON_LABELS[staticBlock]}.`);
  if (options.resolveDns !== false) {
    const url = new URL(app.authorizedUrl);
    const target = await resolveTarget(url.hostname, defaultPort(url));
    if (!target.ok) return fail(`Target blocked: ${target.detail}.`);
  }

  // 4. Every step is valid, stays within scope, and only references existing secrets.
  const secrets = new Map(app.secrets.map((s) => [s.name, s.reference]));
  for (const testCase of snapshot.cases) {
    for (const step of testCase.steps) {
      if (step.kind === null) continue; // descriptive steps make that case BLOCKED at run time
      const params = stepParamsSchemas[step.kind as StepKindName].safeParse(step.params);
      if (!params.success) return fail(`"${testCase.title}" step ${step.position + 1} is invalid.`);
      if ((step.kind === "NAVIGATE" || step.kind === "API_GET") && !resolveNavigation((params.data as { url: string }).url, app.authorizedUrl)) {
        return fail(`"${testCase.title}" step ${step.position + 1} ${step.kind === "API_GET" ? "requests" : "navigates"} outside the authorized URL.`);
      }
    }
    if (testCase.steps.every((s) => s.kind !== null)) {
      const [issue] = stepSequenceIssues(testCase.steps);
      if (issue) return fail(`"${testCase.title}": ${issue}.`);
    }
    for (const name of referencedSecrets(testCase.steps)) {
      if (!secrets.has(name)) return fail(`"${testCase.title}" uses secret ${name}, which this application doesn't have.`);
    }
  }

  return {
    ok: true,
    run: {
      runId,
      applicationId: app.id,
      projectId: app.projectId,
      authorizedUrl: app.authorizedUrl,
      environment: app.environment,
      contentHash: version.contentHash,
      snapshot,
      secrets,
    },
  };
}
