// Verifies database access and the schema's integrity rules against a live database.
// Run with `npm run db:verify`. Uses an isolated fixture and removes it afterwards.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { hashPassword } from "../src/modules/auth/password";
import { generateSessionToken, hashSessionToken } from "../src/modules/auth/tokens";
import { buildPlanSnapshot, parsePlanSnapshot } from "../src/modules/test-suites/snapshot";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const tag = randomUUID().slice(0, 8);
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];

function record(check: string, ok: boolean, detail?: string) {
  results.push({ check, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${check}${detail && !ok ? `\n    ${detail}` : ""}`);
}

/** Expects `fn` to be rejected by the database, with an error mentioning `expected`. */
async function expectRejected(check: string, expected: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    record(check, false, "write unexpectedly succeeded");
  } catch (error) {
    const text = `${(error as { code?: string }).code ?? ""} ${String(error)} ${JSON.stringify(error)}`;
    record(check, text.includes(expected), text.slice(0, 300));
  }
}

async function main() {
  // 1. Every table is reachable through the client.
  const counts = await Promise.all([
    prisma.user.count(), prisma.project.count(), prisma.application.count(), prisma.feature.count(),
    prisma.discoveryRun.count(), prisma.testSuite.count(), prisma.testCase.count(), prisma.testStep.count(),
    prisma.planVersion.count(), prisma.approval.count(), prisma.testRun.count(), prisma.testResult.count(),
    prisma.stepResult.count(), prisma.defect.count(), prisma.artifact.count(), prisma.report.count(),
    prisma.session.count(), prisma.projectMember.count(), prisma.applicationSecret.count(),
  ]);
  record(`read access to all 19 tables (${counts.reduce((a, b) => a + b, 0)} rows total)`, true);

  // 2. Stored plan snapshots match the Zod contract.
  const versions = await prisma.planVersion.findMany({ select: { snapshot: true, snapshotFormat: true, contentHash: true } });
  try {
    versions.forEach((v) => parsePlanSnapshot(v.snapshotFormat, v.snapshot));
    record(`all ${versions.length} stored plan snapshots parse`, true);
  } catch (error) {
    record("stored plan snapshots parse", false, String(error));
  }

  // Fixture
  const author = await prisma.user.create({
    data: { email: `author-${tag}@verify.test`, name: "Verify Author", passwordHash: await hashPassword("verify-password-123") },
  });
  const reviewer = await prisma.user.create({ data: { email: `reviewer-${tag}@verify.test`, name: "Verify Reviewer", role: "QA_LEAD" } });
  const project = await prisma.project.create({
    data: { name: `verify-${tag}`, members: { create: [{ userId: author.id, role: "OWNER" }, { userId: reviewer.id, role: "EDITOR" }] } },
  });
  const app = await prisma.application.create({
    data: {
      projectId: project.id,
      name: "App",
      authorizedUrl: "https://verify.test",
      repoUrl: "https://github.com/acme/app",
      repoBranch: "main",
      secrets: { create: { name: "TEST_PASSWORD", provider: "ENV", reference: "env://QA_VERIFY_PASSWORD" } },
    },
  });
  await prisma.session.create({
    data: { userId: author.id, tokenHash: hashSessionToken(generateSessionToken()), expiresAt: new Date(Date.now() + 60_000) },
  });
  const suite = await prisma.testSuite.create({
    data: {
      applicationId: app.id,
      name: "Suite",
      createdById: author.id,
      testCases: { create: { title: "Case", createdById: author.id, steps: { create: [{ position: 0, action: "Do it" }] } } },
    },
    include: { testCases: { include: { steps: true, feature: { select: { name: true } } } } },
  });
  const version = await prisma.planVersion.create({
    data: {
      suiteId: suite.id,
      version: 1,
      snapshot: buildPlanSnapshot(suite) as unknown as Prisma.InputJsonValue,
      caseCount: 1,
      createdById: author.id,
      approvals: { create: { requestedById: author.id } },
    },
  });
  const run = await prisma.testRun.create({ data: { planVersionId: version.id, baseUrl: app.authorizedUrl, triggeredById: author.id } });
  const [testCase] = suite.testCases;
  const result = await prisma.testResult.create({
    data: {
      testRunId: run.id,
      testCaseId: testCase.id,
      caseTitle: testCase.title,
      casePriority: testCase.priority,
      status: "FAILED",
      stepResults: { create: { position: 0, action: "Do it", status: "FAILED", testStepId: testCase.steps[0].id } },
    },
    include: { stepResults: true },
  });
  const defect = await prisma.defect.create({
    data: { applicationId: app.id, testResultId: result.id, title: "Bug", reportedById: author.id, assigneeId: author.id },
  });
  await prisma.artifact.create({
    data: { kind: "SCREENSHOT", name: "s.png", storageKey: `verify/${tag}/s.png`, mimeType: "image/png", sizeBytes: 1, stepResultId: result.stepResults[0].id },
  });
  await prisma.artifact.create({
    data: { kind: "LOG", name: "d.log", storageKey: `verify/${tag}/d.log`, mimeType: "text/plain", sizeBytes: 1, defectId: defect.id },
  });
  record("relational writes across every model", true);

  // 3. Relations resolve in both directions.
  const graph = await prisma.project.findUniqueOrThrow({
    where: { id: project.id },
    include: {
      members: true,
      applications: {
        include: {
          testSuites: { include: { planVersions: { include: { approvals: true, testRuns: { include: { results: { include: { stepResults: { include: { artifacts: true } }, defects: { include: { artifacts: true } } } } } } } } } },
        },
      },
    },
  });
  const res = graph.applications[0].testSuites[0].planVersions[0].testRuns[0].results[0];
  record(
    "nested relation graph project → artifacts",
    graph.members.some((m) => m.userId === author.id && m.role === "OWNER") && res.stepResults[0].artifacts.length === 1 && res.defects[0].artifacts.length === 1,
  );

  // 4. Constraints reject invalid data.
  await expectRejected("unique: duplicate application name in a project", "P2002", () =>
    prisma.application.create({ data: { projectId: project.id, name: "App", authorizedUrl: "https://verify.test" } }),
  );

  // Security constraints added with authentication.
  await expectRejected("check: plaintext password can't be stored", "User_password_hash_format_check", () =>
    prisma.user.update({ where: { id: author.id }, data: { passwordHash: "hunter2-plaintext" } }),
  );
  await expectRejected("check: session stores only a token hash", "Session_token_hash_format_check", () =>
    prisma.session.create({ data: { userId: author.id, tokenHash: "raw-session-token", expiresAt: new Date() } }),
  );
  await expectRejected("unique: one membership per user and project", "P2002", () =>
    prisma.projectMember.create({ data: { projectId: project.id, userId: author.id } }),
  );
  await expectRejected("check: branch requires a repository", "Application_repo_branch_check", () =>
    prisma.application.update({ where: { id: app.id }, data: { repoUrl: null } }),
  );
  await expectRejected("check: authorized URL can't embed credentials", "Application_authorized_url_check", () =>
    prisma.application.update({ where: { id: app.id }, data: { authorizedUrl: "https://user:pass@verify.test" } }),
  );
  await expectRejected("check: repository URL can't embed a token", "Application_repo_url_check", () =>
    prisma.application.update({ where: { id: app.id }, data: { repoUrl: "https://ghp_token@github.com/acme/app" } }),
  );
  await expectRejected("check: secret reference must match its provider", "ApplicationSecret_reference_check", () =>
    prisma.applicationSecret.create({
      data: { applicationId: app.id, name: "LEAKED", provider: "VAULT", reference: "s3cr3t-password-value" },
    }),
  );
  await expectRejected("check: secret names are UPPER_SNAKE_CASE", "ApplicationSecret_name_check", () =>
    prisma.applicationSecret.create({
      data: { applicationId: app.id, name: "lower-case", provider: "ENV", reference: "env://QA_X" },
    }),
  );
  await expectRejected("unique: secret name per application", "P2002", () =>
    prisma.applicationSecret.create({
      data: { applicationId: app.id, name: "TEST_PASSWORD", provider: "ENV", reference: "env://QA_OTHER" },
    }),
  );
  await expectRejected("unique: duplicate plan version number", "P2002", () =>
    prisma.planVersion.create({ data: { suiteId: suite.id, version: 1, snapshot: {}, caseCount: 0, status: "REJECTED" } }),
  );
  await expectRejected("partial unique: second pending version for a suite", "P2002", () =>
    prisma.planVersion.create({ data: { suiteId: suite.id, version: 2, snapshot: {}, caseCount: 0 } }),
  );
  await expectRejected("partial unique: second pending approval for a version", "P2002", () =>
    prisma.approval.create({ data: { planVersionId: version.id } }),
  );
  await expectRejected("check: email must be lower-case", "User_email_lowercase_check", () =>
    prisma.user.create({ data: { email: `UPPER-${tag}@verify.test`, name: "Upper" } }),
  );
  await expectRejected("check: decided approval needs decidedAt", "Approval_decided_at_check", () =>
    prisma.approval.updateMany({ where: { planVersionId: version.id }, data: { status: "APPROVED" } }),
  );
  await expectRejected("check: artifact with no owner", "Artifact_single_owner_check", () =>
    prisma.artifact.create({ data: { kind: "LOG", name: "x", storageKey: `verify/${tag}/none`, mimeType: "text/plain", sizeBytes: 1 } }),
  );
  await expectRejected("check: artifact with two owners", "Artifact_single_owner_check", () =>
    prisma.artifact.create({
      data: { kind: "LOG", name: "x", storageKey: `verify/${tag}/two`, mimeType: "text/plain", sizeBytes: 1, testRunId: run.id, defectId: defect.id },
    }),
  );
  await expectRejected("check: negative artifact size", "Artifact_size_check", () =>
    prisma.artifact.create({ data: { kind: "LOG", name: "x", storageKey: `verify/${tag}/neg`, mimeType: "text/plain", sizeBytes: -1, testRunId: run.id } }),
  );
  await expectRejected("check: discovery depth out of range", "DiscoveryRun_depth_check", () =>
    prisma.discoveryRun.create({ data: { applicationId: app.id, startUrl: "https://verify.test", maxDepth: 0 } }),
  );
  await expectRejected("foreign key: result for missing run", "P2003", () =>
    prisma.testResult.create({ data: { testRunId: "missing", caseTitle: "x", casePriority: "LOW", status: "PASSED" } }),
  );

  // 5. ON DELETE SET NULL keeps history when a user is removed.
  await prisma.approval.updateMany({
    where: { planVersionId: version.id },
    data: { status: "APPROVED", reviewerId: reviewer.id, decidedAt: new Date() },
  });
  await prisma.user.delete({ where: { id: reviewer.id } });
  await prisma.user.delete({ where: { id: author.id } });
  const [approvalAfter, suiteAfter, defectAfter, membersAfter, sessionsAfter] = await Promise.all([
    prisma.approval.findFirstOrThrow({ where: { planVersionId: version.id } }),
    prisma.testSuite.findUniqueOrThrow({ where: { id: suite.id } }),
    prisma.defect.findUniqueOrThrow({ where: { id: defect.id } }),
    prisma.projectMember.count({ where: { projectId: project.id } }),
    prisma.session.count({ where: { userId: { in: [author.id, reviewer.id] } } }),
  ]);
  record(
    "set null: deleting users keeps approvals, suites and defects",
    approvalAfter.reviewerId === null &&
      approvalAfter.requestedById === null &&
      suiteAfter.createdById === null &&
      defectAfter.reportedById === null &&
      defectAfter.assigneeId === null,
  );
  record("cascade: deleting users removes their sessions and memberships", membersAfter === 0 && sessionsAfter === 0);

  // 6. Deleting a test case keeps its results (SET NULL) with the snapshotted title.
  await prisma.testCase.delete({ where: { id: testCase.id } });
  const resultAfter = await prisma.testResult.findUniqueOrThrow({ where: { id: result.id }, include: { stepResults: true } });
  record(
    "set null: deleting a case keeps results and step results",
    resultAfter.testCaseId === null && resultAfter.caseTitle === "Case" && resultAfter.stepResults[0].testStepId === null,
  );

  // 7. ON DELETE CASCADE removes the whole tree with the project.
  await prisma.project.delete({ where: { id: project.id } });
  const leftovers = await Promise.all([
    prisma.application.count({ where: { id: app.id } }),
    prisma.testSuite.count({ where: { id: suite.id } }),
    prisma.planVersion.count({ where: { id: version.id } }),
    prisma.approval.count({ where: { planVersionId: version.id } }),
    prisma.testRun.count({ where: { id: run.id } }),
    prisma.testResult.count({ where: { id: result.id } }),
    prisma.stepResult.count({ where: { testResultId: result.id } }),
    prisma.defect.count({ where: { id: defect.id } }),
    prisma.artifact.count({ where: { storageKey: { startsWith: `verify/${tag}/` } } }),
    prisma.applicationSecret.count({ where: { applicationId: app.id } }),
  ]);
  record("cascade: deleting a project removes its whole tree", leftovers.every((n) => n === 0), `leftovers: ${leftovers}`);
}

main()
  .catch((error) => {
    record("verification script crashed", false, String(error));
  })
  .finally(async () => {
    // Best-effort cleanup if a check crashed midway.
    await prisma.project.deleteMany({ where: { name: `verify-${tag}` } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { endsWith: `-${tag}@verify.test` } } }).catch(() => {});
    await prisma.$disconnect();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exitCode = failed ? 1 : 0;
  });
