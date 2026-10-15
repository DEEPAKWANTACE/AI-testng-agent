import "dotenv/config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside React Server Components; tests run modules directly.
      "server-only": fileURLToPath(new URL("./tests/helpers/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Point the app's database client at the throwaway test database.
          env: {
            DATABASE_URL: testDatabaseUrl,
            // Isolated Redis database and queue prefix for tests (global setup flushes db 15 only).
            REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15",
            QUEUE_PREFIX: "qa-test",
          },
          globalSetup: ["tests/helpers/global-setup.ts"],
          setupFiles: ["tests/helpers/next-mocks.ts"],
          // Files share one database, so run them one at a time.
          fileParallelism: false,
          // Discovery tests drive a real browser.
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
