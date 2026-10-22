-- CreateTable
CREATE TABLE "BenchmarkRun" (
    "id" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'RUNNING',
    "corpusVersion" TEXT NOT NULL,
    "gitCommit" TEXT,
    "config" JSONB NOT NULL,
    "metrics" JSONB,
    "details" JSONB,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BenchmarkRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BenchmarkRun_startedAt_idx" ON "BenchmarkRun"("startedAt");
