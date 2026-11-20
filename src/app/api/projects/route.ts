import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { projects } from "@/core/db/schema";

const createSchema = z.object({
  name: z.string().min(2).max(160),
  domain: z.string().min(3).max(253).optional(),
  productionUrl: z.url().optional(),
  repositoryFullName: z.string().max(200).optional(),
  vercelProjectId: z.string().max(200).optional(),
  framework: z.string().max(80).optional(),
  description: z.string().max(2000).optional(),
  businessCategory: z.string().max(120).optional(),
  country: z.string().length(2).optional(),
  language: z.string().max(10).optional(),
});

function slugify(value: string): string {
  return `${value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}-${Date.now().toString(36)}`;
}

export async function GET() {
  try {
    const context = await requirePermission("project:read");
    const db = getDb();
    const list = await db
      .select()
      .from(projects)
      .where(eq(projects.workspaceId, context.workspaceId))
      .orderBy(desc(projects.updatedAt));
    return Response.json({ projects: list });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requirePermission("project:write");
    const parsed = createSchema.parse(await request.json());
    const db = getDb();
    const domain = parsed.domain ?? (parsed.productionUrl ? new URL(parsed.productionUrl).hostname : null);
    const created = await db
      .insert(projects)
      .values({
        workspaceId: context.workspaceId,
        name: parsed.name,
        slug: slugify(parsed.name),
        domain,
        productionUrl: parsed.productionUrl ?? null,
        repositoryFullName: parsed.repositoryFullName ?? null,
        vercelProjectId: parsed.vercelProjectId ?? null,
        framework: parsed.framework ?? null,
        description: parsed.description ?? null,
        businessCategory: parsed.businessCategory ?? null,
        country: parsed.country ?? "US",
        language: parsed.language ?? "en",
        status: parsed.productionUrl ? "active" : "discovered",
        discoveredBy: "manual",
      })
      .returning();
    await writeAuditLog("project.created", context, { projectId: created[0].id });
    return Response.json({ project: created[0] }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
