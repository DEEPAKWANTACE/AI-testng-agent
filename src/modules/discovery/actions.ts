"use server";

import { DomainError, failure, success, toActionError, validationError, type ActionState } from "@/lib/action-state";
import { db } from "@/lib/db";
import { revalidateDashboard } from "@/lib/revalidate";
import { formDataToObject, idSchema } from "@/lib/validation";
import { assertApplicationPermission, NotFoundError } from "@/modules/access/service";
import { isWithinAuthorizedUrl } from "@/modules/applications/authorized-url";
import { removeArtifactPrefix } from "@/modules/artifacts/storage";
import { requireActor } from "@/modules/auth/session";
import { discoveryAuthInputSchema, saveDiscoveryAuth } from "./auth-config";
import { discoveryInputSchema } from "./schemas";

/** Queues a discovery run. The discovery worker (`npm run worker:discovery`) picks it up. */
export async function createDiscoveryRun(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const parsed = discoveryInputSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  try {
    await assertApplicationPermission(actor, parsed.data.applicationId, "discovery.run");
    const { authorizedUrl } = await db().application.findUniqueOrThrow({
      where: { id: parsed.data.applicationId },
      select: { authorizedUrl: true },
    });
    if (!isWithinAuthorizedUrl(parsed.data.startUrl, authorizedUrl)) {
      throw new DomainError(`Start URL must be within the application's authorized URL (${authorizedUrl}).`);
    }
    await db().discoveryRun.create({ data: { ...parsed.data, triggeredById: actor.id } });
  } catch (error) {
    return toActionError(error, values);
  }

  revalidateDashboard();
  return success("Discovery run queued. The discovery worker will start it shortly.");
}

async function assertRunPermission(actor: Awaited<ReturnType<typeof requireActor>>, runId: string) {
  const run = await db().discoveryRun.findUnique({ where: { id: runId }, select: { status: true, applicationId: true } });
  if (!run) throw new NotFoundError("Discovery run");
  try {
    await assertApplicationPermission(actor, run.applicationId, "discovery.run");
  } catch (error) {
    throw error instanceof NotFoundError ? new NotFoundError("Discovery run") : error;
  }
  return run;
}

/** Queued runs stop immediately; running runs stop after the current page. */
export async function cancelDiscoveryRun(id: string): Promise<ActionState> {
  const actor = await requireActor();
  const runId = idSchema.safeParse(id);
  if (!runId.success) return failure("Invalid discovery run");

  try {
    await assertRunPermission(actor, runId.data);
    const queued = await db().discoveryRun.updateMany({
      where: { id: runId.data, status: "QUEUED" },
      data: { status: "CANCELLED", finishedAt: new Date() },
    });
    const running = await db().discoveryRun.updateMany({ where: { id: runId.data, status: "RUNNING" }, data: { status: "CANCELLED" } });
    if (queued.count + running.count === 0) throw new DomainError("Only queued or running discovery runs can be cancelled.");
  } catch (error) {
    return toActionError(error);
  }

  revalidateDashboard();
  return success("Discovery run cancelled.");
}

export async function deleteDiscoveryRun(id: string): Promise<ActionState> {
  const actor = await requireActor();
  const runId = idSchema.safeParse(id);
  if (!runId.success) return failure("Invalid discovery run");

  try {
    const run = await assertRunPermission(actor, runId.data);
    if (run.status === "RUNNING") throw new DomainError("Cancel the run before deleting it.");
    await db().discoveryRun.delete({ where: { id: runId.data } });
    await removeArtifactPrefix(`discovery/${runId.data}`);
  } catch (error) {
    return toActionError(error);
  }

  revalidateDashboard();
  return success("Discovery run deleted.");
}

export async function updateDiscoveryAuth(applicationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = formDataToObject(formData);
  const id = idSchema.safeParse(applicationId);
  if (!id.success) return failure("Invalid application");
  const parsed = discoveryAuthInputSchema.safeParse(values);
  if (!parsed.success) return validationError(parsed.error, values);

  try {
    await saveDiscoveryAuth(actor, id.data, parsed.data);
  } catch (error) {
    return toActionError(error, values);
  }

  revalidateDashboard();
  return success("Discovery login saved.");
}
