import { describe, expect, it } from "vitest";
import type { ResultStatus } from "@/generated/prisma/enums";
import { compareStatus } from "@/modules/reports/build";
import { scrubSecrets } from "@/worker/execution/executor";
import { overallStatus } from "@/worker/execution/runner";

describe("regression comparison", () => {
  it.each([
    [null, "PASSED", "NEW"],
    ["PASSED", "PASSED", "UNCHANGED"],
    ["PASSED", "FAILED", "REGRESSED"],
    ["PASSED", "ERROR", "REGRESSED"],
    ["FAILED", "PASSED", "FIXED"],
    ["FAILED", "FAILED", "STILL_FAILING"],
    ["BLOCKED", "FAILED", "UNCHANGED"],
    ["PASSED", "BLOCKED", "UNCHANGED"],
  ] as Array<[ResultStatus | null, ResultStatus, string]>)("%s → %s is %s", (previous, current, expected) => {
    expect(compareStatus(previous, current)).toBe(expected);
  });
});

describe("run status", () => {
  it.each([
    [["PASSED", "PASSED"], "PASSED"],
    [["PASSED", "FAILED"], "FAILED"],
    [["PASSED", "ERROR", "BLOCKED"], "FAILED"],
    [["PASSED", "BLOCKED"], "BLOCKED"],
    [["PASSED", "SKIPPED"], "BLOCKED"],
    [[], "BLOCKED"],
  ] as Array<[ResultStatus[], string]>)("%j → %s", (statuses, expected) => {
    expect(overallStatus(statuses)).toBe(expected);
  });
});

describe("secret scrubbing", () => {
  it("masks secret values in recorded text", () => {
    expect(scrubSecrets('Expected "hunter2-pass" in field', ["hunter2-pass"])).toBe('Expected "••••••" in field');
    expect(scrubSecrets(null, ["x"])).toBeNull();
    expect(scrubSecrets("ab", ["ab"])).toBe("ab"); // too short to mask meaningfully
  });
});
