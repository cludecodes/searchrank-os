import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { projects, seoArtifacts } from "@/core/db/schema";
import { enqueueJob } from "@/core/jobs/queue";

const generateSchema = z.object({ projectId: z.uuid() });
const decideSchema = z.object({ id: z.uuid(), decision: z.enum(["approve", "reject"]) });

export async function GET() {
  try {
    const context = await requirePermission("project:read");
    const list = await getDb()
      .select({ artifact: seoArtifacts, projectName: projects.name })
      .from(seoArtifacts)
      .innerJoin(projects, eq(seoArtifacts.projectId, projects.id))
      .where(eq(projects.workspaceId, context.workspaceId))
      .orderBy(desc(seoArtifacts.createdAt))
      .limit(100);
    return Response.json({ artifacts: list });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Enqueues generation — artifacts are proposals, never applied automatically. */
export async function POST(request: Request) {
  try {
    const context = await requirePermission("project:write");
    const parsed = generateSchema.parse(await request.json());
    const [project] = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.id, parsed.projectId))
      .limit(1);
    if (!project || project.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    const job = await enqueueJob(getDb(), {
      type: "seo.artifacts.generate",
      payload: { mode: "generate-artifacts" },
      workspaceId: context.workspaceId,
      projectId: project.id,
      createdBy: context.user.id,
      priority: "normal",
    });
    return Response.json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await requirePermission("content:approve");
    const parsed = decideSchema.parse(await request.json());
    const db = getDb();
    const [artifact] = await db.select().from(seoArtifacts).where(eq(seoArtifacts.id, parsed.id)).limit(1);
    if (!artifact) return Response.json({ error: "Artifact not found" }, { status: 404 });
    const updated = await db
      .update(seoArtifacts)
      .set({
        status: parsed.decision === "approve" ? "approved" : "rejected",
        reviewedBy: context.user.id,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(seoArtifacts.id, parsed.id))
      .returning();
    await writeAuditLog("seo.artifact.decided", context, {
      artifactId: parsed.id,
      decision: parsed.decision,
      path: artifact.path,
    });
    return Response.json({ artifact: updated[0] });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
