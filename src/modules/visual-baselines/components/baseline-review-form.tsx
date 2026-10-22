"use client";

import { useActionState } from "react";
import { FormStateProvider, FormMessage, type FormAction } from "@/components/forms/action-form";
import { TextAreaField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { initialActionState } from "@/lib/action-state";

/** Approve/reject a candidate image; bound to the hash of the image shown. */
export function BaselineReviewForm({ action, expectedHash }: { action: FormAction; expectedHash: string }) {
  const [state, formAction, pending] = useActionState(action, initialActionState);
  return (
    <FormStateProvider value={state}>
      <form action={formAction} className="space-y-2" noValidate>
        <input type="hidden" name="expectedHash" value={expectedHash} />
        <TextAreaField name="note" label="Note" rows={2} placeholder="Optional: what you checked" />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" name="decision" value="APPROVED" size="sm" disabled={pending}>
            Approve as baseline
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
