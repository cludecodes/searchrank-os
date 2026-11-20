import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { oauthConfig, oauthCredentials, oauthRedirectUri } from "@/core/integrations/oauth";
import { randomToken } from "@/core/security/crypto";

type Params = { params: Promise<{ provider: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    await requirePermission("integration:write");
    const { provider } = await params;
    const config = oauthConfig(provider);
    if (!config) return Response.json({ error: "Unknown provider" }, { status: 404 });
    if (!config.isConfigured()) {
      return Response.json(
        { error: `${config.label} OAuth credentials are not configured. Add them to your environment first.` },
        { status: 400 },
      );
    }
    const { clientId } = oauthCredentials(config.provider);
    const state = randomToken(24);
    const redirectUri = oauthRedirectUri(config.provider, request.url);
    const url = config.authorize(clientId, redirectUri, state);
    const response = Response.redirect(url, 302);
    response.headers.append(
      "Set-Cookie",
      `sr_oauth_state=${config.provider}:${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
