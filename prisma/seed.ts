// Seeds a demo workspace covering every model. Run with `npm run db:seed` (idempotent).
//
// Demo users share one password, taken from SEED_USER_PASSWORD. If it isn't set, a random
// password is generated and printed once. Only scrypt hashes are written to the database.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { hashPassword } from "../src/modules/auth/password";
import { passwordSchema } from "../src/modules/auth/schemas";
import { buildPlanSnapshot } from "../src/modules/test-suites/snapshot";

if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
  throw new Error("Refusing to create demo users in production. Set ALLOW_DEMO_SEED=true to override.");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const BASE_URL = "https://staging.example.com";

async function main() {
  if (await prisma.user.findUnique({ where: { email: "admin@example.com" } })) {
    console.log("Demo data already present — skipping.");
    return;
  }

  const generated = !process.env.SEED_USER_PASSWORD;
  const password = process.env.SEED_USER_PASSWORD ?? randomBytes(12).toString("base64url");
  passwordSchema.parse(password);
  // Hash before the transaction (scrypt is deliberately slow); one hash per user so salts differ.
  const hashes = await Promise.all(Array.from({ length: 5 }, () => hashPassword(password)));

  await prisma.$transaction(async (tx) => {
    const user = (email: string, name: string, role: "ADMIN" | "QA_LEAD" | "QA_ENGINEER" | "VIEWER") =>
      tx.user.create({ data: { email, name, role, passwordHash: hashes.pop() } });
    const admin = await user("admin@example.com", "Ada Admin", "ADMIN");
    const lead = await user("lead@example.com", "Quinn Lead", "QA_LEAD");
    const engineer = await user("engineer@example.com", "Eli Engineer", "QA_ENGINEER");
    const viewer = await user("viewer@example.com", "Vic Viewer", "VIEWER");
    const outsider = await user("outsider@example.com", "Olive Outsider", "QA_ENGINEER");

    // Inventory: Demo Store is shared with the team; Internal Tools belongs to the outsider only.
    const project = await tx.project.create({
      data: {
        name: "Demo Store",
        description: "Sample e-commerce project for exploring the dashboard.",
        members: {
          create: [
            { userId: admin.id, role: "OWNER" },
            { userId: lead.id, role: "EDITOR" },
            { userId: engineer.id, role: "EDITOR" },
            { userId: viewer.id, role: "VIEWER" },
          ],
        },
      },
    });
    await tx.project.create({
      data: {
        name: "Internal Tools",
        description: "Visible only to its members (and admins).",
        members: { create: { userId: outsider.id, role: "OWNER" } },
        applications: {
          create: { name: "Back office", authorizedUrl: "https://backoffice.example.com", environment: "PRODUCTION" },
        },
      },
    });
    const app = await tx.application.create({
      data: {
        projectId: project.id,
        name: "Storefront",
        authorizedUrl: BASE_URL,
        type: "WEB",
        environment: "STAGING",
        description: "Customer-facing web store.",
        repoUrl: "https://github.com/example/storefront",
        repoBranch: "main",
        secrets: {
          create: [
            {
              name: "TEST_USER_EMAIL",
              provider: "ENV",
              reference: "env://QA_STOREFRONT_EMAIL",
              description: "Login for the shared test customer",
              createdById: engineer.id,
            },
            {
              name: "TEST_USER_PASSWORD",
              provider: "VAULT",
              reference: "vault://kv/qa/storefront#password",
              createdById: engineer.id,
            },
          ],
        },
      },
    });

    // Discovery: one completed run that found features, one queued
    const now = Date.now();
    const discovery = await tx.discoveryRun.create({
      data: {
        applicationId: app.id,
        startUrl: BASE_URL,
        maxDepth: 3,
        status: "COMPLETED",
        pagesVisited: 42,
        summary: "Found 3 functional areas across 42 pages.",
        triggeredById: engineer.id,
        startedAt: new Date(now - 3_600_000),
        finishedAt: new Date(now - 3_300_000),
        artifacts: {
          create: { kind: "LOG", name: "crawl.log", storageKey: "demo/discovery/crawl.log", mimeType: "text/plain", sizeBytes: 18_432 },
        },
      },
    });
    await tx.discoveryRun.create({ data: { applicationId: app.id, startUrl: `${BASE_URL}/account`, triggeredById: engineer.id } });

    const [checkout] = await Promise.all(
      [
        { name: "Checkout", url: `${BASE_URL}/checkout` },
        { name: "Cart", url: `${BASE_URL}/cart` },
        { name: "Account", url: `${BASE_URL}/account` },
      ].map((feature) =>
        tx.feature.create({ data: { ...feature, applicationId: app.id, source: "DISCOVERED", discoveryRunId: discovery.id } }),
      ),
    );

    // Test design: an approved suite and a draft suite
    const suite = await tx.testSuite.create({
      data: {
        applicationId: app.id,
        featureId: checkout.id,
        name: "Checkout regression",
        description: "Core purchase path for guest and signed-in customers.",
        createdById: engineer.id,
        testCases: {
          create: [
            {
              title: "Guest can complete checkout",
              expectedResult: "Order confirmation page shows an order number.",
              priority: "CRITICAL",
              type: "REGRESSION",
              position: 0,
              featureId: checkout.id,
              createdById: engineer.id,
              steps: {
                create: [
                  { position: 0, action: "Add a product to the cart" },
                  { position: 1, action: "Open the cart and click Checkout" },
                  { position: 2, action: "Fill shipping and payment details" },
                  { position: 3, action: "Place the order", expectedResult: "Confirmation page loads" },
                ],
              },
            },
            {
              title: "Invalid coupon shows an error",
              expectedResult: "An inline error explains the coupon is not valid; totals are unchanged.",
              priority: "MEDIUM",
              type: "FUNCTIONAL",
              position: 1,
              featureId: checkout.id,
              createdById: engineer.id,
              steps: {
                create: [
                  { position: 0, action: "Open the cart" },
                  { position: 1, action: "Enter coupon code INVALID" },
                  { position: 2, action: "Click Apply", expectedResult: "Inline error is shown" },
                ],
              },
            },
          ],
        },
      },
      include: { testCases: { orderBy: { position: "asc" }, include: { steps: { orderBy: { position: "asc" } }, feature: { select: { name: true } } } } },
    });

    await tx.testSuite.create({
      data: {
        applicationId: app.id,
        name: "Account smoke",
        createdById: engineer.id,
        testCases: {
          create: {
            title: "User can sign in",
            expectedResult: "Account dashboard is shown.",
            priority: "HIGH",
            type: "SMOKE",
            steps: { create: [{ position: 0, action: "Open /login" }, { position: 1, action: "Submit valid credentials" }] },
          },
        },
      },
    });

    // Review: v1 submitted by the engineer, approved by the lead
    const approvedAt = new Date(now - 1_800_000);
    const version = await tx.planVersion.create({
      data: {
        suiteId: suite.id,
        version: 1,
        status: "APPROVED",
        snapshot: buildPlanSnapshot(suite) as unknown as Prisma.InputJsonValue,
        caseCount: suite.testCases.length,
        changeSummary: "Initial checkout coverage.",
        createdById: engineer.id,
        approvedAt,
      },
    });
    // The approval is bound to the version's database-computed content hash.
    await tx.approval.create({
      data: {
        planVersionId: version.id,
        status: "APPROVED",
        requestedById: engineer.id,
        reviewerId: lead.id,
        comment: "Looks good.",
        requestedHash: version.contentHash,
        decidedHash: version.contentHash,
        reviewerRole: "QA_LEAD",
        reviewerProjectRole: "EDITOR",
        requestedAt: new Date(now - 2_400_000),
        decidedAt: approvedAt,
      },
    });

    // Execution: a finished run with one pass and one failure
    const [guestCase, couponCase] = suite.testCases;
    const run = await tx.testRun.create({
      data: {
        planVersionId: version.id,
        status: "FAILED",
        baseUrl: BASE_URL,
        triggeredById: engineer.id,
        startedAt: new Date(now - 900_000),
        finishedAt: new Date(now - 840_000),
        artifacts: {
          create: { kind: "TRACE", name: "run-trace.zip", storageKey: "demo/runs/trace.zip", mimeType: "application/zip", sizeBytes: 1_048_576 },
        },
      },
    });

    await tx.testResult.create({
      data: {
        testRunId: run.id,
        testCaseId: guestCase.id,
        caseTitle: guestCase.title,
        casePriority: guestCase.priority,
        status: "PASSED",
        durationMs: 18_250,
        stepResults: {
          create: guestCase.steps.map((step) => ({
            testStepId: step.id,
            position: step.position,
            action: step.action,
            expectedResult: step.expectedResult,
            status: "PASSED" as const,
            durationMs: 4_000,
          })),
        },
      },
    });

    const failed = await tx.testResult.create({
      data: {
        testRunId: run.id,
        testCaseId: couponCase.id,
        caseTitle: couponCase.title,
        casePriority: couponCase.priority,
        status: "FAILED",
        durationMs: 9_120,
        errorMessage: "Expected an inline coupon error, but the page showed no feedback.",
        stepResults: {
          create: couponCase.steps.map((step) => ({
            testStepId: step.id,
            position: step.position,
            action: step.action,
            expectedResult: step.expectedResult,
            status: step.position === 2 ? ("FAILED" as const) : ("PASSED" as const),
            actualResult: step.position === 2 ? "No error message rendered" : null,
            durationMs: 3_000,
          })),
        },
      },
      include: { stepResults: { where: { status: "FAILED" } } },
    });

    await tx.artifact.create({
      data: {
        kind: "SCREENSHOT",
        name: "coupon-apply.png",
        storageKey: "demo/runs/coupon-apply.png",
        mimeType: "image/png",
        sizeBytes: 204_800,
        stepResultId: failed.stepResults[0].id,
      },
    });

    await tx.defect.create({
      data: {
        applicationId: app.id,
        testResultId: failed.id,
        testCaseId: couponCase.id,
        title: "Invalid coupon gives no feedback",
        description: "Applying an invalid coupon code silently does nothing.",
        stepsToReproduce: couponCase.steps.map((s) => `${s.position + 1}. ${s.action}`).join("\n"),
        severity: "MAJOR",
        reportedById: lead.id,
        assigneeId: engineer.id,
        artifacts: {
          create: {
            kind: "SCREENSHOT",
            name: "defect-evidence.png",
            storageKey: "demo/defects/coupon.png",
            mimeType: "image/png",
            sizeBytes: 198_000,
          },
        },
      },
    });

    await tx.report.create({
      data: {
        testRunId: run.id,
        title: "Checkout regression v1 — run report",
        summary: "1 of 2 cases passed. The invalid-coupon case failed; a defect has been raised.",
        passed: 1,
        failed: 1,
        skipped: 0,
      },
    });
  });

  console.log("Seeded demo workspace.");
  console.log("Users: admin@, lead@, engineer@, viewer@, outsider@example.com");
  if (generated) console.log(`Generated password for all demo users (shown once): ${password}`);
  else console.log("Password: the value of SEED_USER_PASSWORD");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
