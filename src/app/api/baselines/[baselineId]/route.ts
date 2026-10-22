import { db } from "@/lib/db";
import { idSchema } from "@/lib/validation";
import { can } from "@/modules/access/policy";
import { getProjectRole } from "@/modules/access/service";
import { readArtifact } from "@/modules/artifacts/storage";
import { getCurrentActor } from "@/modules/auth/session";

/** Serves a baseline image to signed-in users who can view its project. */
export async function GET(_request: Request, ctx: RouteContext<"/api/baselines/[baselineId]">) {
  const actor = await getCurrentActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  const { baselineId } = await ctx.params;
  const id = idSchema.safeParse(baselineId);
  const notFound = () => new Response("Not found", { status: 404 });
  if (!id.success) return notFound();
  const baseline = await db().visualBaseline.findUnique({ where: { id: id.data }, select: { storageKey: true, application: { select: { projectId: true } } } });
  if (!baseline) return notFound();
  const role = await getProjectRole(actor, baseline.application.projectId);
  if (!can(actor.role, role, "project.view")) return notFound();
  const bytes = await readArtifact(baseline.storageKey).catch(() => null);
  if (!bytes) return notFound();
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": "image/png", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" },
  });
}
