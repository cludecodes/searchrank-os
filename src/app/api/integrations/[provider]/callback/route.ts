import { cookies } from "next/headers";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { saveIntegration } from "@/core/integrations/credentials";
import { oauthConfig, oauthCredentials, oauthRedirectUri } from "@/core/integrations/oauth";
import { safeEqual } from "@/core/security/crypto";

type Params = { params: Promise<{ provider: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const context = await requirePermission("integration:write");
    const { provider } = await params;
    const config = oauthConfig(provider);
    if (!config) return Response.json({ error: "Unknown provider" }, { status: 404 });

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const errorParam = url.searchParams.get("error");
    const state = url.searchParams.get("state") ?? "";
    const cookieStore = await cookies();
    const expected = cookieStore.get("sr_oauth_state")?.value ?? "";
    const [cookieProvider, cookieState] = expected.split(":");
    if (errorParam || !code || cookieProvider !== provider || !cookieState || !safeEqual(cookieState, state)) {
      return Response.redirect(new URL(`/dashboard/integrations?error=${encodeURIComponent(errorParam ?? "invalid_state")}`, request.url), 302);
    }

    const { clientId, clientSecret } = oauthCredentials(config.provider);
    const tokens = await config.exchange(clientId, clientSecret, code, oauthRedirectUri(config.provider, request.url));
    await saveIntegration(getDb(), {
      workspaceId: context.workspaceId,
      provider: config.provider,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      accountIdentifier: "default",
      displayName: config.label,
      scopes: tokens.scope?.split(/\s+/) ?? config.scopes,
      expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
      metadata: { connectedAt: new Date().toISOString() },
    });

    // Response.redirect() has immutable headers; build the response with the
    // cookie already in place so the one-time state is cleared safely.
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL(`/dashboard/integrations?connected=${provider}`, request.url).toString(),
        "Set-Cookie": "sr_oauth_state=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
