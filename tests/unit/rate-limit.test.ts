import { describe, expect, it } from "vitest";
import { clearFailures, isRateLimited, RATE_LIMIT, recordFailure } from "@/modules/auth/rate-limit";

describe("sign-in rate limiting", () => {
  it("blocks a key after the maximum failures and releases it after the window", () => {
    const keys = ["email:limit@test.local"];
    const start = 1_000_000;
    for (let i = 0; i < RATE_LIMIT.MAX_FAILURES - 1; i++) recordFailure(keys, start);
    expect(isRateLimited(keys, start)).toBe(false);
    recordFailure(keys, start);
    expect(isRateLimited(keys, start)).toBe(true);
    expect(isRateLimited(keys, start + RATE_LIMIT.WINDOW_MS + 1)).toBe(false);
  });

  it("limits when any key (account or IP) is over the limit", () => {
    const ip = "ip:203.0.113.9";
    for (let i = 0; i < RATE_LIMIT.MAX_FAILURES; i++) recordFailure([ip], 5);
    expect(isRateLimited(["email:other@test.local", ip], 5)).toBe(true);
  });

  it("clears on success", () => {
    const keys = ["email:clear@test.local"];
    for (let i = 0; i < RATE_LIMIT.MAX_FAILURES; i++) recordFailure(keys, 10);
    clearFailures(keys);
    expect(isRateLimited(keys, 10)).toBe(false);
  });
});
