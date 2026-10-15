-- Discovery worker: crawl limits, discovered pages, page evidence and login configuration.
-- Purely additive; no existing data is changed.

-- CreateEnum
CREATE TYPE "DiscoveryAuthMode" AS ENUM ('NONE', 'FORM_LOGIN');

-- DropIndex
DROP INDEX "DiscoveryRun_status_idx";

-- AlterTable
ALTER TABLE "Artifact" ADD COLUMN     "discoveredPageId" TEXT;

-- AlterTable
ALTER TABLE "DiscoveryRun" ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "maxPages" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN     "stats" JSONB,
ADD COLUMN     "workerId" TEXT;

-- CreateTable
CREATE TABLE "DiscoveryAuthConfig" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "mode" "DiscoveryAuthMode" NOT NULL DEFAULT 'NONE',
    "loginUrl" TEXT,
    "usernameSecretId" TEXT,
    "passwordSecretId" TEXT,
    "usernameSelector" TEXT,
    "passwordSelector" TEXT,
    "submitSelector" TEXT,
    "successSelector" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveryAuthConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredPage" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "featureId" TEXT,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "depth" INTEGER NOT NULL,
    "statusCode" INTEGER,
    "loadTimeMs" INTEGER,
    "elements" JSONB NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveredPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveryAuthConfig_applicationId_key" ON "DiscoveryAuthConfig"("applicationId");

-- CreateIndex
CREATE INDEX "DiscoveryAuthConfig_usernameSecretId_idx" ON "DiscoveryAuthConfig"("usernameSecretId");

-- CreateIndex
CREATE INDEX "DiscoveryAuthConfig_passwordSecretId_idx" ON "DiscoveryAuthConfig"("passwordSecretId");

-- CreateIndex
CREATE INDEX "DiscoveredPage_featureId_idx" ON "DiscoveredPage"("featureId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredPage_runId_url_key" ON "DiscoveredPage"("runId", "url");

-- CreateIndex
CREATE INDEX "Artifact_discoveredPageId_idx" ON "Artifact"("discoveredPageId");

-- CreateIndex
CREATE INDEX "DiscoveryRun_status_createdAt_idx" ON "DiscoveryRun"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "DiscoveryAuthConfig" ADD CONSTRAINT "DiscoveryAuthConfig_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryAuthConfig" ADD CONSTRAINT "DiscoveryAuthConfig_usernameSecretId_fkey" FOREIGN KEY ("usernameSecretId") REFERENCES "ApplicationSecret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryAuthConfig" ADD CONSTRAINT "DiscoveryAuthConfig_passwordSecretId_fkey" FOREIGN KEY ("passwordSecretId") REFERENCES "ApplicationSecret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredPage" ADD CONSTRAINT "DiscoveredPage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredPage" ADD CONSTRAINT "DiscoveredPage_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_discoveredPageId_fkey" FOREIGN KEY ("discoveredPageId") REFERENCES "DiscoveredPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Invariants not expressible in the Prisma schema ───────────────────────

-- Artifacts may now belong to a discovered page; still exactly one owner.
ALTER TABLE "Artifact" DROP CONSTRAINT "Artifact_single_owner_check";
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_single_owner_check"
  CHECK (num_nonnulls("discoveryRunId", "discoveredPageId", "testRunId", "testResultId", "stepResultId", "defectId") = 1);

-- Crawl limits and page metrics stay in range.
ALTER TABLE "DiscoveryRun"   ADD CONSTRAINT "DiscoveryRun_max_pages_check" CHECK ("maxPages" BETWEEN 1 AND 500);
ALTER TABLE "DiscoveredPage" ADD CONSTRAINT "DiscoveredPage_depth_check"   CHECK ("depth" >= 0);
ALTER TABLE "DiscoveredPage" ADD CONSTRAINT "DiscoveredPage_status_check"  CHECK ("statusCode" IS NULL OR "statusCode" BETWEEN 100 AND 599);
ALTER TABLE "DiscoveredPage" ADD CONSTRAINT "DiscoveredPage_load_check"    CHECK ("loadTimeMs" IS NULL OR "loadTimeMs" >= 0);

-- Form login needs a login URL and both credential references.
ALTER TABLE "DiscoveryAuthConfig" ADD CONSTRAINT "DiscoveryAuthConfig_form_login_check"
  CHECK ("mode" <> 'FORM_LOGIN' OR ("loginUrl" IS NOT NULL AND "usernameSecretId" IS NOT NULL AND "passwordSecretId" IS NOT NULL));
