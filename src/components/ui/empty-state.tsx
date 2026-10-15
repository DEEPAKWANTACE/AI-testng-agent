import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
