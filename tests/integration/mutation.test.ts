import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_OPENAPI, startCanary, startDemoApp, type DemoApp } from "../../demo/target-app";
import { db } from "@/lib/db";
import type { Actor } from "@/modules/auth/service";
import type { ExecutableStep } from "@/modules/execution/steps";
import { requestMutationRun } from "@/modules/mutation/service";
import { processNextMutationRun, type MutantResult } from "@/worker/mutation/worker";
import { createProject, createUser, resetDatabase } from "../helpers/fixtures";
import { approve, createSuiteWithCases } from "../helpers/plans";

let demo: DemoApp;
let canary: Awaited<ReturnType<typeof startCanary>>;
let storageDir: string;
let engineer: Actor, lead: Actor, viewer: Actor;
let applicationId: string;

const NAV = (url: string): ExecutableStep => ({ kind: "NAVIGATE", description: `Open ${url}`, params: { url } });
const overrides = { stepTimeoutMs: 1_500, heartbeatMs: 500, reproduceAttempts: 1 };

beforeAll(async () => {
  canary = await startCanary();
  demo = await startDemoApp({ canaryPort: canary.port });
  storageDir = await mkdtemp(path.join(tmpdir(), "qa-mutation-"));
  process.env.ARTIFACT_STORAGE_DIR = storageDir;
  process.env.DISCOVERY_PRIVATE_ALLOWLIST = `127.0.0.1:${demo.port}`;
});

afterAll(async () => {
  await demo.close();
  await canary.close();
  await rm(storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase();
  demo.setBroken(false);
  demo.clearFaults();
  [engineer, lead, viewer] = await Promise.all([createUser("QA_ENGINEER"), createUser("QA_LEAD"), createUser("QA_ENGINEER")]);
  const project = await createProject([[engineer, "EDITOR"], [lead, "EDITOR"], [viewer, "VIEWER"]]);
  ({ id: applicationId } = await db().application.create({ data: { projectId: project.id, name: "Demo Shop", authorizedUrl: demo.url, environment: "STAGING" } }));
});

async function approvedVersion() {
  const cartContract = DEMO_OPENAPI.components.schemas.Cart;
  const suite = await createSuiteWithCases(applicationId, [
    { title: "Products page shows its heading", steps: [NAV("/products"), { kind: "ASSERT", description: "Heading", params: { check: "visible", target: { by: "role", role: "heading", name: "Products" } } }] },
    {
      title: "Cart API follows its contract",
      steps: [NAV("/"), { kind: "API_GET", description: "Cart", params: { url: "/api/cart", saveAs: "cart" } }, { kind: "ASSERT_RESPONSE", description: "Contract", params: { response: "cart", status: 200, contract: cartContract as never } }],
    },
  ]);
  return approve(suite.id, engineer, lead);
}

describe("mutation analysis", () => {
  it("runs a verified baseline, then reports which deliberate changes the plan detects", async () => {
    const version = await approvedVersion();
    await expect(requestMutationRun(viewer, version.id, { mutantLimit: 30 })).rejects.toThrow();
    const { id } = await requestMutationRun(engineer, version.id, { mutantLimit: 30 });
    await expect(requestMutationRun(engineer, version.id, { mutantLimit: 30 })).rejects.toThrow(/already in progress/);

    expect(await processNextMutationRun("mutation-worker", overrides)).toBe(id);
    const run = await db().mutationRun.findUniqueOrThrow({ where: { id } });
    expect(run.errorMessage ?? run.blockedReason).toBeNull();
    expect(run.status).toBe("SUCCEEDED");
    const mutants = run.mutants as MutantResult[];
    const outcome = (idPart: string) => mutants.find((m) => m.id === idPart)?.outcome;

    // Detected by the heading assertion and the cart contract:
    expect(outcome("HEADING_REMOVED:document:GET /products:0")).toBe("KILLED");
    expect(outcome("SERVER_ERROR:api:GET /api/cart:")).toBe("KILLED");
    expect(outcome("FIELD_REMOVED:api:GET /api/cart:/items")).toBe("KILLED");
    // Not detected: nothing in the plan checks displayed prices (a real gap, reported as such).
    expect(outcome("TEXT_NUMBER_CHANGED:document:GET /products:0")).toBe("SURVIVED");
    expect(mutants.find((m) => m.outcome === "KILLED" && m.id.startsWith("HEADING"))!.killedBy).toBe("Products page shows its heading");

    expect(run.killed + run.survived + run.unclear).toBe(mutants.filter((m) => m.outcome !== "NOT_RUN").length);
    expect(run.score).toBeCloseTo(run.killed / (run.killed + run.survived + run.unclear), 3);
    expect(run.score!).toBeGreaterThan(0);
    expect(run.score!).toBeLessThan(1);

    // The baseline is an ordinary verified run; mutant executions leave no runs or defects behind.
    const runs = await db().testRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: run.baselineRunId, trigger: "MUTATION", status: "PASSED" });
    expect(await db().defect.count()).toBe(0);
    expect(await db().auditLog.count({ where: { action: { in: ["mutation.requested", "mutation.finished"] } } })).toBe(2);
    expect(canary.requests).toEqual([]);
  });

  it("refuses to score a plan that doesn't pass on the unmodified application", async () => {
    const version = await approvedVersion();
    demo.setBroken(true);
    const { id } = await requestMutationRun(engineer, version.id, { mutantLimit: 5 });
    await processNextMutationRun("mutation-worker", overrides);
    const run = await db().mutationRun.findUniqueOrThrow({ where: { id } });
    expect(run).toMatchObject({ status: "BLOCKED", score: null, mutants: null });
    expect(run.blockedReason).toMatch(/must pass on the unmodified application before mutation testing; the baseline run was failed/);
  });

  it("only accepts approved versions", async () => {
    const suite = await createSuiteWithCases(applicationId, [{ title: "x", steps: [NAV("/")] }]);
    const { submitForApproval } = await import("@/modules/test-suites/service");
    const pending = await submitForApproval(engineer, suite.id);
    await expect(requestMutationRun(engineer, pending.id, { mutantLimit: 5 })).rejects.toThrow(/Only approved/);
  });
});
