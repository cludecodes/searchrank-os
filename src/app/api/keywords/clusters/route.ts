import { desc, eq, sql } from "drizzle-orm";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { keywordClusters, keywords, projects } from "@/core/db/schema";

export async function GET() {
  try {
    const context = await requirePermission("project:read");
    const rows = await getDb()
      .select({
        cluster: keywordClusters,
        projectName: projects.name,
        keywordCount: sql<number>`count(${keywords.id})::int`,
      })
      .from(keywordClusters)
      .innerJoin(projects, eq(keywordClusters.projectId, projects.id))
      .leftJoin(keywords, eq(keywords.clusterId, keywordClusters.id))
      .where(eq(projects.workspaceId, context.workspaceId))
      .groupBy(keywordClusters.id, projects.name)
      .orderBy(desc(keywordClusters.createdAt))
      .limit(100);
    return Response.json({ clusters: rows });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
