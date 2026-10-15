import { z } from "zod";
import { idSchema } from "@/lib/validation";
import { can } from "@/modules/access/policy";
import { getProjectRole } from "@/modules/access/service";
import { audit } from "@/modules/audit/audit";
import { getCurrentActor } from "@/modules/auth/session";
import { loadReportData } from "@/modules/reports/build";
import { reportHtml, reportJson } from "@/modules/reports/export";

const querySchema = z.object({
  format: z.enum(["html", "json"]).default("html"),
  status: z.enum(["PASSED", "FAILED", "SKIPPED", "BLOCKED", "ERROR"]).optional(),
  feature: z.string().max(200).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  regressions: z.enum(["1"]).optional(),
});

/** Downloadable run report (HTML or JSON) for people who can view the project. */
export async function GET(request: Request, ctx: RouteContext<"/api/runs/[runId]/report">) {
  const actor = await getCurrentActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  const { runId } = await ctx.params;
  const notFound = () => new Response("Not found", { status: 404 });
  if (!idSchema.safeParse(runId).success) return notFound();

  const url = new URL(request.url);
  const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return new Response("Invalid parameters", { status: 400 });

  const data = await loadReportData(runId);
  if (!data) return notFound();
  const projectId = data.planVersion.suite.application.projectId;
  if (!can(actor.role, await getProjectRole(actor, projectId), "project.view")) return notFound();

  const filters = { status: query.data.status, feature: query.data.feature, priority: query.data.priority, regressionsOnly: query.data.regressions === "1" };
  await audit({ actor, action: "report.downloaded", entityType: "TestRun", entityId: runId, projectId, data: { format: query.data.format } });

  const name = `qa-report-${data.planVersion.suite.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40)}-v${data.planVersion.version}-${runId.slice(-6)}`;
  const common = { "x-content-type-options": "nosniff", "cache-control": "private, no-store" };
  if (query.data.format === "json") {
    return new Response(JSON.stringify(reportJson(data, url.origin, filters), null, 2), {
      headers: { ...common, "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${name}.json"` },
    });
  }
  return new Response(reportHtml(data, url.origin, filters), {
    headers: {
      ...common,
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.html"`,
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src ${url.origin}; sandbox`,
    },
  });
}
