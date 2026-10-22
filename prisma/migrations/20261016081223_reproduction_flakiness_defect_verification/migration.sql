-- CreateEnum
CREATE TYPE "DefectVerification" AS ENUM ('REPRODUCED', 'CONFIRMED', 'NOT_CONFIRMED');

-- AlterTable
ALTER TABLE "Defect" ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "verification" "DefectVerification" NOT NULL DEFAULT 'REPRODUCED',
ADD COLUMN     "verificationNote" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedById" TEXT;

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "flaky" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TestResult" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "attempts" JSONB,
ADD COLUMN     "flakeRate" DOUBLE PRECISION,
ADD COLUMN     "flaky" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
