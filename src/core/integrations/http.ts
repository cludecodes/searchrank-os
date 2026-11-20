export type FetchLike = typeof globalThis.fetch;

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  retries?: number;
}

export interface IntegrationClientOptions {
  provider: string;
  baseURL: string;
  accessToken: string;
  fetchImpl?: FetchLike;
  extraHeaders?: Record<string, string>;
}

/** Thin, testable HTTP client with bearer auth, bounded retries and typed errors. */
export class IntegrationHttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly extraHeaders: Record<string, string>;

  constructor(private readonly options: IntegrationClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const maxRetries = options.retries ?? 2;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const url = new URL(options.path.replace(/^\//, ""), this.options.baseURL.replace(/\/?$/, "/"));
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }

      const response = await this.fetchImpl(url.toString(), {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.accessToken}`,
          ...this.extraHeaders,
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as T;
      }

      const retryable = response.status === 429 || response.status >= 500;
      const retryAfter = Number(response.headers?.get?.("retry-after") ?? 0);
      const bodyText = await response.text().catch(() => "");
      lastError = new IntegrationError(
        `${this.options.provider} request failed: ${response.status} ${bodyText.slice(0, 400)}`,
        this.options.provider,
        response.status,
        bodyText,
      );
      if (!retryable || attempt === maxRetries) break;
      // Deterministic bounded backoff; tests inject a fetch that avoids real waits.
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 4000) + retryAfter * 1000));
    }
    throw lastError ?? new Error("Request failed");
  }
}

export function appendQuery(base: string, query: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function buildAuthorizationUrl(
  endpoint: string,
  params: Record<string, string>,
): string {
  return appendQuery(endpoint, params);
}

export async function exchangeAuthorizationCode(
  tokenEndpoint: string,
  params: Record<string, string>,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }> {
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new IntegrationError(
      `OAuth token exchange failed: ${response.status} ${await response.text()}`,
      "oauth",
      response.status,
    );
  }
  const data = (await response.json()) as Record<string, unknown>;
  const accessToken = data.access_token ?? data.accessToken;
  if (typeof accessToken !== "string") {
    throw new IntegrationError("OAuth response contained no access token.", "oauth");
  }
  return {
    accessToken,
    refreshToken: (data.refresh_token ?? data.refreshToken) as string | undefined,
    expiresIn: data.expires_in as number | undefined,
    scope: data.scope as string | undefined,
  };
}
