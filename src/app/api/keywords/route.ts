import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { keywordClusters, keywords, projects } from "@/core/db/schema";
import { classifyIntent } from "@/core/keywords/intelligence";

const manualSchema = z.object({
  projectId: z.uuid(),
  keyword: z.string().min(2).max(200),
  country: z.string().length(2).optional(),
  language: z.string().max(10).optional(),
  targetUrl: z.url().optional(),
  notes: z.string().max(1000).optional(),
});

export async function GET() {
  try {
    const context = await requirePermission("project:read");
    const db = getDb();
    const rows = await db
      .select({ keyword: keywords, clusterName: keywordClusters.name })
      .from(keywords)
      .innerJoin(projects, eq(keywords.projectId, projects.id))
      .leftJoin(keywordClusters, eq(keywords.clusterId, keywordClusters.id))
      .where(eq(projects.workspaceId, context.workspaceId))
      .orderBy(desc(keywords.priority))
      .limit(500);

    const { keywordHistory } = await import("@/core/db/schema");
    const history = await db
      .select({ keywordId: keywordHistory.keywordId, rank: keywordHistory.rank, recordedAt: keywordHistory.recordedAt })
      .from(keywordHistory);
    const byKeyword = new Map<string, typeof history>();
    for (const row of history) {
      const list = byKeyword.get(row.keywordId) ?? [];
      list.push(row);
      byKeyword.set(row.keywordId, list);
    }

    return Response.json({
      keywords: rows.map((row) => {
        const points = byKeyword.get(row.keyword.id) ?? [];
        const ordered = [...points].sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());
        const previous = ordered.length >= 2 ? ordered[ordered.length - 2].rank : null;
        const current = ordered.length >= 1 ? ordered[ordered.length - 1].rank : null;
        const trend = previous !== null && current !== null ? Number((current - previous).toFixed(2)) : null;
        return { ...row, clusterName: row.clusterName, rankTrend: trend, historyPoints: ordered.length };
      }),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Manual keyword fallback — no volume or difficulty is invented. */
export async function POST(request: Request) {
  try {
    const context = await requirePermission("keyword:write");
    const parsed = manualSchema.parse(await request.json());
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, parsed.projectId)).limit(1);
    if (!project || project.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    const intent = classifyIntent(parsed.keyword);
    const created = await db
      .insert(keywords)
      .values({
        projectId: project.id,
        keyword: parsed.keyword,
        country: parsed.country ?? project.country,
        language: parsed.language ?? project.language,
        intent,
        targetUrl: parsed.targetUrl ?? null,
        notes: parsed.notes ?? "Manually registered by an operator.",
        source: "manual",
        sourceUrl: null,
        retrievedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    if (!created.length) return Response.json({ error: "Keyword already exists for this country" }, { status: 409 });
    await writeAuditLog("keyword.created_manually", context, { keywordId: created[0].id, projectId: project.id });
    return Response.json({ keyword: created[0] }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
