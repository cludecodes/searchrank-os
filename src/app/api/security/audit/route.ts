import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { getBackupManifest, runSecurityAudit } from "@/core/security/backup";

export async function GET() {
  try {
    await requirePermission("project:read");
    const db = getDb();
    return Response.json({
      audit: await runSecurityAudit(db),
      backup: await getBackupManifest(db),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
