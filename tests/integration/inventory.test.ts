import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { Actor } from "@/modules/auth/service";
import { addInventoryDocument, mergeInventory, requestSourceAnalysis, syncDiscoveryInventory } from "@/modules/inventory/service";
import { cloneRepository } from "@/worker/analysis/repo";
import { processNextAnalysis } from "@/worker/analysis/worker";
import { createApplication, createProject, createUser, resetDatabase } from "../helpers/fixtures";

let editor: Actor, viewer: Actor;
let applicationId: string;
let repoDir: string;

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  paths: {
    "/api/cart": { get: { summary: "Get cart", responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", required: ["total"], properties: { total: { type: "number" } } } } } } } } },
    "/api/orders": { post: { summary: "Place order", responses: { 201: { description: "created" } } } },
  },
});

const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeAll(async () => {
  // A small repository: Next.js routes, an Express router, a role check, a symlink to a
  // sensitive file and a script that must never run.
  repoDir = await mkdtemp(path.join(tmpdir(), "qa-src-"));
  git("init", "-q", "-b", "main");
  await mkdir(path.join(repoDir, "src/app/cart"), { recursive: true });
  await mkdir(path.join(repoDir, "src/app/api/cart"), { recursive: true });
  await mkdir(path.join(repoDir, "server"), { recursive: true });
  await mkdir(path.join(repoDir, "node_modules/x"), { recursive: true });
  await writeFile(path.join(repoDir, "src/app/cart/page.tsx"), "export default function Cart() { return null; }");
  await writeFile(path.join(repoDir, "src/app/api/cart/route.ts"), "export async function GET() {}\nexport async function DELETE() {}");
  await writeFile(path.join(repoDir, "server/admin.js"), 'router.delete("/admin/products/:id", h);\nif (user.role === "admin") {}');
  await writeFile(path.join(repoDir, "node_modules/x/index.js"), 'app.get("/should-be-skipped", h);');
  await writeFile(path.join(repoDir, "postinstall.js"), `require("fs").writeFileSync(${JSON.stringify(path.join(repoDir, "..", "PWNED"))}, "x");`);
  await symlink("/etc/passwd", path.join(repoDir, "server/passwd.js"));
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  process.env.ANALYSIS_ALLOW_FILE_REPOS = "true";
});

