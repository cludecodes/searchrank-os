import { cookies } from "next/headers";
import { apiErrorResponse, requirePermission } from "../auth/request";
import { getDb } from "../db/client";
import { saveIntegration } from "./credentials";
import { oauthConfig, oauthCredentials, oauthRedirectUri } from "./oauth";
import { safeEqual } from "../security/crypto";

/** Maps legacy/alternative callback slugs to canonical provider keys. */
export function normalizeProviderSlug(slug: string): string {
  const aliases: Record<string, string> = {
    github: "github",
    vercel: "vercel",
    google: "google_search_console",
    google_search_console: "google_search_console",
    microsoft: "bing_webmaster",
    bing: "bing_webmaster",
    bing_webmaster: "bing_webmaster",
  };
  return aliases[slug] ?? slug;
}

/** Single OAuth callback implementation shared by all callback URL shapes. */
export async function handleOAuthCallback(request: Request, slug: string): Promise<Response> {
  try {
    const context = await requirePermission("integration:write");
    const provider = normalizeProviderSlug(slug);
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
      const destination = new URL("/dashboard/integrations", request.url);
      destination.searchParams.set("error", errorParam ?? "invalid_state");
      return new Response(null, { status: 302, headers: { Location: destination.toString() } });
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
      metadata: { connectedAt: new Date().toISOString(), callbackPath: new URL(request.url).pathname },
    });

    // Response.redirect() has immutable headers; build the response with the
    // cookie already in place so the one-time state is cleared safely.
    const destination = new URL("/dashboard/integrations", request.url);
    destination.searchParams.set("connected", provider);
    return new Response(null, {
      status: 302,
      headers: {
        Location: destination.toString(),
        "Set-Cookie": "sr_oauth_state=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
