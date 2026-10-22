-- CreateEnum
CREATE TYPE "FailureClass" AS ENUM ('APPLICATION', 'TEST_DEFINITION', 'INFRASTRUCTURE', 'ENVIRONMENT', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "ResultStatus" ADD VALUE 'INCONCLUSIVE';

-- AlterEnum
ALTER TYPE "TestRunStatus" ADD VALUE 'INCONCLUSIVE';

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "failureClasses" JSONB,
ADD COLUMN     "inconclusive" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StepResult" ADD COLUMN     "failureClass" "FailureClass";

-- AlterTable
ALTER TABLE "TestResult" ADD COLUMN     "failureClass" "FailureClass";
