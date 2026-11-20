import { desc, eq } from "drizzle-orm";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { monitoringChecks, projects, searchMetrics } from "@/core/db/schema";
import { edgeVisibility, getEngineSites, recentSubmissions } from "@/core/search-engines/service";

export async function GET() {
  try {
    const context = await requirePermission("project:read");
    const db = getDb();
    const [project] = await db.select().from(projects)
      .where(eq(projects.workspaceId, context.workspaceId))
      .orderBy(desc(projects.updatedAt))
      .limit(1);

    const engines = await getEngineSites(db, context.workspaceId);
    const metrics = await db
      .select({ source: searchMetrics.source, clicks: searchMetrics.clicks, impressions: searchMetrics.impressions })
      .from(searchMetrics)
      .innerJoin(projects, eq(searchMetrics.projectId, projects.id))
      .where(eq(projects.workspaceId, context.workspaceId))
      .limit(500);

    const bySource = metrics.reduce<Record<string, { clicks: number; impressions: number }>>((acc, row) => {
      const entry = acc[row.source] ?? { clicks: 0, impressions: 0 };
      entry.clicks += row.clicks ?? 0;
      entry.impressions += row.impressions ?? 0;
      acc[row.source] = entry;
      return acc;
    }, {});

    const checks = project
      ? await db.select().from(monitoringChecks).where(eq(monitoringChecks.projectId, project.id))
          .orderBy(desc(monitoringChecks.checkedAt)).limit(30)
      : [];
    const submissions = project ? await recentSubmissions(db, project.id) : [];
    const edge = project ? await edgeVisibility(db, project.id) : null;

    return Response.json({
      engines,
      metrics: bySource,
      checks,
      submissions,
      edge,
      project: project ? { id: project.id, name: project.name, productionUrl: project.productionUrl } : null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
