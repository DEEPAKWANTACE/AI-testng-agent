import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_CREDENTIALS, startCanary, startDemoApp, type DemoApp } from "../../demo/target-app";
import { GET as getArtifact } from "@/app/api/artifacts/[artifactId]/route";
import { db } from "@/lib/db";
import { createApplication as createApplicationAction, removeSecretReference } from "@/modules/applications/actions";
import { artifactPath } from "@/modules/artifacts/storage";
import type { Actor } from "@/modules/auth/service";
import { cancelDiscoveryRun, createDiscoveryRun, deleteDiscoveryRun, updateDiscoveryAuth } from "@/modules/discovery/actions";
import { pageElementsSchema } from "@/modules/discovery/page-elements";
import { claimNextRun, processNextRun, processRun, recoverStaleRuns, workerConfigFromEnv, type WorkerConfig } from "@/worker/discovery/worker";
import { createProject, createUser, resetDatabase, signInAs, submit } from "../helpers/fixtures";

let demo: DemoApp;
let canary: Awaited<ReturnType<typeof startCanary>>;
let storageDir: string;
let engineer: Actor, outsider: Actor;
let projectId: string;

const config = (overrides: Partial<WorkerConfig> = {}) =>
  workerConfigFromEnv({ pageTimeoutMs: 2_500, runTimeoutMs: 60_000, perPageBudgetMs: 0, allowExternalAssets: false, ...overrides });

const path_ = (url: string) => new URL(url).pathname + new URL(url).search;

async function createDemoApplication(withLogin: boolean, authorizedUrl = demo.url) {
  const app = await db().application.create({
    data: {
      projectId,
      name: `Demo ${Math.random().toString(36).slice(2, 7)}`,
      authorizedUrl,
      environment: "STAGING",
      secrets: {
        create: [
          { name: "DEMO_EMAIL", provider: "ENV", reference: "env://QA_DEMO_EMAIL" },
          { name: "DEMO_PASSWORD", provider: "ENV", reference: "env://QA_DEMO_PASSWORD" },
        ],
      },
    },
    include: { secrets: true },
  });
  if (withLogin) {
    await db().discoveryAuthConfig.create({
      data: {
        applicationId: app.id,
        mode: "FORM_LOGIN",
        loginUrl: `${authorizedUrl}/login`,
        usernameSecretId: app.secrets.find((s) => s.name === "DEMO_EMAIL")!.id,
        passwordSecretId: app.secrets.find((s) => s.name === "DEMO_PASSWORD")!.id,
      },
    });
  }
  return app;
}

async function queueRun(applicationId: string, startUrl = demo.url, limits: { maxDepth?: number; maxPages?: number } = {}) {
  return db().discoveryRun.create({ data: { applicationId, startUrl, maxDepth: limits.maxDepth ?? 3, maxPages: limits.maxPages ?? 40, triggeredById: engineer.id } });
}

async function loadRun(id: string) {
  return db().discoveryRun.findUniqueOrThrow({
    where: { id },
    include: { pages: { include: { artifacts: true, feature: true } }, features: true, artifacts: true },
  });
}

beforeAll(async () => {
  canary = await startCanary();
  demo = await startDemoApp({ canaryPort: canary.port });
  storageDir = await mkdtemp(path.join(tmpdir(), "qa-artifacts-"));
  process.env.ARTIFACT_STORAGE_DIR = storageDir;
  process.env.DISCOVERY_PRIVATE_ALLOWLIST = `127.0.0.1:${demo.port}`;
  process.env.QA_DEMO_EMAIL = DEMO_CREDENTIALS.email;
  process.env.QA_DEMO_PASSWORD = DEMO_CREDENTIALS.password;
});

