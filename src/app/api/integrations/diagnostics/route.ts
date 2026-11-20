import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { getIntegration } from "@/core/integrations/credentials";
import { OAUTH_PROVIDERS } from "@/core/integrations/oauth";
import type { IntegrationProvider } from "@/core/db/schema";

/** Shows exactly which redirect URI the app sends and which credentials exist.
 *  Never returns secret values. */
export async function GET() {
  try {
    const context = await requirePermission("project:read");
    const db = getDb();
    const envCallbacks: Record<string, string | undefined> = {
      github: process.env.GITHUB_CALLBACK_URL,
      vercel: process.env.VERCEL_CALLBACK_URL,
      google_search_console: process.env.GOOGLE_CALLBACK_URL,
      bing_webmaster: process.env.MICROSOFT_CALLBACK_URL,
    };
    const providers = await Promise.all(
      Object.values(OAUTH_PROVIDERS).map(async (config) => {
        const stored = await getIntegration(db, context.workspaceId, config.provider as IntegrationProvider);
        return {
          provider: config.provider,
          label: config.label,
          oauthAppConfigured: config.isConfigured(),
          callbackUrl: envCallbacks[config.provider] ?? null,
          connected: Boolean(stored?.encryptedAccessToken),
          connectionMethod: stored ? ((stored.metadata as { method?: string })?.method ?? "oauth") : null,
          status: stored?.status ?? null,
        };
      }),
    );
    return Response.json({ providers });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
