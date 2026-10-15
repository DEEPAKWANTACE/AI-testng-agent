"use client";

import { useActionState, useRef, type ReactNode } from "react";
import { FormMessage, type FormAction } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { initialActionState } from "@/lib/action-state";

/**
 * Wraps a list of cases with `caseIds` checkboxes and applies a review decision to the
 * selection. The clicked button submits the `decision` value.
 */
export function BulkReviewForm({ action, children, disabled }: { action: FormAction; children: ReactNode; disabled?: boolean }) {
  const [state, formAction, pending] = useActionState(action, initialActionState);
  const form = useRef<HTMLFormElement>(null);
  const select = (filter: (box: HTMLInputElement) => boolean) => {
    form.current?.querySelectorAll<HTMLInputElement>('input[name="caseIds"]').forEach((box) => {
      box.checked = filter(box);
    });
  };

  return (
    <form ref={form} action={formAction}>
      {!disabled ? (
        <div className="sticky top-14 z-[5] flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white/95 px-5 py-2.5 backdrop-blur lg:top-0 dark:border-zinc-800 dark:bg-zinc-900/95">
          <Button size="sm" variant="ghost" onClick={() => select((b) => b.dataset.state === "PROPOSED")}>Select proposed</Button>
          <Button size="sm" variant="ghost" onClick={() => select(() => true)}>Select all</Button>
          <Button size="sm" variant="ghost" onClick={() => select(() => false)}>Clear</Button>
          <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
          <Button type="submit" size="sm" name="decision" value="ACCEPTED" disabled={pending}>Accept selected</Button>
          <Button type="submit" size="sm" name="decision" value="REJECTED" variant="danger" disabled={pending}>Reject selected</Button>
          <Button type="submit" size="sm" name="decision" value="PROPOSED" variant="secondary" disabled={pending}>Re-open</Button>
          <FormMessage state={state} />
        </div>
      ) : null}
      {children}
    </form>
  );
}
