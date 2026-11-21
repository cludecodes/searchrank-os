import { z } from "zod";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { buildExecutiveReport, generateAndStoreReport } from "@/core/reporting/executive-reports";

const schema = z.object({ days: z.number().int().min(1).max(90).optional(), store: z.boolean().optional() });

export async function GET(request: Request) {
  try {
    const context = await requirePermission("report:read");
    const days = Number(new URL(request.url).searchParams.get("days") ?? 7);
    const report = await buildExecutiveReport(getDb(), context.workspaceId, { days });
    return Response.json({ report });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requirePermission("report:read");
    const parsed = schema.parse(await request.json());
    const result = await generateAndStoreReport(getDb(), context.workspaceId, { days: parsed.days ?? 7 });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
