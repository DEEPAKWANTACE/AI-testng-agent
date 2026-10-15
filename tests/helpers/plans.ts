import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { decideApproval } from "@/modules/approvals/service";
import type { Actor } from "@/modules/auth/service";
import type { ExecutableStep } from "@/modules/execution/steps";
import { submitForApproval } from "@/modules/test-suites/service";

export type CaseSpec = { title: string; steps: ExecutableStep[] | string[]; priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; feature?: string };

/** Creates a suite with accepted cases (executable steps, or descriptive strings). */
export async function createSuiteWithCases(applicationId: string, cases: CaseSpec[], name = "Suite") {
  const features = await db().feature.findMany({ where: { applicationId }, select: { id: true, name: true } });
  return db().testSuite.create({
    data: {
      applicationId,
      name,
      testCases: {
        create: cases.map((c, position) => ({
          title: c.title,
          expectedResult: `${c.title} works`,
          priority: c.priority ?? "MEDIUM",
          type: "FUNCTIONAL" as const,
          position,
          featureId: c.feature ? features.find((f) => f.name === c.feature)?.id ?? null : null,
          steps: {
            create: c.steps.map((s, i) =>
              typeof s === "string"
                ? { position: i, action: s }
                : { position: i, action: s.description, expectedResult: s.expected ?? null, kind: s.kind, params: s.params as Prisma.InputJsonValue },
            ),
          },
        })),
      },
    },
    select: { id: true },
  });
}

/** Submits as `submitter` and approves as `reviewer`; returns the approved version. */
export async function approve(suiteId: string, submitter: Actor, reviewer: Actor) {
  const version = await submitForApproval(submitter, suiteId);
  const approval = await db().approval.findFirstOrThrow({ where: { planVersionId: version.id } });
  await decideApproval(reviewer, approval.id, { decision: "APPROVED", comment: null, expectedHash: version.contentHash });
  return version;
}
