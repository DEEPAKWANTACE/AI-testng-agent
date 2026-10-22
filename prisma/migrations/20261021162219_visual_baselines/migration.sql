-- CreateEnum
CREATE TYPE "BaselineStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- AlterEnum
ALTER TYPE "StepKind" ADD VALUE 'ASSERT_VISUAL';

-- CreateTable
CREATE TABLE "VisualBaseline" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "BaselineStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "testRunId" TEXT,
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VisualBaseline_storageKey_key" ON "VisualBaseline"("storageKey");

-- CreateIndex
CREATE INDEX "VisualBaseline_applicationId_caseKey_name_status_idx" ON "VisualBaseline"("applicationId", "caseKey", "name", "status");

-- CreateIndex
CREATE INDEX "VisualBaseline_status_createdAt_idx" ON "VisualBaseline"("status", "createdAt");

-- CreateIndex
CREATE INDEX "VisualBaseline_reviewerId_idx" ON "VisualBaseline"("reviewerId");

-- AddForeignKey
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One approved baseline per (application, case, name); reviewed states need a review time.
CREATE UNIQUE INDEX "VisualBaseline_one_approved" ON "VisualBaseline" ("applicationId", "caseKey", "name") WHERE "status" = 'APPROVED';
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_review_recorded"
  CHECK ("status" NOT IN ('APPROVED', 'REJECTED') OR "reviewedAt" IS NOT NULL);
