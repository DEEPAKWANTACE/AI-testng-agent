"use client";

import { useActionState } from "react";
import { FormStateProvider, FormMessage, type FormAction } from "@/components/forms/action-form";
import { TextAreaField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { initialActionState } from "@/lib/action-state";

/** A reviewer's verdict on a reproduced defect, after looking at the evidence. */
export function DefectVerificationForm({ action }: { action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, initialActionState);
  return (
    <FormStateProvider value={state}>
      <form action={formAction} className="mt-2 space-y-2" noValidate>
        <TextAreaField name="note" label="What did you check?" rows={2} placeholder="e.g. Reproduced manually in staging; trace shows the wrong total" />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" name="decision" value="CONFIRMED" size="sm" disabled={pending}>
            Confirm defect
          </Button>
          <Button type="submit" name="decision" value="NOT_CONFIRMED" size="sm" variant="secondary" disabled={pending}>
            Not confirmed
          </Button>
          <FormMessage state={state} />
        </div>
      </form>
    </FormStateProvider>
  );
}
