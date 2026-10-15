import type { ReactNode } from "react";

/** Highlights capabilities that are scaffolded but not implemented yet. */
export function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-6 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm dark:border-sky-900 dark:bg-sky-950/50">
      <p className="font-medium text-sky-900 dark:text-sky-200">{title}</p>
      <div className="mt-0.5 text-sky-800 dark:text-sky-300">{children}</div>
    </div>
  );
}
