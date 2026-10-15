export function Progress({ done, total, label }: { done: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="min-w-24">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total} aria-label={label ?? "Progress"}>
        <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-zinc-500 tabular-nums">
        {done}/{total}
      </p>
    </div>
  );
}
