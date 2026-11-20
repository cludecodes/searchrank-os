import type { FetchLike } from "./http";

export const INDEXNOW_ENDPOINTS: Record<string, string> = {
  bing: "https://www.bing.com/indexnow",
  yandex: "https://yandex.com/indexnow",
  seznam: "https://search.seznam.cz/indexnow",
};

export interface IndexNowSubmission {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

export interface IndexNowResult {
  engine: string;
  httpStatus: number;
  accepted: boolean;
  body: string;
  endpoint: string;
}

/**
 * Notifies participating search engines about new or changed URLs.
 * A 200/202 response means the key was valid and the request was accepted —
 * it is NOT a guarantee of crawling or indexing.
 */
export async function submitToIndexNow(
  submission: IndexNowSubmission,
  engines: string[] = ["bing"],
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<IndexNowResult[]> {
  const { host, key, keyLocation, urlList } = submission;
  if (!host || !key || !keyLocation) {
    throw new Error("IndexNow requires host, key and a publicly reachable keyLocation.");
  }
  if (!urlList.length) return [];

  const results: IndexNowResult[] = [];
  for (const engine of engines) {
    const endpoint = INDEXNOW_ENDPOINTS[engine];
    if (!endpoint) throw new Error(`Unsupported IndexNow engine: ${engine}`);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation, urlList: urlList.slice(0, 10_000) }),
    });
    const body = await response.text();
    results.push({
      engine,
      httpStatus: response.status,
      accepted: response.ok,
      body,
      endpoint,
    });
  }
  return results;
}
