import { cn } from "@/lib/utils";
import { Card } from "./card";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800", className)} />;
}

export function CardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Card>
      <div className="border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="space-y-3 px-5 py-4">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    </Card>
  );
}
