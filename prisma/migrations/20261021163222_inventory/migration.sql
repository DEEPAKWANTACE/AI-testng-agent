-- CreateEnum
CREATE TYPE "InventoryKind" AS ENUM ('ROUTE', 'API_ENDPOINT', 'ROLE', 'REQUIREMENT', 'WORKFLOW');

-- CreateEnum
CREATE TYPE "InventorySource" AS ENUM ('OPENAPI', 'REQUIREMENTS', 'SOURCE_CODE', 'DISCOVERY');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "InventoryDocument" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "source" "InventorySource" NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceAnalysis" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "repoUrl" TEXT NOT NULL,
    "repoBranch" TEXT,
    "tokenSecret" TEXT,
    "commitSha" TEXT,
    "stats" JSONB,
    "errorMessage" TEXT,
    "workerId" TEXT,
    "triggeredById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" "InventoryKind" NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" JSONB,
    "sources" JSONB NOT NULL,
    "confidence" "Confidence" NOT NULL DEFAULT 'MEDIUM',
    "protected" BOOLEAN,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryDocument_applicationId_source_createdAt_idx" ON "InventoryDocument"("applicationId", "source", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryDocument_createdById_idx" ON "InventoryDocument"("createdById");

-- CreateIndex
CREATE INDEX "SourceAnalysis_status_createdAt_idx" ON "SourceAnalysis"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SourceAnalysis_applicationId_createdAt_idx" ON "SourceAnalysis"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "SourceAnalysis_triggeredById_idx" ON "SourceAnalysis"("triggeredById");

-- CreateIndex
CREATE INDEX "InventoryItem_applicationId_active_kind_idx" ON "InventoryItem"("applicationId", "active", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_applicationId_kind_key_key" ON "InventoryItem"("applicationId", "kind", "key");

-- AddForeignKey
ALTER TABLE "InventoryDocument" ADD CONSTRAINT "InventoryDocument_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDocument" ADD CONSTRAINT "InventoryDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceAnalysis" ADD CONSTRAINT "SourceAnalysis_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceAnalysis" ADD CONSTRAINT "SourceAnalysis_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
