import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { OAUTH_PROVIDERS, oauthCredentials } from "@/core/integrations/oauth";
import { randomToken } from "@/core/security/crypto";

/** Google OAuth entry point for app sign-in (purpose=login) or Search Console
 *  connection (purpose=gsc). Both share the same registered redirect URI. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const purpose = url.searchParams.get("purpose") === "gsc" ? "gsc" : "login";
    const config = OAUTH_PROVIDERS.google_search_console;
    if (!config.isConfigured()) {
      return Response.json({ error: "Google OAuth credentials are not configured" }, { status: 400 });
    }
    const { clientId } = oauthCredentials("google_search_console");

    const scope = purpose === "login"
      ? "openid email profile"
      : "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/webmasters";
    const state = randomToken(24);
    const redirectUri = process.env.GOOGLE_CALLBACK_URL || `${url.origin}/api/auth/google/callback`;
    const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", scope);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("access_type", "offline");
    authorizeUrl.searchParams.set("prompt", "consent");

    // GSC requires an authenticated platform session; login does not.
    if (purpose === "gsc") await requirePermission("integration:write");

    const cookie = `sr_oauth_state=${purpose}:google:${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
    return new Response(null, {
      status: 302,
      headers: { Location: authorizeUrl.toString(), "Set-Cookie": cookie },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