afterAll(async () => {
  await demo.close();
  await canary.close();
  await rm(storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase();
  demo.hits.clear();
  canary.requests.length = 0;
  [engineer, outsider] = await Promise.all([createUser("QA_ENGINEER"), createUser("QA_ENGINEER")]);
  ({ id: projectId } = await createProject([[engineer, "EDITOR"]]));
});

describe("authenticated crawl of the demo app", () => {
  it("discovers pages, elements, features and evidence — and never leaves the authorized URL", async () => {
    const app = await createDemoApplication(true);
    const { id } = await queueRun(app.id);
    expect(await processNextRun(config())).toBe(id);
    const run = await loadRun(id);

    // Outcome (timestamps are consistent regardless of the database session's time zone)
    expect(run.status).toBe("COMPLETED");
    expect(run.finishedAt!.getTime()).toBeGreaterThanOrEqual(run.startedAt!.getTime());
    expect(Math.abs(run.startedAt!.getTime() - run.createdAt.getTime())).toBeLessThan(60_000);
    expect(run.summary).toMatch(/Crawl completed: \d+ pages visited \(1 failed\) · \d+ features found · signed in/);
    const stats = run.stats as Record<string, unknown> & { authenticated: boolean; stoppedBy: string };
    expect(stats).toMatchObject({ authenticated: true, stoppedBy: "completed" });

    // Pages: public, authenticated and up to maxDepth (3)
    const paths = run.pages.map((p) => path_(p.url));
    for (const expected of ["/", "/products", "/products/1", "/products?sort=price", "/cart", "/checkout", "/checkout/help", "/account", "/account/orders", "/about/team/history"]) {
      expect(paths).toContain(expected);
    }
    expect(paths).not.toContain("/about/team/history/archive"); // depth 4
    // Only the deliberately slow page fails; blocked redirects don't disturb later pages.
    expect(run.pages.filter((p) => p.error).map((p) => [path_(p.url), p.error])).toEqual([["/slow", "Timed out"]]);

    // Elements
    const elementsOf = (p: string) => pageElementsSchema.parse(run.pages.find((page) => path_(page.url) === p)!.elements);
    const checkout = elementsOf("/checkout").forms.find((f) => f.name === "Checkout")!;
    expect(checkout).toMatchObject({ method: "POST", submitLabels: ["Place order"] });
    expect(checkout.fields.map((f) => [f.label, f.type, f.required])).toEqual([
      ["Email", "email", true],
      ["Address", "textarea", true],
      ["Card number", "text", true],
    ]);
    const home = elementsOf("/");
    expect(home.navigation.find((n) => n.label === "Main")?.links.map((l) => l.text)).toEqual(["Home", "Products", "Cart", "My account", "About us"]);
    expect(home.forms.find((f) => f.method === "GET")?.fields[0]).toMatchObject({ name: "q", label: "Search products" });
    expect(elementsOf("/products").inputs).toEqual([expect.objectContaining({ tag: "select", name: "sort", label: "Sort by" })]);
    expect(elementsOf("/cart").buttons.map((b) => b.text)).toContain("Empty cart");

    // Input values (pre-filled profile fields, the password) are never stored
    const allElements = JSON.stringify(run.pages.map((p) => p.elements)) + JSON.stringify(run.stats);
    for (const secret of ["Sam Shopper", "+1 555 0100", DEMO_CREDENTIALS.password]) expect(allElements).not.toContain(secret);

    // Features, linked to their pages
    const names = run.features.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Home", "Products", "Cart", "My account", "About us", "Checkout", "Help"]));
    expect(run.features.every((f) => f.source === "DISCOVERED" && f.applicationId === app.id)).toBe(true);
    expect(run.pages.find((p) => path_(p.url) === "/products/2")?.feature?.name).toBe("Products");

    // Evidence: a PNG per successful page plus a crawl log
    const okPages = run.pages.filter((p) => !p.error);
    expect(okPages.every((p) => p.artifacts.length === 1 && p.artifacts[0].kind === "SCREENSHOT")).toBe(true);
    const png = await readFile(artifactPath(okPages[0].artifacts[0].storageKey));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect((await stat(artifactPath(okPages[0].artifacts[0].storageKey))).size).toBe(okPages[0].artifacts[0].sizeBytes);
    const log = JSON.parse(await readFile(artifactPath(run.artifacts.find((a) => a.kind === "LOG")!.storageKey), "utf8"));
    expect(log.pagesVisited).toBe(run.pages.length);

    // Security: nothing outside the authorized URL was contacted
    expect(canary.requests).toEqual([]);
    expect(demo.hits.get("/logout") ?? 0).toBe(0);
    expect(demo.hits.get("/admin/delete-everything") ?? 0).toBe(0);
    expect(demo.hits.get("/files/terms.pdf") ?? 0).toBe(0);
    const blocked = JSON.stringify(stats);
    expect(blocked).toContain(`127.0.0.1:${canary.port}/stolen`); // unsafe redirect not followed
    expect(blocked).toContain("169.254.169.254"); // metadata redirect + fetch blocked
    expect(blocked).toContain(`127.0.0.1:${canary.port}/pixel.png`); // subresource blocked
    expect(blocked).toContain(`localhost:${canary.port}/pixel-by-name.png`);
    expect(blocked).toContain(`127.0.0.1:${canary.port}/xhr`); // fetch() from page JS blocked
    expect(blocked).toContain("example.org:443"); // third-party assets blocked in strict mode
  }, 120_000);
});

describe("authentication", () => {
  it("crawls only public pages without a login configuration", async () => {
    const app = await createDemoApplication(false);
    const { id } = await queueRun(app.id, demo.url, { maxDepth: 2 });
    await processNextRun(config());
    const run = await loadRun(id);
    const paths = run.pages.map((p) => path_(p.url));
    expect(run.status).toBe("COMPLETED");
    expect(paths).toContain("/login?next=%2Faccount"); // /account redirects to sign-in
    expect(paths).not.toContain("/account/orders");
    expect((run.stats as { authenticated: boolean }).authenticated).toBe(false);
  }, 120_000);

  it("fails clearly on wrong credentials without exposing them", async () => {
    process.env.QA_DEMO_PASSWORD = "definitely-wrong";
    try {
      const app = await createDemoApplication(true);
      const { id } = await queueRun(app.id);
      await processNextRun(config());
      const run = await loadRun(id);
      expect(run).toMatchObject({ status: "FAILED", pagesVisited: 0 });
      expect(run.errorMessage).toContain("Login failed");
      expect(run.errorMessage).not.toContain("definitely-wrong");
    } finally {
      process.env.QA_DEMO_PASSWORD = DEMO_CREDENTIALS.password;
    }
  }, 60_000);

  it("fails when a credential secret can't be resolved", async () => {
    delete process.env.QA_DEMO_EMAIL;
    try {
      const app = await createDemoApplication(true);
      const { id } = await queueRun(app.id);
      await processNextRun(config());
      expect((await loadRun(id)).errorMessage).toBe("Couldn't resolve secret DEMO_EMAIL: Secret env://QA_DEMO_EMAIL is not set in the server environment");
    } finally {
      process.env.QA_DEMO_EMAIL = DEMO_CREDENTIALS.email;
    }
  }, 30_000);
});

describe("limits and timeouts", () => {
  it("stops at maxPages", async () => {
    const app = await createDemoApplication(false);
    const { id } = await queueRun(app.id, demo.url, { maxPages: 3 });
    await processNextRun(config());
    const run = await loadRun(id);
    expect(run.pages).toHaveLength(3);
    expect((run.stats as { stoppedBy: string }).stoppedBy).toBe("max-pages");
    expect(run.summary).toContain("Stopped at the page limit");
  }, 60_000);

  it("respects maxDepth", async () => {
    const app = await createDemoApplication(false);
    const { id } = await queueRun(app.id, demo.url, { maxDepth: 1 });
    await processNextRun(config());
    const run = await loadRun(id);
    expect(Math.max(...run.pages.map((p) => p.depth))).toBe(1);
    expect(run.pages.map((p) => path_(p.url))).not.toContain("/products/1");
  }, 60_000);

  it("ends at the run time limit and keeps partial results", async () => {
    const app = await createDemoApplication(false);
    const { id } = await queueRun(app.id, `${demo.url}/slow`);
    await processNextRun(config({ pageTimeoutMs: 10_000, runTimeoutMs: 5_000 }));
    const run = await loadRun(id);
    expect(run.status).toBe("COMPLETED");
    expect((run.stats as { stoppedBy: string }).stoppedBy).toBe("time-limit");
    const elapsed = run.finishedAt!.getTime() - run.startedAt!.getTime();
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
    expect(elapsed).toBeLessThan(9_000);
  }, 30_000);
});

describe("path-scoped authorization", () => {
  it("doesn't follow same-host redirects outside the authorized path", async () => {
    const scoped = `${demo.url}/products`;
    const app = await createDemoApplication(false, scoped);
    const { id } = await queueRun(app.id, scoped);
    await processNextRun(config());
    const run = await loadRun(id);
    expect(run.status).toBe("COMPLETED");
    expect(run.pages.every((p) => new URL(p.url).pathname.startsWith("/products"))).toBe(true);
    expect((run.stats as { redirectsBlocked: Array<{ to: string }> }).redirectsBlocked.map((r) => path_(r.to))).toContain("/cart");
    expect(demo.hits.get("/cart") ?? 0).toBe(0); // never requested
    expect(demo.hits.get("/") ?? 0).toBe(0);
  }, 60_000);
});

describe("blocked targets", () => {
  it.each([
    ["a local port that isn't allowlisted", () => `http://127.0.0.1:${canary.port}`, "Target blocked"],
    ["the cloud metadata endpoint", () => "http://169.254.169.254", "Target blocked"],
    ["a hostname resolving to loopback", () => `http://localhost:${demo.port}`, "Target blocked"],
  ])("refuses %s before launching a browser", async (_label, url, message) => {
    const app = await createDemoApplication(false, url());
    const { id } = await queueRun(app.id, url());
    await processNextRun(config());
    const run = await loadRun(id);
    expect(run.status).toBe("FAILED");
    expect(run.errorMessage).toContain(message);
    expect(canary.requests).toEqual([]);
  }, 30_000);
});

describe("worker lifecycle", () => {
  it("lets exactly one of several concurrent workers claim a run", async () => {
    const app = await createDemoApplication(false);
    const { id } = await queueRun(app.id);
    const claims = await Promise.all(Array.from({ length: 5 }, (_, i) => claimNextRun(`worker-${i}`)));
    expect(claims.filter(Boolean)).toEqual([id]);
    const claimed = await db().discoveryRun.findUniqueOrThrow({ where: { id } });
    expect(claimed).toMatchObject({ status: "RUNNING" });
    // Heartbeats are stored in UTC, so a freshly claimed run is never considered stale.
    expect(Math.abs(claimed.heartbeatAt!.getTime() - Date.now())).toBeLessThan(60_000);
    expect(await recoverStaleRuns(config())).toBe(0);
  });

  it("honours cancellation from the UI", async () => {
    const app = await createDemoApplication(false);
    const { id } = await queueRun(app.id);
    const cfg = config();
    await claimNextRun(cfg.workerId);
    await db().discoveryRun.update({ where: { id }, data: { status: "CANCELLED" } });
    await processRun(id, cfg);
    const run = await loadRun(id);
    expect(run.status).toBe("CANCELLED");
    expect(run.pages).toHaveLength(0);
    expect(run.finishedAt).not.toBeNull();
  }, 30_000);

  it("fails runs abandoned by a crashed worker", async () => {
    const app = await createDemoApplication(false);
    const { id } = await queueRun(app.id);
    await db().discoveryRun.update({ where: { id }, data: { status: "RUNNING", heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await recoverStaleRuns(config())).toBe(1);
    expect(await db().discoveryRun.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED" });
  });

  it("returns null when the queue is empty", async () => {
    expect(await processNextRun(config())).toBeNull();
  });
});

describe("web app integration", () => {
  it("validates, queues, cancels and deletes runs through Server Actions", async () => {
    const app = await createDemoApplication(false);
    await signInAs(engineer);

    const outside = await submit(createDiscoveryRun, { applicationId: app.id, startUrl: `http://127.0.0.1:${canary.port}/`, maxDepth: "2", maxPages: "10" });
    expect(outside.message).toContain("Start URL must be within the application's authorized URL");
    expect((await submit(createDiscoveryRun, { applicationId: app.id, startUrl: demo.url, maxDepth: "11", maxPages: "1001" })).fieldErrors).toMatchObject({
      maxDepth: expect.any(Array),
      maxPages: expect.any(Array),
    });

    expect((await submit(createDiscoveryRun, { applicationId: app.id, startUrl: `${demo.url}/products`, maxDepth: "1", maxPages: "2" })).status).toBe("success");
    const queued = await db().discoveryRun.findFirstOrThrow({ where: { applicationId: app.id } });
    expect(queued).toMatchObject({ status: "QUEUED", maxDepth: 1, maxPages: 2, triggeredById: engineer.id });

    expect((await submit(cancelDiscoveryRun.bind(null, queued.id))).status).toBe("success");
    expect(await processNextRun(config())).toBeNull(); // cancelled runs aren't claimed

    await signInAs(outsider);
    expect((await submit(deleteDiscoveryRun.bind(null, queued.id))).message).toBe("Discovery run not found.");
  });

  it("deletes a run's evidence files with the run", async () => {
    const app = await createDemoApplication(false);
    const { id } = await queueRun(app.id, demo.url, { maxPages: 2 });
    await processNextRun(config());
    const runDir = path.join(storageDir, "discovery", id);
    expect((await stat(runDir)).isDirectory()).toBe(true);

    await signInAs(engineer);
    expect((await submit(deleteDiscoveryRun.bind(null, id))).status).toBe("success");
    await expect(stat(runDir)).rejects.toThrow();
    expect(await db().artifact.count()).toBe(0);
  }, 60_000);

  it("serves screenshots only to people who can view the project", async () => {
    const app = await createDemoApplication(false);
    const { id } = await queueRun(app.id, demo.url, { maxPages: 1 });
    await processNextRun(config());
    const artifact = await db().artifact.findFirstOrThrow({ where: { kind: "SCREENSHOT", discoveredPage: { runId: id } } });
    const get = () => getArtifact(new Request("http://app.test/"), { params: Promise.resolve({ artifactId: artifact.id }) });

    const { cookieJar } = await import("../helpers/next-mocks");
    cookieJar.clear();
    expect((await get()).status).toBe(401);

    await signInAs(outsider);
    expect((await get()).status).toBe(404);

    await signInAs(engineer);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString("hex")).toBe("89504e47");
  }, 60_000);

  it("refuses applications pointing at private targets unless allowlisted", async () => {
    await signInAs(engineer);
    const base = { projectId, environment: "STAGING", type: "WEB" };
    expect((await submit(createApplicationAction, { ...base, name: "Meta", authorizedUrl: "http://169.254.169.254" })).message).toContain(
      "cloud metadata endpoint",
    );
    expect((await submit(createApplicationAction, { ...base, name: "Local", authorizedUrl: `http://localhost:${demo.port}` })).message).toContain(
      "local-only hostname",
    );
    expect((await submit(createApplicationAction, { ...base, name: "Allowlisted", authorizedUrl: demo.url })).redirect).toBeDefined();
  });

  it("validates discovery login settings and protects secrets in use", async () => {
    const app = await createDemoApplication(false);
    const other = await createDemoApplication(false);
    const [email, password] = app.secrets;
    await signInAs(engineer);
    const save = (values: Record<string, string>) => submit(updateDiscoveryAuth.bind(null, app.id), { mode: "FORM_LOGIN", ...values });

    expect((await save({ loginUrl: `http://127.0.0.1:${canary.port}/login`, usernameSecretId: email.id, passwordSecretId: password.id })).message).toContain(
      "login URL must be within the authorized URL",
    );
    expect((await save({ loginUrl: `${demo.url}/login`, usernameSecretId: other.secrets[0].id, passwordSecretId: password.id })).message).toBe(
      "Choose secret references that belong to this application.",
    );
    expect((await save({ loginUrl: `${demo.url}/login`, usernameSecretId: email.id, passwordSecretId: password.id, submitSelector: "xpath=//button" })).fieldErrors).toHaveProperty(
      "submitSelector",
    );
    expect((await save({ loginUrl: `${demo.url}/login`, usernameSecretId: email.id, passwordSecretId: password.id })).status).toBe("success");

    expect((await submit(removeSecretReference.bind(null, password.id))).message).toBe(
      "This secret is used by discovery login. Change the login settings first.",
    );
    // Deleting the whole application still cascades cleanly (NO ACTION is checked after the cascade).
    await db().application.delete({ where: { id: app.id } });
    expect(await db().discoveryAuthConfig.count({ where: { applicationId: app.id } })).toBe(0);
  });
});
