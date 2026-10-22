import { db } from "@/lib/db";
import { requestGeneration } from "@/modules/generation/service";

const CHUNK = 12;
const MAX_FEATURES = 200;

/**
 * Called by the discovery worker when an auto-test crawl completes: queues generation for
 * every feature that crawl found, in batches. Returns the number of jobs queued. Failures are
 * returned, not thrown, so they never turn a completed crawl into a failed one.
 */
export async function queueAutoGeneration(runId: string): Promise<{ jobs: number; features: number; error?: string }> {
  const run = await db().discoveryRun.findUniqueOrThrow({
    where: { id: runId },
    select: { applicationId: true, triggeredBy: { select: { id: true, email: true, name: true, role: true, status: true } } },
  });
  const actor = run.triggeredBy;
  if (!actor || actor.status !== "ACTIVE") return { jobs: 0, features: 0, error: "The user who started this run is no longer active." };

  const features = await db().feature.findMany({
    where: { applicationId: run.applicationId, status: "ACTIVE", pages: { some: { runId } } },
    orderBy: { name: "asc" },
    take: MAX_FEATURES,
    select: { id: true },
  });
  let jobs = 0;
  try {
    for (let i = 0; i < features.length; i += CHUNK) {
      await requestGeneration(
        { id: actor.id, email: actor.email, name: actor.name, role: actor.role },
        {
          applicationId: run.applicationId,
          featureIds: features.slice(i, i + CHUNK).map((f) => f.id),
          requirements: null,
          suiteId: null,
        },
      );
      jobs++;
    }
  } catch (error) {
    return { jobs, features: features.length, error: error instanceof Error ? error.message : "Couldn't queue generation." };
  }
  return { jobs, features: features.length };
}
