import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDateTime, humanize } from "@/lib/utils";
import { requestMutationRunAction } from "@/modules/mutation/actions";
import { OPERATOR_LABELS, type MutationOperator } from "@/modules/mutation/operators";
import { MutationForm } from "./mutation-form";

type Run = {
  id: string;
  status: string;
  score: number | null;
  killed: number;
  survived: number;
  unclear: number;
  baselineRunId: string | null;
  blockedReason: string | null;
  errorMessage: string | null;
  createdAt: Date;
  mutants: unknown;
};
type MutantRow = { id: string; operator: MutationOperator; description: string; outcome: string; killedBy: string | null; note: string | null };

/** Mutation analysis of one approved version: launch, latest results and surviving mutants. */
export function MutationPanel({ planVersionId, runs, canRun }: { planVersionId: string; runs: Run[]; canRun: boolean }) {
  return (
    <div className="mt-3 rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-zinc-700 dark:text-zinc-300" title="How many deliberate changes to the application's responses this plan detects">
          Mutation testing
        </p>
        {canRun ? <MutationForm action={requestMutationRunAction.bind(null, planVersionId)} /> : null}
      </div>
      {runs.length === 0 ? <p className="text-zinc-500">Not run yet. The plan first runs unchanged (it must pass), then once per mutant.</p> : null}
      <ul className="space-y-2">
        {runs.map((run) => {
          const mutants = (run.mutants ?? []) as MutantRow[];
          const gaps = mutants.filter((m) => m.outcome === "SURVIVED");
          return (
            <li key={run.id}>
              <p className="flex flex-wrap items-center gap-2">
                <StatusBadge status={run.status} />
                {run.score !== null ? (
                  <span className="font-medium">
                    {Math.round(run.score * 100)}% killed ({run.killed} killed, {run.survived} survived, {run.unclear} unclear)
                  </span>
                ) : null}
                <span className="text-zinc-500">{formatDateTime(run.createdAt)}</span>
                {run.baselineRunId ? (
                  <Link href={`/test-runs/${run.baselineRunId}`} className="text-indigo-600">
                    baseline run
                  </Link>
                ) : null}
              </p>
              {run.blockedReason ? <p className="text-amber-700">{run.blockedReason}</p> : null}
              {run.errorMessage ? <p className="text-red-600">{run.errorMessage}</p> : null}
              {mutants.length ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-indigo-600">
                    {gaps.length ? `${gaps.length} undetected change${gaps.length === 1 ? "" : "s"}: gaps in this plan` : "All mutants"}
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {mutants.map((m) => (
                      <li key={m.id} className="flex flex-wrap gap-2">
                        <StatusBadge status={humanize(m.outcome)} tone={m.outcome === "KILLED" ? "success" : m.outcome === "SURVIVED" ? "danger" : "neutral"} />
                        <span title={OPERATOR_LABELS[m.operator]}>{m.description}</span>
                        <span className="text-zinc-500">{m.killedBy ? `caught by “${m.killedBy}”` : m.note}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-zinc-500">Mutants only change responses the browser receives; requests and server data are untouched. A high score means this plan notices these kinds of changes, not that the application is defect-free.</p>
    </div>
  );
}
