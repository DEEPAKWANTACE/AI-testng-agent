/**
 * First-deploy setup (idempotent), run as the web service's pre-deploy step after migrations:
 *
 * - ADMIN_EMAIL + ADMIN_PASSWORD: creates that ADMIN user if it doesn't exist. The password is
 *   hashed with scrypt; only the hash is stored. Remove ADMIN_PASSWORD from the environment
 *   after the first deploy if you like — an existing user is never changed.
 * - DEMO_SHOP_URL: creates a "Demo" project with the Demo Shop application, its secret
 *   references (env://QA_DEMO_EMAIL / env://QA_DEMO_PASSWORD, resolved by the workers) and
 *   discovery login, so discovery and test runs can be tried immediately.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/modules/auth/password";
import { emailSchema, passwordSchema } from "../src/modules/auth/schemas";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL ? emailSchema.parse(process.env.ADMIN_EMAIL) : null;
  let adminId: string | null = null;

  if (adminEmail) {
    const existing = await prisma.user.findUnique({ where: { email: adminEmail }, select: { id: true } });
    if (existing) {
      adminId = existing.id;
      console.log(`[bootstrap] admin ${adminEmail} already exists`);
    } else {
      const password = passwordSchema.parse(process.env.ADMIN_PASSWORD ?? "");
      const admin = await prisma.user.create({
        data: { email: adminEmail, name: process.env.ADMIN_NAME ?? "Administrator", role: "ADMIN", passwordHash: await hashPassword(password) },
        select: { id: true },
      });
      adminId = admin.id;
      console.log(`[bootstrap] created admin ${adminEmail}`);
    }
  }

  const demoUrl = process.env.DEMO_SHOP_URL?.replace(/\/+$/, "");
  if (demoUrl && adminId) {
    const exists = await prisma.application.findFirst({ where: { authorizedUrl: demoUrl }, select: { id: true } });
    if (exists) {
      console.log("[bootstrap] Demo Shop application already exists");
    } else {
      const project = await prisma.project.create({
        data: { name: "Demo", description: "Public Demo Shop for trying discovery, generation and test runs.", members: { create: { userId: adminId, role: "OWNER" } } },
        select: { id: true },
      });
      const app = await prisma.application.create({
        data: {
          projectId: project.id,
          name: "Demo Shop",
          authorizedUrl: demoUrl,
          environment: "STAGING",
          description: "Sample store with forms, navigation, a signed-in area and deliberate SSRF traps.",
          secrets: {
            create: [
              { name: "DEMO_EMAIL", provider: "ENV", reference: "env://QA_DEMO_EMAIL", description: "Demo Shop test account", createdById: adminId },
              { name: "DEMO_PASSWORD", provider: "ENV", reference: "env://QA_DEMO_PASSWORD", createdById: adminId },
            ],
          },
        },
        include: { secrets: true },
      });
      await prisma.discoveryAuthConfig.create({
        data: {
          applicationId: app.id,
          mode: "FORM_LOGIN",
          loginUrl: `${demoUrl}/login`,
          usernameSecretId: app.secrets.find((s) => s.name === "DEMO_EMAIL")!.id,
          passwordSecretId: app.secrets.find((s) => s.name === "DEMO_PASSWORD")!.id,
        },
      });
      console.log(`[bootstrap] created Demo project with Demo Shop at ${demoUrl}`);
    }
  }
}

main()
  .catch((error) => {
    console.error("[bootstrap] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
