import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getServerEnv } from "@/lib/env";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Returns the shared Prisma client, creating it on first use.
 * Reused across hot reloads in development to avoid exhausting connections.
 */
export function db(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const env = getServerEnv();
    const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
    globalForPrisma.prisma = new PrismaClient({
      adapter,
      log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return globalForPrisma.prisma;
}

