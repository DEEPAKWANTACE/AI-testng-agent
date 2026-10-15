import { cn, humanize } from "@/lib/utils";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const tones: Record<Tone, string> = {
  neutral: "bg-zinc-100 text-zinc-700 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300",
  info: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950 dark:text-sky-300",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300",
  warning: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300",
  danger: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-300",
};

/** Status values across every module map onto a small set of tones. */
const statusTones: Record<string, Tone> = {
  ACTIVE: "success",
  ARCHIVED: "neutral",
  DRAFT: "neutral",
  PENDING: "warning",
  PENDING_APPROVAL: "warning",
  QUEUED: "neutral",
  RUNNING: "info",
  APPROVED: "success",
  COMPLETED: "success",
  PASSED: "success",
  REJECTED: "danger",
  FAILED: "danger",
  ERROR: "danger",
  CANCELLED: "neutral",
  SKIPPED: "neutral",
  BLOCKED: "warning",
  SUPERSEDED: "neutral",
  OPEN: "danger",
  IN_PROGRESS: "info",
  RESOLVED: "success",
  CLOSED: "neutral",
  WONT_FIX: "neutral",
  DEPRECATED: "neutral",
  CRITICAL: "danger",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "neutral",
  PRODUCTION: "danger",
  STAGING: "warning",
  DEVELOPMENT: "info",
};

export function StatusBadge({ status, tone }: { status: string; tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        tones[tone ?? statusTones[status] ?? "neutral"],
      )}
    >
      {humanize(status)}
    </span>
  );
}
