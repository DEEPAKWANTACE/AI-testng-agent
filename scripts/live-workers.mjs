// Runs the workers on this machine against the live deployment's services, using the
// settings in .env.deploy (git-ignored):  npm run workers:live
//
// - DATABASE_URL is the Supabase *session* pooler (DIRECT_DATABASE_URL), suited to
//   long-running processes;
// - NODE_ENV=production, so the private-network allowlist is ignored (only public targets);
// - the job worker (generation + test runs) needs REDIS_URL; without it only discovery runs.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";

const deploy = parse(readFileSync(new URL("../.env.deploy", import.meta.url)));
const required = ["DIRECT_DATABASE_URL", "ARTIFACT_S3_BUCKET", "ARTIFACT_S3_ENDPOINT", "ARTIFACT_S3_ACCESS_KEY_ID", "ARTIFACT_S3_SECRET_ACCESS_KEY"];
const missing = required.filter((key) => !deploy[key]);
if (missing.length) {
  console.error(`[live-workers] .env.deploy is missing: ${missing.join(", ")}`);
  process.exit(1);
}

const env = {
  ...process.env,
  ...Object.fromEntries(Object.entries(deploy).filter(([key]) => !key.startsWith("ADMIN_") && key !== "SUPABASE_DB_PASSWORD")),
  DATABASE_URL: deploy.DIRECT_DATABASE_URL,
  NODE_ENV: "production",
  DISCOVERY_PRIVATE_ALLOWLIST: "",
};

const scripts = deploy.REDIS_URL ? ["worker:discovery", "worker:jobs"] : ["worker:discovery"];
if (!deploy.REDIS_URL) {
  console.warn("[live-workers] REDIS_URL is empty in .env.deploy: running discovery only. Add an Upstash rediss:// URL to enable generation and test runs.");
}

const children = scripts.map((script) => {
  const child = spawn("npm", ["run", script], { stdio: "inherit", env });
  child.on("exit", (code, signal) => {
    console.error(`[live-workers] ${script} exited (${signal ?? code}); stopping`);
    for (const other of children) if (other !== child && other.exitCode === null) other.kill("SIGTERM");
    process.exitCode = code || 1;
  });
  return child;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of children) if (child.exitCode === null) child.kill(signal);
  });
}
