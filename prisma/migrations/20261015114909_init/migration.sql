-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'QA_LEAD', 'QA_ENGINEER', 'VIEWER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INVITED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AppEnvironment" AS ENUM ('DEVELOPMENT', 'STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "AppType" AS ENUM ('WEB', 'API', 'MOBILE');

-- CreateEnum
CREATE TYPE "FeatureStatus" AS ENUM ('ACTIVE', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "ContentSource" AS ENUM ('MANUAL', 'AI_GENERATED', 'DISCOVERED');

-- CreateEnum
CREATE TYPE "DiscoveryRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TestSuiteStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TestCaseStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TestCaseType" AS ENUM ('FUNCTIONAL', 'SMOKE', 'REGRESSION', 'ACCESSIBILITY', 'VISUAL', 'API');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "PlanVersionStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TestRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TestRunTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'CI');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('PASSED', 'FAILED', 'SKIPPED', 'BLOCKED', 'ERROR');

-- CreateEnum
CREATE TYPE "DefectSeverity" AS ENUM ('CRITICAL', 'MAJOR', 'MINOR', 'TRIVIAL');

-- CreateEnum
CREATE TYPE "DefectStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'WONT_FIX');

-- CreateEnum
CREATE TYPE "ArtifactKind" AS ENUM ('SCREENSHOT', 'VIDEO', 'TRACE', 'LOG', 'HAR', 'DOM_SNAPSHOT', 'REPORT', 'OTHER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'QA_ENGINEER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "type" "AppType" NOT NULL DEFAULT 'WEB',
    "environment" "AppEnvironment" NOT NULL DEFAULT 'STAGING',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feature" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT,
    "status" "FeatureStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ContentSource" NOT NULL DEFAULT 'MANUAL',
    "discoveryRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryRun" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'QUEUED',
    "startUrl" TEXT NOT NULL,
    "maxDepth" INTEGER NOT NULL DEFAULT 2,
    "pagesVisited" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "errorMessage" TEXT,
    "triggeredById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestSuite" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "featureId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "TestSuiteStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ContentSource" NOT NULL DEFAULT 'MANUAL',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestSuite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestCase" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "featureId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "preconditions" TEXT,
    "expectedResult" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "type" "TestCaseType" NOT NULL DEFAULT 'FUNCTIONAL',
    "status" "TestCaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ContentSource" NOT NULL DEFAULT 'MANUAL',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestStep" (
    "id" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "expectedResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanVersion" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PlanVersionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "snapshot" JSONB NOT NULL,
    "caseCount" INTEGER NOT NULL,
    "changeSummary" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT,
    "reviewerId" TEXT,
    "comment" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestRun" (
    "id" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "status" "TestRunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "TestRunTrigger" NOT NULL DEFAULT 'MANUAL',
    "baseUrl" TEXT NOT NULL,
    "triggeredById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestResult" (
    "id" TEXT NOT NULL,
    "testRunId" TEXT NOT NULL,
    "testCaseId" TEXT,
    "caseTitle" TEXT NOT NULL,
    "casePriority" "Priority" NOT NULL,
    "status" "ResultStatus" NOT NULL,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepResult" (
    "id" TEXT NOT NULL,
    "testResultId" TEXT NOT NULL,
    "testStepId" TEXT,
    "position" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "expectedResult" TEXT,
    "actualResult" TEXT,
    "status" "ResultStatus" NOT NULL,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StepResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Defect" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "testResultId" TEXT,
    "testCaseId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "stepsToReproduce" TEXT,
    "severity" "DefectSeverity" NOT NULL DEFAULT 'MAJOR',
    "status" "DefectStatus" NOT NULL DEFAULT 'OPEN',
    "externalUrl" TEXT,
    "reportedById" TEXT,
    "assigneeId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Defect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "discoveryRunId" TEXT,
    "testRunId" TEXT,
    "testResultId" TEXT,
    "stepResultId" TEXT,
    "defectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "testRunId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_status_role_idx" ON "User"("status", "role");

-- CreateIndex
CREATE INDEX "Project_status_createdAt_idx" ON "Project"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Project_ownerId_idx" ON "Project"("ownerId");

-- CreateIndex
CREATE INDEX "Application_createdAt_idx" ON "Application"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Application_projectId_name_key" ON "Application"("projectId", "name");

-- CreateIndex
CREATE INDEX "Feature_discoveryRunId_idx" ON "Feature"("discoveryRunId");

-- CreateIndex
CREATE UNIQUE INDEX "Feature_applicationId_name_key" ON "Feature"("applicationId", "name");

-- CreateIndex
CREATE INDEX "DiscoveryRun_applicationId_createdAt_idx" ON "DiscoveryRun"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscoveryRun_status_idx" ON "DiscoveryRun"("status");

-- CreateIndex
CREATE INDEX "DiscoveryRun_triggeredById_idx" ON "DiscoveryRun"("triggeredById");

-- CreateIndex
CREATE INDEX "TestSuite_applicationId_updatedAt_idx" ON "TestSuite"("applicationId", "updatedAt");

-- CreateIndex
CREATE INDEX "TestSuite_featureId_idx" ON "TestSuite"("featureId");

-- CreateIndex
CREATE INDEX "TestSuite_createdById_idx" ON "TestSuite"("createdById");

-- CreateIndex
CREATE INDEX "TestCase_suiteId_position_idx" ON "TestCase"("suiteId", "position");

-- CreateIndex
CREATE INDEX "TestCase_featureId_idx" ON "TestCase"("featureId");

-- CreateIndex
CREATE INDEX "TestCase_createdById_idx" ON "TestCase"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "TestStep_testCaseId_position_key" ON "TestStep"("testCaseId", "position");

-- CreateIndex
CREATE INDEX "PlanVersion_status_createdAt_idx" ON "PlanVersion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PlanVersion_createdById_idx" ON "PlanVersion"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersion_suiteId_version_key" ON "PlanVersion"("suiteId", "version");

-- CreateIndex
CREATE INDEX "Approval_planVersionId_idx" ON "Approval"("planVersionId");

-- CreateIndex
CREATE INDEX "Approval_status_requestedAt_idx" ON "Approval"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "Approval_reviewerId_idx" ON "Approval"("reviewerId");

-- CreateIndex
CREATE INDEX "Approval_requestedById_idx" ON "Approval"("requestedById");

-- CreateIndex
CREATE INDEX "TestRun_planVersionId_createdAt_idx" ON "TestRun"("planVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "TestRun_status_createdAt_idx" ON "TestRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TestRun_triggeredById_idx" ON "TestRun"("triggeredById");

-- CreateIndex
CREATE INDEX "TestResult_testRunId_status_idx" ON "TestResult"("testRunId", "status");

-- CreateIndex
CREATE INDEX "TestResult_testCaseId_idx" ON "TestResult"("testCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "TestResult_testRunId_testCaseId_key" ON "TestResult"("testRunId", "testCaseId");

-- CreateIndex
CREATE INDEX "StepResult_testStepId_idx" ON "StepResult"("testStepId");

-- CreateIndex
CREATE UNIQUE INDEX "StepResult_testResultId_position_key" ON "StepResult"("testResultId", "position");

-- CreateIndex
CREATE INDEX "Defect_applicationId_status_idx" ON "Defect"("applicationId", "status");

-- CreateIndex
CREATE INDEX "Defect_status_severity_idx" ON "Defect"("status", "severity");

-- CreateIndex
CREATE INDEX "Defect_testResultId_idx" ON "Defect"("testResultId");

-- CreateIndex
CREATE INDEX "Defect_testCaseId_idx" ON "Defect"("testCaseId");

-- CreateIndex
CREATE INDEX "Defect_assigneeId_idx" ON "Defect"("assigneeId");

-- CreateIndex
CREATE INDEX "Defect_reportedById_idx" ON "Defect"("reportedById");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_storageKey_key" ON "Artifact"("storageKey");

-- CreateIndex
CREATE INDEX "Artifact_discoveryRunId_idx" ON "Artifact"("discoveryRunId");

-- CreateIndex
CREATE INDEX "Artifact_testRunId_idx" ON "Artifact"("testRunId");

-- CreateIndex
CREATE INDEX "Artifact_testResultId_idx" ON "Artifact"("testResultId");

-- CreateIndex
CREATE INDEX "Artifact_stepResultId_idx" ON "Artifact"("stepResultId");

-- CreateIndex
CREATE INDEX "Artifact_defectId_idx" ON "Artifact"("defectId");

-- CreateIndex
CREATE UNIQUE INDEX "Report_testRunId_key" ON "Report"("testRunId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feature" ADD CONSTRAINT "Feature_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feature" ADD CONSTRAINT "Feature_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSuite" ADD CONSTRAINT "TestSuite_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSuite" ADD CONSTRAINT "TestSuite_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSuite" ADD CONSTRAINT "TestSuite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "TestSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestStep" ADD CONSTRAINT "TestStep_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "TestSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResult" ADD CONSTRAINT "TestResult_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResult" ADD CONSTRAINT "TestResult_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepResult" ADD CONSTRAINT "StepResult_testResultId_fkey" FOREIGN KEY ("testResultId") REFERENCES "TestResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepResult" ADD CONSTRAINT "StepResult_testStepId_fkey" FOREIGN KEY ("testStepId") REFERENCES "TestStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_testResultId_fkey" FOREIGN KEY ("testResultId") REFERENCES "TestResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_testResultId_fkey" FOREIGN KEY ("testResultId") REFERENCES "TestResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_stepResultId_fkey" FOREIGN KEY ("stepResultId") REFERENCES "StepResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_defectId_fkey" FOREIGN KEY ("defectId") REFERENCES "Defect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Invariants not expressible in the Prisma schema ───────────────────────

-- Emails are stored lower-cased so the unique index is case-insensitive in practice.
ALTER TABLE "User" ADD CONSTRAINT "User_email_lowercase_check" CHECK ("email" = lower("email"));

-- A suite can have at most one version awaiting review, and a version at most one open request.
CREATE UNIQUE INDEX "PlanVersion_one_pending_per_suite" ON "PlanVersion"("suiteId") WHERE "status" = 'PENDING_APPROVAL';
CREATE UNIQUE INDEX "Approval_one_pending_per_version" ON "Approval"("planVersionId") WHERE "status" = 'PENDING';

-- A decided approval must record when it was decided; a pending one must not.
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_decided_at_check" CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL));

-- Every artifact belongs to exactly one owner.
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_single_owner_check"
  CHECK (num_nonnulls("discoveryRunId", "testRunId", "testResultId", "stepResultId", "defectId") = 1);

-- Counters, sizes and ordering are never negative.
ALTER TABLE "Artifact"     ADD CONSTRAINT "Artifact_size_check"        CHECK ("sizeBytes" >= 0);
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_depth_check"   CHECK ("maxDepth" BETWEEN 1 AND 10);
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_pages_check"   CHECK ("pagesVisited" >= 0);
ALTER TABLE "PlanVersion"  ADD CONSTRAINT "PlanVersion_version_check"  CHECK ("version" >= 1 AND "caseCount" >= 0);
ALTER TABLE "TestCase"     ADD CONSTRAINT "TestCase_position_check"    CHECK ("position" >= 0);
ALTER TABLE "TestStep"     ADD CONSTRAINT "TestStep_position_check"    CHECK ("position" >= 0);
ALTER TABLE "StepResult"   ADD CONSTRAINT "StepResult_position_check"  CHECK ("position" >= 0);
ALTER TABLE "TestResult"   ADD CONSTRAINT "TestResult_duration_check"  CHECK ("durationMs" IS NULL OR "durationMs" >= 0);
ALTER TABLE "StepResult"   ADD CONSTRAINT "StepResult_duration_check"  CHECK ("durationMs" IS NULL OR "durationMs" >= 0);
ALTER TABLE "Report"       ADD CONSTRAINT "Report_counts_check"        CHECK ("passed" >= 0 AND "failed" >= 0 AND "skipped" >= 0);
