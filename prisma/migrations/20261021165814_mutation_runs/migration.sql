-- CreateEnum
CREATE TYPE "MutationRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'BLOCKED', 'FAILED');

-- AlterEnum
ALTER TYPE "TestRunTrigger" ADD VALUE 'MUTATION';

-- CreateTable
CREATE TABLE "MutationRun" (
    "id" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "status" "MutationRunStatus" NOT NULL DEFAULT 'QUEUED',
    "mutantLimit" INTEGER NOT NULL DEFAULT 20,
    "baselineRunId" TEXT,
    "killed" INTEGER NOT NULL DEFAULT 0,
    "survived" INTEGER NOT NULL DEFAULT 0,
    "unclear" INTEGER NOT NULL DEFAULT 0,
    "score" DOUBLE PRECISION,
    "mutants" JSONB,
    "blockedReason" TEXT,
    "errorMessage" TEXT,
    "workerId" TEXT,
    "triggeredById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MutationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MutationRun_status_createdAt_idx" ON "MutationRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MutationRun_planVersionId_createdAt_idx" ON "MutationRun"("planVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "MutationRun_triggeredById_idx" ON "MutationRun"("triggeredById");

-- AddForeignKey
ALTER TABLE "MutationRun" ADD CONSTRAINT "MutationRun_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MutationRun" ADD CONSTRAINT "MutationRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