afterAll(async () => {
  delete process.env.ANALYSIS_ALLOW_FILE_REPOS;
  await rm(repoDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase();
  [editor, viewer] = await Promise.all([createUser("QA_ENGINEER"), createUser("QA_ENGINEER")]);
  const project = await createProject([[editor, "EDITOR"], [viewer, "VIEWER"]]);
  ({ id: applicationId } = await createApplication(project.id));
});

const items = () => db().inventoryItem.findMany({ where: { applicationId }, orderBy: [{ kind: "asc" }, { key: "asc" }] });

describe("inventory documents", () => {
  it("analyses OpenAPI and requirements documents into one inventory, with audit", async () => {
    const api = await addInventoryDocument(editor, applicationId, { source: "OPENAPI", name: "openapi.json", content: SPEC });
    expect(api).toMatchObject({ created: 2, updated: 0, total: 2 });
    await addInventoryDocument(editor, applicationId, { source: "REQUIREMENTS", name: "reqs.md", content: "Roles: customer, admin\nREQ-1: Customers can view their cart.\n  - Total is shown in USD" });
    const all = await items();
    expect(all.map((i) => `${i.kind} ${i.key}`)).toEqual(["API_ENDPOINT GET /api/cart", "API_ENDPOINT POST /api/orders", "ROLE admin", "ROLE customer", "REQUIREMENT REQ-1"]);
    expect(all.find((i) => i.key === "GET /api/cart")!.sources).toEqual([expect.objectContaining({ source: "OPENAPI", origin: "OPENAPI:openapi.json", ref: "openapi.json#/paths/~1api~1cart/get" })]);
    expect(await db().inventoryDocument.count()).toBe(2);
    expect(await db().auditLog.count({ where: { action: "inventory.updated" } })).toBe(2);
  });

  it("replaces a document's contribution when re-uploaded under the same name", async () => {
    await addInventoryDocument(editor, applicationId, { source: "OPENAPI", name: "openapi.json", content: SPEC });
    const reduced = JSON.parse(SPEC);
    delete reduced.paths["/api/orders"];
    const result = await addInventoryDocument(editor, applicationId, { source: "OPENAPI", name: "openapi.json", content: JSON.stringify(reduced) });
    expect(result).toMatchObject({ updated: 1, deactivated: 1 });
    expect((await items()).map((i) => [i.key, i.active])).toEqual([["GET /api/cart", true], ["POST /api/orders", false]]);
  });

  it("requires edit permission and rejects documents that can't be analysed", async () => {
    await expect(addInventoryDocument(viewer, applicationId, { source: "OPENAPI", name: "x", content: SPEC })).rejects.toThrow();
    await expect(addInventoryDocument(editor, applicationId, { source: "OPENAPI", name: "x", content: "title: nope" })).rejects.toThrow(/Not an OpenAPI/);
    await expect(addInventoryDocument(editor, applicationId, { source: "REQUIREMENTS", name: "x", content: "just some prose" })).rejects.toThrow(/No requirements/);
    expect(await db().inventoryItem.count()).toBe(0);
  });
});

describe("merging sources", () => {
  it("keeps one item per route across sources, and keeps it active while any source lists it", async () => {
    await mergeInventory(applicationId, "SOURCE_CODE", "SOURCE_CODE", [{ kind: "ROUTE", key: "/cart", title: "/cart", ref: "src/app/cart/page.tsx:1", confidence: "MEDIUM", protected: true }]);
    await mergeInventory(applicationId, "DISCOVERY", "DISCOVERY", [{ kind: "ROUTE", key: "/cart", title: "Cart (/cart)", ref: "https://app.test.local/cart", confidence: "HIGH" }]);
    let [cart] = await items();
    expect(cart).toMatchObject({ title: "Cart (/cart)", confidence: "HIGH", protected: true, active: true });
    expect((cart.sources as Array<{ source: string }>).map((s) => s.source)).toEqual(["SOURCE_CODE", "DISCOVERY"]);

    await mergeInventory(applicationId, "DISCOVERY", "DISCOVERY", []);
    [cart] = await items();
    expect(cart).toMatchObject({ active: true });
    expect((cart.sources as Array<{ source: string }>).map((s) => s.source)).toEqual(["SOURCE_CODE"]);
    await mergeInventory(applicationId, "SOURCE_CODE", "SOURCE_CODE", []);
    expect((await items())[0].active).toBe(false);
  });

  it("feeds the latest completed discovery run into the inventory", async () => {
    const run = await db().discoveryRun.create({ data: { applicationId, startUrl: "https://app.test.local/", status: "COMPLETED", finishedAt: new Date() } });
    await db().discoveredPage.createMany({
      data: [
        { runId: run.id, url: "https://app.test.local/products/1", title: "Shoes", depth: 1, statusCode: 200, elements: {} },
        { runId: run.id, url: "https://app.test.local/missing", title: "404", depth: 1, statusCode: 404, elements: {} },
        { runId: run.id, url: "https://app.test.local/", title: "Home", depth: 0, statusCode: 200, elements: {} },
      ],
    });
    expect(await syncDiscoveryInventory(applicationId)).toMatchObject({ created: 2 });
    expect((await items()).map((i) => i.key)).toEqual(["/", "/products/1"]);
  });
});

describe("source analysis", () => {
  const setRepo = (repoUrl: string | null) => db().application.update({ where: { id: applicationId }, data: { repoUrl } });

  it("validates requests before queueing", async () => {
    await expect(requestSourceAnalysis(editor, applicationId, { tokenSecret: null })).rejects.toThrow(/repository URL first/);
    await setRepo("git@github.com:acme/shop.git");
    await expect(requestSourceAnalysis(editor, applicationId, { tokenSecret: null })).rejects.toThrow(/Only https/);
    await setRepo("https://github.com/acme/shop.git");
    await expect(requestSourceAnalysis(editor, applicationId, { tokenSecret: "GIT_TOKEN" })).rejects.toThrow(/no secret named GIT_TOKEN/);
    await expect(requestSourceAnalysis(viewer, applicationId, { tokenSecret: null })).rejects.toThrow();
    await requestSourceAnalysis(editor, applicationId, { tokenSecret: null });
    await expect(requestSourceAnalysis(editor, applicationId, { tokenSecret: null })).rejects.toThrow(/already in progress/);
  });

  it("clones, reads and merges a repository without executing or following anything", async () => {
    await db().sourceAnalysis.create({ data: { applicationId, repoUrl: `file://${repoDir}`, repoBranch: "main" } });
    expect(await processNextAnalysis("test-worker")).not.toBeNull();
    const analysis = await db().sourceAnalysis.findFirstOrThrow();
    expect(analysis.errorMessage).toBeNull();
    expect(analysis).toMatchObject({ status: "SUCCEEDED", commitSha: git("rev-parse", "HEAD").toString().trim() });
    // page, route, admin.js, postinstall.js and the symlink, checked out as a plain file holding
    // only its target path (core.symlinks=false); node_modules skipped.
    expect((analysis.stats as { files: number }).files).toBe(5);

    expect((await items()).map((i) => `${i.kind} ${i.key}`)).toEqual(["ROUTE /cart", "API_ENDPOINT DELETE /admin/products/:id", "API_ENDPOINT DELETE /api/cart", "API_ENDPOINT GET /api/cart", "ROLE admin"]);
    expect(JSON.stringify(await items())).not.toContain("root:");
    expect(JSON.stringify(await items())).not.toContain("should-be-skipped");
    await expect(import("node:fs/promises").then((fs) => fs.access(path.join(repoDir, "..", "PWNED")))).rejects.toThrow();
    expect(await processNextAnalysis("test-worker")).toBeNull(); // nothing left to claim
  });

  it("refuses private hosts, unsafe branches and credentials in URLs, and records failures", async () => {
    await expect(cloneRepository("https://127.0.0.1/repo.git", null, null)).rejects.toThrow(/blocked/);
    await expect(cloneRepository("https://user:pw@github.com/a/b.git", null, null)).rejects.toThrow(/credentials/);
    await expect(cloneRepository(`file://${repoDir}`, "--upload-pack=touch /tmp/x", null)).rejects.toThrow(/Invalid branch/);
    await expect(cloneRepository("http://github.com/a/b.git", null, null)).rejects.toThrow(/Only https/);
    await db().sourceAnalysis.create({ data: { applicationId, repoUrl: `file://${repoDir}`, repoBranch: "no-such-branch" } });
    await processNextAnalysis("test-worker");
    const failed = await db().sourceAnalysis.findFirstOrThrow();
    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toMatch(/git failed/);
  });

  it("refuses file:// repositories in production", async () => {
    const env = process.env as Record<string, string>;
    const previous = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      await expect(cloneRepository(`file://${repoDir}`, null, null)).rejects.toThrow(/Only https/);
    } finally {
      env.NODE_ENV = previous;
    }
  });
});
