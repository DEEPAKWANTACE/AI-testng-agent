"use client";

import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";

export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <Card>
      <CardBody className="py-10 text-center">
        <h1 className="text-base font-semibold">Something went wrong loading this page</h1>
        <p className="mx-auto mt-2 max-w-lg text-sm text-zinc-500 dark:text-zinc-400">
          If this is a fresh setup, check that PostgreSQL is running, <code>DATABASE_URL</code> is set in{" "}
          <code>.env</code>, and migrations have been applied (<code>npm run db:migrate</code>).
        </p>
        {error.digest ? <p className="mt-2 font-mono text-xs text-zinc-400">Reference: {error.digest}</p> : null}
        <Button className="mt-5" variant="secondary" onClick={() => retry()}>
          Try again
        </Button>
      </CardBody>
    </Card>
  );
}
