import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">{children}</table>
    </div>
  );
}

export function THead({ columns }: { columns: Array<string | { label: string; className?: string }> }) {
  return (
    <thead className="bg-zinc-50 dark:bg-zinc-900/60">
      <tr>
        {columns.map((column) => {
          const { label, className } = typeof column === "string" ? { label: column, className: undefined } : column;
          return (
            <th
              key={label}
              scope="col"
              className={cn(
                "px-5 py-2.5 text-left text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400",
                className,
              )}
            >
              {label}
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">{children}</tbody>;
}

export function TD({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn("px-5 py-3 align-middle text-zinc-700 dark:text-zinc-300", className)}>{children}</td>;
}
