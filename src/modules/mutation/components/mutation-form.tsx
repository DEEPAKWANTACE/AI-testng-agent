"use client";

import { useActionState } from "react";
import { FormStateProvider, FormMessage, type FormAction } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { initialActionState } from "@/lib/action-state";

export function MutationForm({ action }: { action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, initialActionState);
  return (
    <FormStateProvider value={state}>
      <form action={formAction} className="flex flex-wrap items-center gap-2" noValidate>
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          Mutants
          <input name="mutantLimit" type="number" min={1} max={100} defaultValue={20} className="w-16 rounded border border-zinc-300 px-1 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-950" />
        </label>
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {pending ? "Queueing…" : "Run mutation analysis"}
        </Button>
        <FormMessage state={state} />
      </form>
    </FormStateProvider>
  );
}
