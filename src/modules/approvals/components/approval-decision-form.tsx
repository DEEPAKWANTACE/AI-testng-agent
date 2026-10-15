"use client";

import { useActionState } from "react";
import { FormStateProvider, FormMessage, type FormAction } from "@/components/forms/action-form";
import { TextAreaField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { initialActionState } from "@/lib/action-state";

/** Approve/reject form; the clicked button submits the `decision` value. The reviewer is the signed-in user. */
export function ApprovalDecisionForm({ action, expectedHash }: { action: FormAction; expectedHash: string }) {
  const [state, formAction, pending] = useActionState(action, initialActionState);

  return (
    <FormStateProvider value={state}>
      <form action={formAction} className="space-y-3" noValidate>
        {/* Binds the decision to the exact content shown to the reviewer. */}
        <input type="hidden" name="expectedHash" value={expectedHash} />
        <TextAreaField name="comment" label="Comment" rows={2} placeholder="Required when rejecting" />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" name="decision" value="APPROVED" size="sm" disabled={pending}>
            Approve
          </Button>
          <Button type="submit" name="decision" value="REJECTED" size="sm" variant="danger" disabled={pending}>
            Reject
          </Button>
          <FormMessage state={state} />
        </div>
      </form>
    </FormStateProvider>
  );
}
