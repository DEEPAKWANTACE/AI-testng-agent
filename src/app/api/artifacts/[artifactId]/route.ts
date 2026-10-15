import { db } from "@/lib/db";
import { idSchema } from "@/lib/validation";
import { can } from "@/modules/access/policy";
import { getProjectRole } from "@/modules/access/service";
import { readArtifact } from "@/modules/artifacts/storage";
import { getCurrentActor } from "@/modules/auth/session";

const app = { select: { projectId: true } } as const;
const viaRun = { select: { planVersion: { select: { suite: { select: { application: app } } } } } } as const;

/** Serves artifact bytes to signed-in users who can view the owning project. */
export async function GET(_request: Request, ctx: RouteContext<"/api/artifacts/[artifactId]">) {
  const actor = await getCurrentActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });

  const { artifactId } = await ctx.params;
  const id = idSchema.safeParse(artifactId);
  const notFound = () => new Response("Not found", { status: 404 });
  if (!id.success) return notFound();

  const artifact = await db().artifact.findUnique({
    where: { id: id.data },
    select: {
      storageKey: true,
      mimeType: true,
      name: true,
      discoveryRun: { select: { application: app } },
      discoveredPage: { select: { run: { select: { application: app } } } },
      testRun: viaRun,
      testResult: { select: { testRun: viaRun } },
      stepResult: { select: { testResult: { select: { testRun: viaRun } } } },
      defect: { select: { application: app } },
    },
  });
  if (!artifact) return notFound();

  const projectId =
    artifact.discoveryRun?.application.projectId ??
    artifact.discoveredPage?.run.application.projectId ??
    artifact.testRun?.planVersion.suite.application.projectId ??
    artifact.testResult?.testRun.planVersion.suite.application.projectId ??
    artifact.stepResult?.testResult.testRun.planVersion.suite.application.projectId ??
    artifact.defect?.application.projectId;
  // Same response for "doesn't exist" and "not yours".
  if (!projectId || !can(actor.role, await getProjectRole(actor, projectId), "project.view")) return notFound();

  let body: Buffer;
  try {
    body = await readArtifact(artifact.storageKey);
  } catch {
    return notFound();
  }

  const inline = artifact.mimeType.startsWith("image/");
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": artifact.mimeType,
      "content-length": String(body.length),
      "content-disposition": inline ? "inline" : `attachment; filename="artifact-${id.data}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
