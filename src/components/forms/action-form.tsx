"use client";

import { createContext, useActionState, useContext, type ReactNode } from "react";
import { initialActionState, type ActionState } from "@/lib/action-state";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

const FormStateContext = createContext<ActionState>(initialActionState);

/** For custom forms that manage their own `useActionState` but reuse the field components. */
export function FormStateProvider({ value, children }: { value: ActionState; children: ReactNode }) {
  return <FormStateContext value={value}>{children}</FormStateContext>;
}

export function useFieldState(name: string): { errors?: string[]; submittedValue?: string } {
  const state = useContext(FormStateContext);
  return { errors: state.fieldErrors?.[name], submittedValue: state.values?.[name] };
}

/**
 * A form bound to a Server Action that returns `ActionState`.
 * Field components read validation errors from context, so forms stay declarative.
 */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel = "Saving…",
  className,
  children,
}: {
  action: FormAction;
  submitLabel: string;
  pendingLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, initialActionState);

  return (
    <FormStateContext value={state}>
      <form action={formAction} className={cn("space-y-4", className)} noValidate>
        {children}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="submit" disabled={pending}>
            {pending ? pendingLabel : submitLabel}
          </Button>
          <FormMessage state={state} />
        </div>
      </form>
    </FormStateContext>
  );
}

export function FormMessage({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={cn(
        "text-sm",
        state.status === "error" ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
      )}
    >
      {state.message}
    </p>
  );
}
