import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { saveIntegration } from "@/core/integrations/credentials";
import { OAUTH_PROVIDERS } from "@/core/integrations/oauth";
import type { IntegrationProvider } from "@/core/db/schema";

const schema = z.object({
  provider: z.enum(["github", "vercel", "google_search_console", "bing_webmaster"]),
  accessToken: z.string().min(10, "Provide a real access token."),
  refreshToken: z.string().optional(),
  accountIdentifier: z.string().max(200).optional(),
});

/** Manual credential connection for cases where an OAuth redirect URI cannot
 *  be registered. Tokens are encrypted at rest and never returned. */
export async function POST(request: Request) {
  try {
    const context = await requirePermission("integration:write");
    const parsed = schema.parse(await request.json());
    const config = OAUTH_PROVIDERS[parsed.provider as IntegrationProvider];
    const saved = await saveIntegration(getDb(), {
      workspaceId: context.workspaceId,
      provider: parsed.provider,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? null,
      accountIdentifier: parsed.accountIdentifier ?? "manual",
      displayName: `${config.label} (manual)`,
      scopes: config.scopes,
      metadata: { connectedAt: new Date().toISOString(), method: "manual_token" },
    });
    await writeAuditLog("integration.connected_manually", context, {
      provider: parsed.provider,
      integrationId: saved.id,
    });
    return Response.json({ ok: true, provider: saved.provider, status: saved.status }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
