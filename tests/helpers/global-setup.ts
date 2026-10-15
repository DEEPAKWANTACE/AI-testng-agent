import { execFileSync } from "node:child_process";

/** Applies migrations to the test database once per run. Refuses anything not named *_test. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example).");
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run integration tests against "${name}": the database name must end in _test.`);
  }
  const redisUrl = new URL(process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15");
  if (redisUrl.pathname !== "/15") throw new Error("Integration tests must use Redis database 15 (TEST_REDIS_URL=redis://host:6379/15).");
  try {
    execFileSync("node", ["-e", `const R=require("ioredis");const r=new R(${JSON.stringify(redisUrl.toString())},{lazyConnect:true,maxRetriesPerRequest:1,retryStrategy:()=>null});r.connect().then(()=>r.flushdb()).then(()=>r.quit()).catch(e=>{console.error(e.message);process.exit(1)})`], { stdio: "pipe" });
  } catch {
    throw new Error(`Redis is not reachable at ${redisUrl.host}. Start it with: docker compose up -d redis`);
  }
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
