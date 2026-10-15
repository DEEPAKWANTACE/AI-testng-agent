"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Refreshes server data periodically while something is in progress (queued/running jobs). */
export function AutoRefresh({ active, intervalMs = 3_000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return active ? <span className="text-xs text-zinc-500">Updating live…</span> : null;
}
