import { beforeEach, describe, expect, it } from "vitest";
import { runBenchmark } from "@/benchmark/runner";
import { db } from "@/lib/db";
import { resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
});

describe("accuracy benchmark", () => {
  it("measures recall, precision, reliability and coverage end to end, then cleans up", { timeout: 600_000 }, async () => {
    const result = await runBenchmark({ faults: ["wrong-discount", "profile-api-unprotected", "restyled-products"], repeats: 2, runner: { stepTimeoutMs: 3_000 } });

    const fault = (name: string) => result.details.perFault.find((f) => f.fault === name)!;
    expect(fault("wrong-discount")).toMatchObject({ detected: true, falsePositives: [], truePositives: ["Cart totals follow the pricing rules"] });
    expect(fault("profile-api-unprotected")).toMatchObject({ detected: true, falsePositives: [] });
    expect(fault("restyled-products")).toMatchObject({ detected: true, falsePositives: [] });
    expect(result.details.cleanFalsePositives).toEqual([]);
    expect(result.details.noiseFalsePositives).toEqual([]);
    expect(result.details.inconsistent).toEqual([]);
    expect(result.metrics).toMatchObject({ bugRecall: 1, caseRecall: 1, reportPrecision: 1, falseAlarmsOnCleanApp: 0, executionReliability: 1, infrastructureRate: 0, flakyHandled: true, faultsEvaluated: 3, cleanRuns: 2 });
    expect(result.metrics.inventoryVerified).toBeGreaterThan(0.5);
    expect(result.metrics.inventoryVerified).toBeLessThan(1); // POST /cart is known but deliberately never called

    // Stored for the benchmark page; the scratch project and accounts are gone.
    const stored = await db().benchmarkRun.findUniqueOrThrow({ where: { id: result.id } });
    expect(stored).toMatchObject({ status: "SUCCEEDED", corpusVersion: expect.stringContaining("demo-shop") });
    expect(await db().project.count()).toBe(0);
    expect(await db().user.count()).toBe(0);
  });
});
