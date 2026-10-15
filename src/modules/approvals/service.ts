import "server-only";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import { can } from "@/modules/access/policy";
import { assertApplicationPermission, ForbiddenError, getProjectRole, NotFoundError } from "@/modules/access/service";
import { audit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/auth/service";
import type { ApprovalDecision } from "./schemas";

/**
 * Decides an approval request. The decision is bound to the exact immutable version content
 * the reviewer saw (hash) and records the reviewer's authorization at decision time.
 */
export async function decideApproval(actor: Actor, approvalId: string, input: ApprovalDecision) {
  const approval = await db().approval.findUnique({
    where: { id: approvalId },
    select: {
      requestedById: true,
      requestedHash: true,
      planVersionId: true,
      planVersion: { select: { suiteId: true, version: true, contentHash: true, suite: { select: { applicationId: true, application: { select: { projectId: true } } } } } },
    },
  });
  if (!approval) throw new NotFoundError("Approval request");
  const { planVersion } = approval;
  const projectId = planVersion.suite.application.projectId;
  await assertApplicationPermission(actor, planVersion.suite.applicationId, "plan.review");
  // Separation of duties: nobody approves their own submission.
  if (approval.requestedById === actor.id) throw new ForbiddenError("You can't review your own submission.");

  // The reviewer must be deciding exactly the content that was submitted.
  if (input.expectedHash !== planVersion.contentHash || approval.requestedHash !== planVersion.contentHash) {
    throw new DomainError("This plan version's content doesn't match what you reviewed. Reload the page and review it again.");
  }

  const projectRole = await getProjectRole(actor, projectId);
  if (!can(actor.role, projectRole, "plan.review")) throw new ForbiddenError();

  await db().$transaction(async (tx) => {
    const decidedAt = new Date();
    const { count } = await tx.approval.updateMany({
      where: { id: approvalId, status: "PENDING" },
      data: {
        status: input.decision,
        reviewerId: actor.id,
        comment: input.comment,
        decidedAt,
        decidedHash: planVersion.contentHash,
        reviewerRole: actor.role,
        reviewerProjectRole: projectRole,
      },
    });
    if (count === 0) throw new DomainError("This request has already been decided.");

    if (input.decision === "APPROVED") {
      // Only the newest approved version of a suite stays runnable.
      await tx.planVersion.updateMany({ where: { suiteId: planVersion.suiteId, status: "APPROVED" }, data: { status: "SUPERSEDED" } });
    }
    await tx.planVersion.update({
      where: { id: approval.planVersionId },
      data: { status: input.decision, approvedAt: input.decision === "APPROVED" ? decidedAt : null },
    });
    await audit(
      {
        actor,
        action: input.decision === "APPROVED" ? "plan.approved" : "plan.rejected",
        entityType: "PlanVersion",
        entityId: approval.planVersionId,
        projectId,
        data: { version: planVersion.version, contentHash: planVersion.contentHash, reviewerRole: actor.role, reviewerProjectRole: projectRole, comment: input.comment },
      },
      tx,
    );
  });
}
