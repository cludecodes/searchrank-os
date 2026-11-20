import { IntegrationHttpClient, buildAuthorizationUrl, exchangeAuthorizationCode, type FetchLike } from "./http";

export const BING_AUTHORIZE_URL = "https://www.bing.com/webmasters/oauth/authorize";
export const BING_TOKEN_URL = "https://www.bing.com/webmasters/oauth/token";
export const BING_API_BASE = "https://www.bing.com";
export const BING_SCOPE = "webmaster.manage";

export interface BingSite {
  Url?: string;
  SiteUrl?: string;
  IsVerified?: boolean;
  [key: string]: unknown;
}

/** Unwraps Bing's legacy JSON envelope (`{ d: ... }`). */
function unwrap<T>(payload: { d?: T } | T): T {
  if (payload && typeof payload === "object" && "d" in payload) {
    return (payload as { d: T }).d;
  }
  return payload as T;
}

export function buildBingOAuthUrl(clientId: string, redirectUri: string, state: string): string {
  return buildAuthorizationUrl(BING_AUTHORIZE_URL, {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: BING_SCOPE,
  });
}

export async function exchangeBingCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike = globalThis.fetch,
) {
  return exchangeAuthorizationCode(
    BING_TOKEN_URL,
    {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
    fetchImpl,
  );
}

export class BingWebmasterClient {
  private readonly http: IntegrationHttpClient;

  constructor(options: { accessToken: string; fetchImpl?: FetchLike }) {
    this.http = new IntegrationHttpClient({
      provider: "bing_webmaster",
      baseURL: BING_API_BASE,
      accessToken: options.accessToken,
      fetchImpl: options.fetchImpl,
      extraHeaders: { Accept: "application/json" },
    });
  }

  async listSites(): Promise<BingSite[]> {
    const data = await this.http.request<{ d?: BingSite[] } | BingSite[]>({
      path: "/webmaster/api.svc/json/GetUserSites",
    });
    return unwrap<BingSite[]>(data) ?? [];
  }

  /** Real query traffic statistics. Bing returns position, not search volume. */
  async getQueryStats(siteUrl: string): Promise<Array<{
    Query?: string;
    Clicks?: number;
    Impressions?: number;
    AvgClickPosition?: number;
    AvgImpressionPosition?: number;
    Date?: string;
  }>> {
    const data = await this.http.request<{ d?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>({
      path: "/webmaster/api.svc/json/GetQueryStats",
      query: { siteUrl },
    });
    const rows = unwrap<Array<Record<string, unknown>>>(data) ?? [];
    return rows.map((row) => ({
      Query: row.Query as string | undefined,
      Clicks: row.Clicks as number | undefined,
      Impressions: row.Impressions as number | undefined,
      AvgClickPosition: row.AvgClickPosition as number | undefined,
      AvgImpressionPosition: row.AvgImpressionPosition as number | undefined,
      Date: row.Date as string | undefined,
    }));
  }

  /** Real crawl/indexing issues reported by Bing Webmaster Tools. */
  async getCrawlIssues(siteUrl: string): Promise<Array<Record<string, unknown>>> {
    const data = await this.http.request<{ d?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>({
      path: "/webmaster/api.svc/json/GetCrawlIssues",
      query: { siteUrl },
    });
    return unwrap<Array<Record<string, unknown>>>(data) ?? [];
  }

  async getUrlSubmissionQuota(siteUrl: string): Promise<{ DailyQuota?: number; MonthlyQuota?: number }> {
    const data = await this.http.request<{ d?: { DailyQuota?: number; MonthlyQuota?: number } }>({
      path: "/webmaster/api.svc/json/GetUrlSubmissionQuota",
      query: { siteUrl },
    });
    return unwrap(data) ?? {};
  }

  /** Requests Bing to crawl a batch of URLs (quota applies; indexing is not guaranteed). */
  async submitUrls(siteUrl: string, urls: string[]): Promise<unknown> {
    const list = urls.slice(0, 500);
    if (!list.length) return null;
    const data = await this.http.request<{ d?: unknown } | unknown>({
      method: "POST",
      path: "/webmaster/api.svc/json/SubmitUrlBatch",
      body: { siteUrl, urlList: list },
    });
    return unwrap(data);
  }

  async submitSitemap(siteUrl: string, feedUrl: string): Promise<unknown> {
    const data = await this.http.request<{ d?: unknown } | unknown>({
      method: "POST",
      path: "/webmaster/api.svc/json/SubmitFeed",
      body: { siteUrl, feedUrl },
    });
    return unwrap(data);
  }
}
