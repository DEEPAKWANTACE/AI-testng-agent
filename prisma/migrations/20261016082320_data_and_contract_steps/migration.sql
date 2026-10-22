-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StepKind" ADD VALUE 'RELOAD';
ALTER TYPE "StepKind" ADD VALUE 'EXTRACT';
ALTER TYPE "StepKind" ADD VALUE 'ASSERT_CALC';
ALTER TYPE "StepKind" ADD VALUE 'API_GET';
ALTER TYPE "StepKind" ADD VALUE 'ASSERT_RESPONSE';
