import { humanize } from "@/lib/utils";
import { SUSPECTED_CAUSE_LABEL, type ReportData } from "./build";

export type ReportFilters = { status?: string; feature?: string; priority?: string; regressionsOnly?: boolean };

export function filterResults(data: ReportData, filters: ReportFilters) {
  return data.results.filter(
    (r) =>
      (!filters.status || r.status === filters.status) &&
      (!filters.feature || (r.featureName ?? "(no feature)") === filters.feature) &&
      (!filters.priority || r.casePriority === filters.priority) &&
      (!filters.regressionsOnly || r.comparison === "REGRESSED"),
  );
}

/** Stated on every report: results are evidence about the executed cases, nothing more. */
export const REPORT_LIMITATIONS =
  "These results cover only the approved test cases that were executed against this target at this time. They do not establish complete coverage or guarantee the application is free of defects. FAILED means a deterministic check didn't hold; INCONCLUSIVE means the evidence doesn't support a verdict; BLOCKED means the case couldn't run.";

/** Structured report (also the JSON download). Evidence is linked, never embedded. */
export function reportJson(data: ReportData, origin: string, filters: ReportFilters = {}) {
  const coverage = (data.report?.coverage ?? { features: [], uncovered: [] }) as { features: unknown[]; uncovered: string[]; inventory?: { known: number; byLevel: Record<string, number>; notVerified: string[]; disclaimer: string } | null };
  const evidence = (id: string) => `${origin}/api/artifacts/${id}`;
  return {
    generatedAt: new Date().toISOString(),
    run: {
      id: data.id,
      status: data.status,
      blockedReason: data.blockedReason,
      error: data.errorMessage,
      queuedAt: data.createdAt.toISOString(),
      startedAt: data.startedAt?.toISOString() ?? null,
      finishedAt: data.finishedAt?.toISOString() ?? null,
      attempts: data.attempts,
      target: data.baseUrl,
      environment: data.environment,
      triggeredBy: data.triggeredBy?.name ?? null,
      comparedToRunId: data.comparedToRunId,
    },
    plan: {
      application: data.planVersion.suite.application.name,
      project: data.planVersion.suite.application.project.name,
      suite: data.planVersion.suite.name,
      kind: data.planVersion.suite.kind,
      version: data.planVersion.version,
      contentHash: data.planVersion.contentHash,
      approvedBy: data.planVersion.approvals[0]?.reviewer?.name ?? null,
      approvedAt: data.planVersion.approvals[0]?.decidedAt?.toISOString() ?? null,
      approvedHash: data.planVersion.approvals[0]?.decidedHash ?? null,
    },
    limitations: REPORT_LIMITATIONS,
    totals: {
      passed: data.report?.passed ?? 0,
      failed: data.report?.failed ?? 0,
      blocked: data.report?.blocked ?? 0,
      inconclusive: (data.report?.inconclusive ?? 0) + (data.report?.errored ?? 0),
      skipped: data.report?.skipped ?? 0,
      flaky: data.report?.flaky ?? 0,
      regressions: data.report?.regressions ?? 0,
      fixed: data.report?.fixed ?? 0,
    },
    coverage,
    filters,
    results: filterResults(data, filters).map((r) => ({
      title: r.caseTitle,
      caseKey: r.caseKey,
      feature: r.featureName,
      category: r.category,
      priority: r.casePriority,
      status: r.status,
      failureClass: r.failureClass,
      comparison: r.comparison,
      previousStatus: r.previousStatus,
      suggestedSeverity: r.suggestedSeverity,
      error: r.errorMessage,
      suspectedCause: r.suspectedCause ? { label: SUSPECTED_CAUSE_LABEL, confirmed: false, text: r.suspectedCause } : null,
      reproductionSteps: r.reproduction,
      attempts: r.attempts ?? [],
      flaky: r.flaky,
      flakeRate: r.flakeRate,
      defects: r.defects.map((d) => ({ severity: d.severity, verification: d.verification, verifiedAt: d.verifiedAt?.toISOString() ?? null })),
      steps: r.stepResults.map((s) => ({
        position: s.position + 1,
        action: s.action,
        status: s.status,
        expected: s.expectedResult,
        actual: s.actualResult,
        error: s.errorMessage,
        evidence: s.artifacts.map((a) => evidence(a.id)),
      })),
      evidence: r.artifacts.map((a) => ({ kind: a.kind, url: evidence(a.id) })),
    })),
  };
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** HTML-escapes untrusted text (case titles, actual values and errors can contain page content). */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Self-contained HTML report (no scripts; values escaped; evidence linked). */
export function reportHtml(data: ReportData, origin: string, filters: ReportFilters = {}): string {
  const r = reportJson(data, origin, filters);
  const e = escapeHtml;
  const badge = (status: string | null) => (status ? `<span class="b b-${e(status.toLowerCase())}">${e(humanize(status))}</span>` : "");
  const rows = r.results
    .map((res) => {
      const failed = res.steps.find((s) => s.status === "FAILED");
      return `<section class="case">
  <h3>${badge(res.status)} ${e(res.title)} ${res.comparison === "REGRESSED" ? '<span class="b b-failed">Regression</span>' : res.comparison === "FIXED" ? '<span class="b b-passed">Fixed</span>' : ""}</h3>
  <p class="meta">${e(res.feature ?? "No feature")} · ${e(humanize(res.category ?? "FUNCTIONAL"))} · priority ${e(humanize(res.priority))}${res.suggestedSeverity ? ` · suggested severity ${e(humanize(res.suggestedSeverity))}` : ""}${res.previousStatus ? ` · previously ${e(humanize(res.previousStatus))}` : ""}</p>
  ${res.error ? `<p class="err">${e(res.error)}</p>` : ""}
  ${failed ? `<table class="ea"><tr><th>Expected</th><td>${e(failed.expected ?? "—")}</td></tr><tr><th>Actual</th><td>${e(failed.actual ?? failed.error ?? "—")}</td></tr></table>` : ""}
  ${res.suspectedCause ? `<p class="cause"><strong>${e(res.suspectedCause.label)}:</strong> ${e(res.suspectedCause.text)}</p>` : ""}
  ${res.status !== "PASSED" && res.reproductionSteps.length ? `<details><summary>Reproduction steps</summary><ol>${res.reproductionSteps.map((s) => `<li>${e(s)}</li>`).join("")}</ol></details>` : ""}
  <details><summary>Steps (${res.steps.length})</summary><ol>${res.steps
    .map((s) => `<li>${badge(s.status)} ${e(s.action)}${s.actual ? ` — <em>${e(s.actual)}</em>` : ""}${s.evidence.map((u, i) => ` <a href="${e(u)}">screenshot${i ? i + 1 : ""}</a>`).join("")}</li>`)
    .join("")}</ol></details>
  ${res.evidence.length ? `<p class="meta">Evidence: ${res.evidence.map((ev) => `<a href="${e(ev.url)}">${e(humanize(ev.kind))}</a>`).join(" · ")}</p>` : ""}
</section>`;
    })
    .join("\n");
  const coverage = (r.coverage.features as Array<{ feature: string; total: number; passed: number; failed: number; blocked: number; passRate: number | null }>)
    .map((f) => `<tr><td>${e(f.feature)}</td><td>${f.total}</td><td>${f.passed}</td><td>${f.failed}</td><td>${f.blocked}</td><td>${f.passRate === null ? "—" : `${f.passRate}%`}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${e(origin)}">
<title>${e(`${r.plan.suite} v${r.plan.version} — test report`)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;color:#18181b;max-width:960px;margin:0 auto;padding:24px}h1{font-size:22px;margin:0}h2{font-size:16px;margin-top:28px}h3{font-size:14px;margin:0 0 4px}
.meta{color:#71717a;font-size:12px;margin:2px 0}.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.tile{border:1px solid #e4e4e7;border-radius:8px;padding:10px 14px;min-width:90px}.tile b{display:block;font-size:22px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e4e4e7;padding:6px 8px;text-align:left;font-size:13px;vertical-align:top}.ea th{width:90px;color:#71717a}
.case{border:1px solid #e4e4e7;border-radius:8px;padding:12px 14px;margin:10px 0}.err{color:#b91c1c;font-size:13px}.cause{background:#fffbeb;border:1px solid #fde68a;padding:6px 8px;border-radius:6px;font-size:13px}
.b{display:inline-block;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600;background:#f4f4f5}.b-passed{background:#dcfce7;color:#166534}.b-failed,.b-error{background:#fee2e2;color:#991b1b}.b-blocked,.b-inconclusive{background:#fef3c7;color:#92400e}.muted{color:#71717a;font-size:12px}
</style></head><body>
<h1>${e(r.plan.suite)} v${r.plan.version} ${badge(r.run.status)}</h1>
<p class="meta">${e(r.plan.project)} / ${e(r.plan.application)} · ${e(r.run.target)} · ${e(r.run.environment ?? "")} · run ${e(r.run.id)} · finished ${e(r.run.finishedAt ?? "—")}</p>
<p class="meta">Plan hash ${e(r.plan.contentHash)} · approved by ${e(r.plan.approvedBy ?? "—")} at ${e(r.plan.approvedAt ?? "—")}</p>
${r.run.blockedReason ? `<p class="err">Blocked before execution: ${e(r.run.blockedReason)}</p>` : ""}${r.run.error ? `<p class="err">${e(r.run.error)}</p>` : ""}
<p class="muted">${e(r.limitations)}</p>
<div class="tiles"><div class="tile">Passed<b>${r.totals.passed}</b></div><div class="tile">Failed<b>${r.totals.failed}</b></div><div class="tile">Blocked<b>${r.totals.blocked}</b></div><div class="tile">Inconclusive<b>${r.totals.inconclusive}</b></div><div class="tile">Skipped<b>${r.totals.skipped}</b></div><div class="tile">Regressions<b>${r.totals.regressions}</b></div><div class="tile">Fixed<b>${r.totals.fixed}</b></div></div>
<h2>Feature coverage</h2>
<table><tr><th>Feature</th><th>Cases</th><th>Passed</th><th>Failed</th><th>Blocked</th><th>Pass rate</th></tr>${coverage}</table>
${r.coverage.uncovered.length ? `<p class="meta">Features without tests: ${e(r.coverage.uncovered.join(", "))}</p>` : ""}
${r.coverage.inventory ? `<p class="meta">Known inventory: ${r.coverage.inventory.byLevel.VERIFIED} of ${r.coverage.inventory.known} items verified by this run.${r.coverage.inventory.notVerified.length ? ` Not verified: ${e(r.coverage.inventory.notVerified.slice(0, 30).join(", "))}.` : ""} ${e(r.coverage.inventory.disclaimer)}</p>` : ""}
<h2>Results${Object.values(filters).some(Boolean) ? " (filtered)" : ""}</h2>
${rows || '<p class="meta">No results.</p>'}
<p class="meta">Suspected causes are heuristic hints and have not been confirmed.</p>
</body></html>`;
}
