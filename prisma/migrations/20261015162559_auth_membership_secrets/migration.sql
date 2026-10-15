-- Authentication, project membership, application repository fields and secret references.
-- Hand-edited from `prisma migrate diff` so that no existing data is lost:
--   * Application.baseUrl is renamed (not dropped) to authorizedUrl.
--   * Project.ownerId is converted into OWNER memberships before the column is dropped.

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "SecretProvider" AS ENUM ('ENV', 'VAULT', 'AWS_SECRETS_MANAGER', 'GCP_SECRET_MANAGER', 'AZURE_KEY_VAULT');

-- ─── Users & sessions ──────────────────────────────────────────────────────

ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMP(3),
ADD COLUMN "passwordHash" TEXT;

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Project membership (replaces Project.ownerId) ─────────────────────────

CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ProjectRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing owner becomes an OWNER member. IDs are cuid-shaped ("c" + 24 chars)
-- because the application validates record IDs as cuids.
INSERT INTO "ProjectMember" ("id", "projectId", "userId", "role", "updatedAt")
SELECT 'c' || substr(md5(random()::text || p."id"), 1, 24), p."id", p."ownerId", 'OWNER', CURRENT_TIMESTAMP
FROM "Project" p
WHERE p."ownerId" IS NOT NULL;

ALTER TABLE "Project" DROP CONSTRAINT "Project_ownerId_fkey";
DROP INDEX "Project_ownerId_idx";
ALTER TABLE "Project" DROP COLUMN "ownerId";

-- ─── Applications ──────────────────────────────────────────────────────────

ALTER TABLE "Application" RENAME COLUMN "baseUrl" TO "authorizedUrl";
ALTER TABLE "Application" ADD COLUMN "repoBranch" TEXT,
ADD COLUMN "repoUrl" TEXT;

CREATE TABLE "ApplicationSecret" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "SecretProvider" NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationSecret_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApplicationSecret_createdById_idx" ON "ApplicationSecret"("createdById");
CREATE UNIQUE INDEX "ApplicationSecret_applicationId_name_key" ON "ApplicationSecret"("applicationId", "name");
ALTER TABLE "ApplicationSecret" ADD CONSTRAINT "ApplicationSecret_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationSecret" ADD CONSTRAINT "ApplicationSecret_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Invariants not expressible in the Prisma schema ───────────────────────

-- Defence in depth: the password column can only ever hold an scrypt hash, never plaintext.
ALTER TABLE "User" ADD CONSTRAINT "User_password_hash_format_check"
  CHECK ("passwordHash" IS NULL OR "passwordHash" ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{64,}$');

-- Session token hashes are hex SHA-256 digests.
ALTER TABLE "Session" ADD CONSTRAINT "Session_token_hash_format_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- A branch only makes sense with a repository; neither URL may embed credentials.
ALTER TABLE "Application" ADD CONSTRAINT "Application_repo_branch_check" CHECK ("repoBranch" IS NULL OR "repoUrl" IS NOT NULL);
ALTER TABLE "Application" ADD CONSTRAINT "Application_authorized_url_check" CHECK ("authorizedUrl" ~ '^https?://[^/@\s]+(/[^@\s]*)?$');
ALTER TABLE "Application" ADD CONSTRAINT "Application_repo_url_check"
  CHECK ("repoUrl" IS NULL OR "repoUrl" ~ '^(https://[^/@:\s]+/[^@\s]+|ssh://git@[^/\s]+/\S+|git@[^:/\s]+:\S+)$');

-- Secret references must use the scheme of their provider, and names look like env vars.
ALTER TABLE "ApplicationSecret" ADD CONSTRAINT "ApplicationSecret_name_check" CHECK ("name" ~ '^[A-Z][A-Z0-9_]{0,63}$');
ALTER TABLE "ApplicationSecret" ADD CONSTRAINT "ApplicationSecret_reference_check" CHECK (
  ("provider" = 'ENV' AND "reference" ~ '^env://[A-Z][A-Z0-9_]*$') OR
  ("provider" = 'VAULT' AND "reference" ~ '^vault://[A-Za-z0-9_./-]+#[A-Za-z0-9_.-]+$') OR
  ("provider" = 'AWS_SECRETS_MANAGER' AND "reference" ~ '^aws-sm://[A-Za-z0-9_+=.@/:-]+(#[A-Za-z0-9_.-]+)?$') OR
  ("provider" = 'GCP_SECRET_MANAGER' AND "reference" ~ '^gcp-sm://projects/[a-z0-9-]+/secrets/[A-Za-z0-9_-]+(/versions/(latest|[0-9]+))?$') OR
  ("provider" = 'AZURE_KEY_VAULT' AND "reference" ~ '^azure-kv://[a-z0-9-]+/[A-Za-z0-9-]+(/[0-9a-f]{32})?$')
);
