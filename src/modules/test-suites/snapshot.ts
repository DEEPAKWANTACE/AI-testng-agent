import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { Priority, StepKind, TestCaseType } from "@/generated/prisma/enums";
import { stepParamsSchemas, type StepKindName } from "@/modules/execution/steps";

/**
 * Shape of `PlanVersion.snapshot`: the suite's accepted cases and steps frozen at submission.
 * Runs execute the snapshot, never the live (editable) suite. Postgres hashes the snapshot
 * (`PlanVersion.contentHash`), and approvals are bound to that hash.
 *
 * Format 2 adds executable steps; format 1 (legacy) had descriptive steps only.
 */

const legacyStep = z.object({ id: z.string(), position: z.number().int().nonnegative(), action: z.string(), expectedResult: z.string().nullable() });
export const legacySnapshotSchema = z.object({
  suite: z.object({ name: z.string(), description: z.string().nullable() }),
  cases: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      preconditions: z.string().nullable(),
      expectedResult: z.string().nullable(),
      priority: z.enum(Priority),
      type: z.enum(TestCaseType),
      steps: z.array(legacyStep),
    }),
  ),
});

export const snapshotStepSchema = z
  .object({
    position: z.number().int().nonnegative(),
    action: z.string(),
    expectedResult: z.string().nullable(),
    kind: z.enum(StepKind).nullable(),
    params: z.unknown().nullable(),
  })
  .superRefine((step, ctx) => {
    if (step.kind === null) {
      if (step.params !== null) ctx.addIssue({ code: "custom", message: "Descriptive steps have no parameters" });
      return;
    }
    const parsed = stepParamsSchemas[step.kind as StepKindName].safeParse(step.params);
    if (!parsed.success) ctx.addIssue({ code: "custom", message: `Invalid ${step.kind} step: ${parsed.error.issues[0]?.message}` });
  });

export const snapshotCaseSchema = z.object({
  caseKey: z.string().min(1),
  /** The live TestCase this was frozen from (it may later be edited or archived). */
  caseId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  prerequisites: z.array(z.string()),
  expectedResult: z.string().nullable(),
  priority: z.enum(Priority),
  type: z.enum(TestCaseType),
  featureName: z.string().nullable(),
  requirementRefs: z.array(z.string()),
  steps: z.array(snapshotStepSchema),
});

export const planSnapshotSchema = z.object({
  format: z.literal(2),
  suite: z.object({ name: z.string(), description: z.string().nullable(), kind: z.enum(["STANDARD", "REGRESSION"]) }),
  cases: z.array(snapshotCaseSchema),
});

export type PlanSnapshot = z.infer<typeof planSnapshotSchema>;
export type SnapshotCase = PlanSnapshot["cases"][number];

type SuiteForSnapshot = {
  name: string;
  description: string | null;
  kind: "STANDARD" | "REGRESSION";
  testCases: Array<{
    id: string;
    caseKey: string;
    title: string;
    description: string | null;
    prerequisites: string[];
    expectedResult: string | null;
    priority: Priority;
    type: TestCaseType;
    requirementRefs: string[];
    feature: { name: string } | null;
    steps: Array<{ position: number; action: string; expectedResult: string | null; kind: StepKind | null; params: Prisma.JsonValue | null }>;
  }>;
};

/** Builds and validates a snapshot; throws a ZodError naming the first invalid step. */
export function buildPlanSnapshot(suite: SuiteForSnapshot): PlanSnapshot {
  return planSnapshotSchema.parse({
    format: 2,
    suite: { name: suite.name, description: suite.description, kind: suite.kind },
    cases: suite.testCases.map((c) => ({
      caseKey: c.caseKey,
      caseId: c.id,
      title: c.title,
      description: c.description,
      prerequisites: c.prerequisites,
      expectedResult: c.expectedResult,
      priority: c.priority,
      type: c.type,
      featureName: c.feature?.name ?? null,
      requirementRefs: c.requirementRefs,
      steps: c.steps.map((s) => ({ position: s.position, action: s.action, expectedResult: s.expectedResult, kind: s.kind, params: s.params ?? null })),
    })),
  });
}

/** Parses a stored snapshot of either format. */
export function parsePlanSnapshot(format: number, value: unknown) {
  if (format === 2) return { format: 2 as const, snapshot: planSnapshotSchema.parse(value) };
  return { format: 1 as const, snapshot: legacySnapshotSchema.parse(value) };
}

type HashClient = { $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Prisma.PrismaPromise<T> };

/**
 * Hash of a snapshot as Postgres computes it for `PlanVersion.contentHash` (same function), so
 * a working copy can be compared with an approved version.
 */
export async function snapshotHash(client: HashClient, snapshot: PlanSnapshot): Promise<string> {
  const rows = await client.$queryRaw<{ hash: string }[]>`SELECT qa_snapshot_hash(${JSON.stringify(snapshot)}::jsonb) AS hash`;
  return rows[0].hash;
}

/** Cases added/removed/changed between two snapshots, matched by caseKey (for reviewers). */
export function diffSnapshots(previous: PlanSnapshot | null, next: PlanSnapshot) {
  const before = new Map((previous?.cases ?? []).map((c) => [c.caseKey, c]));
  const after = new Map(next.cases.map((c) => [c.caseKey, c]));
  const material = (c: SnapshotCase) => JSON.stringify({ ...c, caseId: undefined });
  return {
    added: next.cases.filter((c) => !before.has(c.caseKey)).map((c) => c.title),
    removed: (previous?.cases ?? []).filter((c) => !after.has(c.caseKey)).map((c) => c.title),
    changed: next.cases.filter((c) => before.has(c.caseKey) && material(before.get(c.caseKey)!) !== material(c)).map((c) => c.title),
  };
}
