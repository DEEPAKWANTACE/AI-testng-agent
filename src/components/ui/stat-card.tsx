import Link from "next/link";

export function StatCard({ label, value, hint, href }: { label: string; value: number; hint?: string; href: string }) {
  return (
    <Link
      href={href}
      className="group rounded-lg border border-zinc-200 bg-white p-4 shadow-xs transition-colors hover:border-indigo-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-700"
    >
      <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-zinc-900 tabular-nums dark:text-zinc-50">{value}</p>
      {hint ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p> : null}
    </Link>
  );
}
