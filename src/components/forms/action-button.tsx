"use client";

import { useActionState, type ReactNode } from "react";
import { initialActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import type { FormAction } from "./action-form";

/**
 * A single-button form for workflow transitions (submit, cancel, delete…).
 * Shows the action's error inline and optionally asks for confirmation first.
 */
export function ActionButton({
  action,
  children,
  confirmMessage,
  variant = "secondary",
  hiddenFields,
}: {
  action: FormAction;
  children: ReactNode;
  confirmMessage?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  hiddenFields?: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState(action, initialActionState);

  return (
    <form
      action={formAction}
      className="inline-flex flex-col items-end gap-1"
      onSubmit={(event) => {
        if (confirmMessage && !window.confirm(confirmMessage)) event.preventDefault();
      }}
    >
      {hiddenFields
        ? Object.entries(hiddenFields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)
        : null}
      <Button type="submit" size="sm" variant={variant} disabled={pending}>
        {children}
      </Button>
      {state.status === "error" && state.message ? (
        <p role="alert" className="max-w-56 text-right text-xs text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
