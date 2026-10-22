import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { formatDateTime, pluralize } from "@/lib/utils";
import { requireActor } from "@/modules/auth/session";
import { reviewBaselineAction } from "@/modules/visual-baselines/actions";
import { BaselineReviewForm } from "@/modules/visual-baselines/components/baseline-review-form";
import { listBaselines } from "@/modules/visual-baselines/queries";

export const metadata: Metadata = { title: "Visual baselines" };

export default function VisualBaselinesPage() {
  return (
    <>
      <PageHeader
        title="Visual baselines"
        description="Visual checks compare against images a reviewer approved. Runs only propose candidates; until one is approved, that check is reported as inconclusive."
      />
      <Suspense fallback={<CardSkeleton rows={3} />}>
        <Baselines />
      </Suspense>
    </>
  );
}

const image = (id: string, alt: string) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img src={`/api/baselines/${id}`} alt={alt} className="max-h-80 w-auto rounded border border-zinc-200 dark:border-zinc-800" />
);

async function Baselines() {
  const actor = await requireActor();
  const { pending, approved } = await listBaselines(actor);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Candidates awaiting review" description={pluralize(pending.length, "candidate")} />
        {pending.length === 0 ? (
          <EmptyState title="No candidates" description="A run captures a candidate when a visual check has no approved baseline." />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {pending.map((b) => (
              <li key={b.id}>
                <CardBody className="space-y-3">
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      “{b.name}” · {b.caseTitle ?? "Unknown case"}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {b.application.name} · {b.width}×{b.height} · captured {formatDateTime(b.createdAt)} · sha256 {b.sha256.slice(0, 12)}…
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-4">
                    <figure>
                      <figcaption className="mb-1 text-xs text-zinc-500">Candidate</figcaption>
                      {image(b.id, `Candidate baseline ${b.name}`)}
                    </figure>
                    {b.current ? (
                      <figure>
                        <figcaption className="mb-1 text-xs text-zinc-500">Currently approved</figcaption>
                        {image(b.current.id, `Approved baseline ${b.name}`)}
                      </figure>
                    ) : null}
                  </div>
                  {b.canReview ? <BaselineReviewForm action={reviewBaselineAction.bind(null, b.id)} expectedHash={b.sha256} /> : <p className="text-xs text-zinc-500">A QA lead or admin of this project can review it.</p>}
                </CardBody>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Approved baselines" description={pluralize(approved.length, "baseline")} />
        {approved.length === 0 ? (
          <EmptyState title="No approved baselines" description="Approved images appear here." />
        ) : (
          <ul className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
            {approved.map((b) => (
              <li key={b.id} className="space-y-1 text-xs">
                {image(b.id, `Approved baseline ${b.name}`)}
                <p className="font-medium text-zinc-900 dark:text-zinc-100">“{b.name}” · {b.caseTitle ?? "Unknown case"}</p>
                <p className="text-zinc-500">
                  {b.application.name} · approved by {b.reviewer?.name ?? "a former user"} {formatDateTime(b.reviewedAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
