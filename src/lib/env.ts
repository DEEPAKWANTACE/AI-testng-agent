import "server-only";
import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is not set. Copy .env.example to .env and fill it in." })
    .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgresql:// connection string"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Parsed lazily so `next build` works without a database configured. */
export function getServerEnv(): ServerEnv {
  if (!cached) {
    const result = serverEnvSchema.safeParse(process.env);
    if (!result.success) {
      throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
    }
    cached = result.data;
  }
  return cached;
}
