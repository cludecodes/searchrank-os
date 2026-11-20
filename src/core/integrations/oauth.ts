import type { IntegrationProvider } from "../db/schema";
import {
  buildGitHubOAuthUrl,
  exchangeGitHubCode,
  GITHUB_OAUTH_SCOPES,
} from "./github";
import {
  buildVercelOAuthUrl,
  exchangeVercelCode,
  VERCEL_OAUTH_SCOPES,
} from "./vercel";
import { buildGoogleOAuthUrl, exchangeGoogleCode, GSC_SCOPES } from "./google-search-console";
import { buildBingOAuthUrl, exchangeBingCode, BING_SCOPE } from "./bing-webmaster";

export interface OAuthProviderConfig {
  provider: IntegrationProvider;
  label: string;
  authorize: (clientId: string, redirectUri: string, state: string) => string;
  exchange: (clientId: string, clientSecret: string, code: string, redirectUri: string) => Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    scope?: string;
  }>;
  isConfigured: () => boolean;
  scopes: string[];
}

export const OAUTH_PROVIDERS: Record<IntegrationProvider, OAuthProviderConfig> = {
  github: {
    provider: "github",
    label: "GitHub",
    authorize: buildGitHubOAuthUrl,
    exchange: (id, secret, code) => exchangeGitHubCode(id, secret, code),
    isConfigured: () => Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    scopes: GITHUB_OAUTH_SCOPES,
  },
  vercel: {
    provider: "vercel",
    label: "Vercel",
    authorize: buildVercelOAuthUrl,
    exchange: (id, secret, code, redirect) => exchangeVercelCode(id, secret, code, redirect),
    isConfigured: () => Boolean(process.env.VERCEL_CLIENT_ID && process.env.VERCEL_CLIENT_SECRET),
    scopes: VERCEL_OAUTH_SCOPES,
  },
  google_search_console: {
    provider: "google_search_console",
    label: "Google Search Console",
    authorize: buildGoogleOAuthUrl,
    exchange: (id, secret, code, redirect) => exchangeGoogleCode(id, secret, code, redirect),
    isConfigured: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    scopes: GSC_SCOPES,
  },
  bing_webmaster: {
    provider: "bing_webmaster",
    label: "Bing Webmaster",
    authorize: buildBingOAuthUrl,
    exchange: (id, secret, code, redirect) => exchangeBingCode(id, secret, code, redirect),
    isConfigured: () => Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET),
    scopes: [BING_SCOPE],
  },
};

export function oauthConfig(provider: string): OAuthProviderConfig | null {
  return OAUTH_PROVIDERS[provider as IntegrationProvider] ?? null;
}

export function oauthRedirectUri(provider: IntegrationProvider, requestUrl: string): string {
  const envKey: Record<IntegrationProvider, string | undefined> = {
    github: process.env.GITHUB_CALLBACK_URL,
    vercel: process.env.VERCEL_CALLBACK_URL,
    google_search_console: process.env.GOOGLE_CALLBACK_URL,
    bing_webmaster: process.env.MICROSOFT_CALLBACK_URL,
  };
  if (envKey[provider]) return envKey[provider]!;
  const url = new URL(requestUrl);
  return `${url.origin}/api/integrations/${provider}/callback`;
}

export function oauthCredentials(provider: IntegrationProvider): { clientId: string; clientSecret: string } {
  const values: Record<IntegrationProvider, [string | undefined, string | undefined]> = {
    github: [process.env.GITHUB_CLIENT_ID, process.env.GITHUB_CLIENT_SECRET],
    vercel: [process.env.VERCEL_CLIENT_ID, process.env.VERCEL_CLIENT_SECRET],
    google_search_console: [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET],
    bing_webmaster: [process.env.MICROSOFT_CLIENT_ID, process.env.MICROSOFT_CLIENT_SECRET],
  };
  const [clientId, clientSecret] = values[provider];
  if (!clientId || !clientSecret) throw new Error(`${provider} OAuth credentials are not configured`);
  return { clientId, clientSecret };
}
