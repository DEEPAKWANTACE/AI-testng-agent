-- AI/heuristic test generation, case review, hash-bound approvals, execution bookkeeping,
-- regression comparison and an append-only audit log. Hand-edited from `prisma migrate diff`:
--   * PlanVersion.contentHash is a GENERATED column (the app can't write it);
--   * existing rows are backfilled (caseKey, snapshotFormat, approval hashes);
--   * triggers make submitted versions, decided approvals and the audit log immutable.

-- Content hash of a plan snapshot. jsonb's text form is canonical (sorted keys, fixed spacing).
-- Declared IMMUTABLE so it can back a generated column; valid because the database encoding
-- is fixed (UTF-8).
CREATE FUNCTION qa_snapshot_hash(snapshot jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') $$;


-- CreateEnum
CREATE TYPE "CaseReviewState" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StepKind" AS ENUM ('NAVIGATE', 'CLICK', 'FILL', 'SELECT', 'WAIT', 'ASSERT');

-- CreateEnum
CREATE TYPE "SuiteKind" AS ENUM ('STANDARD', 'REGRESSION');

-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ResultComparison" AS ENUM ('NEW', 'UNCHANGED', 'REGRESSED', 'FIXED', 'STILL_FAILING');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TestCaseType" ADD VALUE 'END_TO_END';
ALTER TYPE "TestCaseType" ADD VALUE 'POSITIVE';
ALTER TYPE "TestCaseType" ADD VALUE 'NEGATIVE';
ALTER TYPE "TestCaseType" ADD VALUE 'BOUNDARY';
ALTER TYPE "TestCaseType" ADD VALUE 'PERMISSION';

-- AlterEnum
ALTER TYPE "TestRunStatus" ADD VALUE 'BLOCKED';

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "decidedHash" TEXT,
ADD COLUMN     "requestedHash" TEXT,
ADD COLUMN     "reviewerProjectRole" "ProjectRole",
ADD COLUMN     "reviewerRole" "UserRole";

-- AlterTable
ALTER TABLE "PlanVersion"
  ADD COLUMN "contentHash" TEXT NOT NULL GENERATED ALWAYS AS (qa_snapshot_hash("snapshot")) STORED,
  ADD COLUMN "snapshotFormat" INTEGER NOT NULL DEFAULT 2;
-- Versions created before executable steps existed are legacy (descriptive steps only).
UPDATE "PlanVersion" SET "snapshotFormat" = 1;

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "blocked" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "coverage" JSONB,
ADD COLUMN     "errored" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fixed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "regressions" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StepResult" ADD COLUMN     "kind" "StepKind";

-- AlterTable
ALTER TABLE "TestCase" ADD COLUMN     "caseKey" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
ADD COLUMN     "generationJobId" TEXT,
ADD COLUMN     "prerequisites" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "requirementRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "reviewState" "CaseReviewState" NOT NULL DEFAULT 'ACCEPTED';

-- AlterTable
ALTER TABLE "TestResult" ADD COLUMN     "caseKey" TEXT,
ADD COLUMN     "category" "TestCaseType",
ADD COLUMN     "comparison" "ResultComparison",
ADD COLUMN     "featureName" TEXT,
ADD COLUMN     "previousStatus" "ResultStatus",
ADD COLUMN     "suspectedCause" TEXT;

-- AlterTable
ALTER TABLE "TestRun" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "blockedReason" TEXT,
ADD COLUMN     "comparedToRunId" TEXT,
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "environment" "AppEnvironment",
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "progressDone" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "progressTotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "workerId" TEXT;

-- AlterTable
ALTER TABLE "TestStep" ADD COLUMN     "kind" "StepKind",
ADD COLUMN     "params" JSONB;

-- AlterTable
ALTER TABLE "TestSuite" ADD COLUMN     "kind" "SuiteKind" NOT NULL DEFAULT 'STANDARD';

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "suiteId" TEXT,
    "status" "GenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "featureIds" TEXT[],
    "requirements" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "promptHash" TEXT,
    "caseCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "usage" JSONB,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "projectId" TEXT,
    "data" JSONB,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationJob_applicationId_createdAt_idx" ON "GenerationJob"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_status_idx" ON "GenerationJob"("status");

-- CreateIndex
CREATE INDEX "GenerationJob_requestedById_idx" ON "GenerationJob"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_hash_key" ON "AuditLog"("hash");

-- CreateIndex
CREATE INDEX "AuditLog_projectId_createdAt_idx" ON "AuditLog"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "TestCase_generationJobId_idx" ON "TestCase"("generationJobId");

-- CreateIndex
CREATE UNIQUE INDEX "TestCase_suiteId_caseKey_key" ON "TestCase"("suiteId", "caseKey");

-- CreateIndex
CREATE INDEX "TestResult_caseKey_idx" ON "TestResult"("caseKey");

-- CreateIndex
CREATE UNIQUE INDEX "TestResult_testRunId_caseKey_key" ON "TestResult"("testRunId", "caseKey");

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_generationJobId_fkey" FOREIGN KEY ("generationJobId") REFERENCES "GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_comparedToRunId_fkey" FOREIGN KEY ("comparedToRunId") REFERENCES "TestRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "TestSuite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- caseKey was backfilled via the temporary default; new keys come from the application.
ALTER TABLE "TestCase" ALTER COLUMN "caseKey" DROP DEFAULT;

-- Existing decided approvals: record the hash of the version they decided.
UPDATE "Approval" a SET "requestedHash" = v."contentHash",
  "decidedHash" = CASE WHEN a."status" <> 'PENDING' THEN v."contentHash" END
FROM "PlanVersion" v WHERE v."id" = a."planVersionId";

-- ─── Invariants ────────────────────────────────────────────────────────────

ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_format_check" CHECK ("snapshotFormat" IN (1, 2));
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_hash_check"
  CHECK (("requestedHash" IS NULL OR "requestedHash" ~ '^[0-9a-f]{64}$') AND ("decidedHash" IS NULL OR "decidedHash" ~ '^[0-9a-f]{64}$'));
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_progress_check"
  CHECK ("progressDone" >= 0 AND "progressTotal" >= 0 AND "progressDone" <= "progressTotal");
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_attempts_check" CHECK ("attempts" >= 0 AND "maxAttempts" BETWEEN 1 AND 10);
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_hash_check"
  CHECK ("hash" ~ '^[0-9a-f]{64}$' AND ("prevHash" IS NULL OR "prevHash" ~ '^[0-9a-f]{64}$'));

-- A submitted plan version's content is immutable (status/approvedAt may still change).
CREATE FUNCTION qa_plan_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."suiteId" IS DISTINCT FROM OLD."suiteId"
     OR NEW."snapshotFormat" IS DISTINCT FROM OLD."snapshotFormat"
     OR NEW."caseCount" IS DISTINCT FROM OLD."caseCount" THEN
    RAISE EXCEPTION 'plan version % is immutable', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PlanVersion_immutable" BEFORE UPDATE ON "PlanVersion"
  FOR EACH ROW EXECUTE FUNCTION qa_plan_version_immutable();

-- A decided approval can't be changed (reviewer/requester may only be cleared when a user is deleted).
CREATE FUNCTION qa_approval_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."decidedHash" IS DISTINCT FROM OLD."decidedHash"
       OR NEW."requestedHash" IS DISTINCT FROM OLD."requestedHash"
       OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
       OR NEW."comment" IS DISTINCT FROM OLD."comment"
       OR NEW."reviewerRole" IS DISTINCT FROM OLD."reviewerRole"
       OR NEW."reviewerProjectRole" IS DISTINCT FROM OLD."reviewerProjectRole"
       OR NEW."planVersionId" IS DISTINCT FROM OLD."planVersionId"
       OR (NEW."reviewerId" IS DISTINCT FROM OLD."reviewerId" AND NEW."reviewerId" IS NOT NULL)
       OR (NEW."requestedById" IS DISTINCT FROM OLD."requestedById" AND NEW."requestedById" IS NOT NULL)) THEN
    RAISE EXCEPTION 'approval % has been decided and is immutable', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Approval_immutable" BEFORE UPDATE ON "Approval"
  FOR EACH ROW EXECUTE FUNCTION qa_approval_immutable();

-- The audit log is append-only.
CREATE FUNCTION qa_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the audit log is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION qa_audit_append_only();
