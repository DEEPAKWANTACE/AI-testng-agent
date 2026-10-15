import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { db } from "@/lib/db";
import { projectScope } from "@/modules/access/service";
import { requireActor } from "@/modules/auth/session";

/** Reports live on their run's page; this keeps older report links working. */
export default function ReportRedirectPage({ params }: PageProps<"/reports/[reportId]">) {
  return (
    <Suspense>
      <RedirectToRun params={params} />
    </Suspense>
  );
}

async function RedirectToRun({ params }: { params: PageProps<"/reports/[reportId]">["params"] }): Promise<null> {
  const actor = await requireActor();
  const { reportId } = await params;
  const report = await db().report.findFirst({
    where: { id: reportId, testRun: { planVersion: { suite: { application: { project: projectScope(actor) } } } } },
    select: { testRunId: true },
  });
  if (!report) notFound();
  redirect(`/test-runs/${report.testRunId}`);
}
