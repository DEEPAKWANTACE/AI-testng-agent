/**
 * Fixed-window limiter for failed sign-in attempts, keyed by account and by client IP.
 * In-memory, so limits are per server instance — move to a shared store (e.g. Redis or
 * Postgres) before running multiple instances.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

const failures = new Map<string, { count: number; resetAt: number }>();

export function isRateLimited(keys: string[], now = Date.now()): boolean {
  return keys.some((key) => {
    const entry = failures.get(key);
    if (!entry) return false;
    if (entry.resetAt <= now) {
      failures.delete(key);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  });
}

export function recordFailure(keys: string[], now = Date.now()): void {
  for (const key of keys) {
    const entry = failures.get(key);
    if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
    else entry.count += 1;
  }
}

export function clearFailures(keys: string[]): void {
  for (const key of keys) failures.delete(key);
}

export const RATE_LIMIT = { WINDOW_MS, MAX_FAILURES } as const;
