"use client";

import { useCallback, useEffect, useState } from "react";

interface Engine {
  provider: string;
  connected: boolean;
  sites: string[];
  error?: string;
}

interface Submission {
  id: string;
  engine: string;
  url: string;
  status: string;
  httpStatus: number | null;
  submittedAt: string;
}

interface Check {
  id: string;
  kind: string;
  status: string;
  checkedAt: string;
  detail: Record<string, unknown>;
}

interface Summary {
  engines: Engine[];
  metrics: Record<string, { clicks: number; impressions: number }>;
  submissions: Submission[];
  checks: Check[];
  edge: { clicks: number; impressions: number; note: string } | null;
  project: { id: string; name: string; productionUrl: string | null } | null;
}

export function SearchEnginePanel({ focus }: { focus: "google" | "bing" | "indexing" }) {
  const [data, setData] = useState<Summary | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/search-engines", { cache: "no-store" });
    if (response.ok) setData(await response.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!data?.project) return;
    setBusy(true);
    setStatus(`Queued ${action}…`);
    try {
      const response = await fetch("/api/search-engines/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: data.project.id, action, ...extra }),
      });
      const payload = await response.json();
      setStatus(response.ok ? `Job ${String(payload.jobId).slice(0, 8)} queued.` : payload.error || "Failed");
    } catch {
      setStatus("Could not reach the API.");
    } finally { setBusy(false); }
  }

  const title = focus === "google" ? "Google Search Console" : focus === "bing" ? "Bing Webmaster" : "Indexing Monitor";
  const engine = data?.engines.find((e) =>
    focus === "google" ? e.provider === "google_search_console" : e.provider === "bing_webmaster",
  );
  const relevantSubs = (data?.submissions ?? []).filter((s) =>
    focus === "google" ? s.engine.startsWith("google") : focus === "bing" ? s.engine.startsWith("bing") : true,
  );

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">SEARCHRANK OS</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-400">
          Real provider data and actions. Submission acceptance is never presented as an indexing guarantee.
        </p>
      </section>

      {status && <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-2 text-xs text-brand-300">{status}</div>}

      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Connection</h2>
            <p className="mt-1 text-xs text-slate-500">
              {engine ? (engine.connected ? `Connected · ${engine.sites.length} verified site(s)` : "Not connected") : "Loading…"}
              {engine?.error && ` · ${engine.error}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!engine?.connected && focus !== "indexing" && (
              <a className="btn btn-primary text-xs" href={`/api/integrations/${focus === "google" ? "google_search_console" : "bing_webmaster"}/start`}>
                Connect {focus === "google" ? "Google" : "Bing"}
              </a>
            )}
            <button className="btn btn-ghost text-xs" disabled={busy || !data?.project} onClick={() => act("sync")}>Sync performance</button>
            <button className="btn btn-ghost text-xs" disabled={busy || !data?.project} onClick={() => act("monitor")}>Check indexing issues</button>
            {focus === "google" && (
              <button className="btn btn-primary text-xs" disabled={busy || !data?.project}
                onClick={() => act("inspect", { url: data?.project?.productionUrl ?? "" })}>Inspect production URL</button>
            )}
            {focus === "bing" && (
              <button className="btn btn-primary text-xs" disabled={busy || !data?.project}
                onClick={() => act("submit-bing-urls")}>Submit verified URLs</button>
            )}
            {focus === "indexing" && (
              <button className="btn btn-primary text-xs" disabled={busy || !data?.project}
                onClick={() => act("submit-sitemap")}>Submit sitemap to both engines</button>
            )}
          </div>
        </div>
        {engine && engine.sites.length > 0 && (
          <ul className="mt-3 list-inside list-disc text-xs text-slate-400">
            {engine.sites.map((site) => <li key={site}>{site}</li>)}
          </ul>
        )}
        {!engine?.connected && focus === "google" && (
          <div className="mt-3 rounded-lg border border-brand-500/30 bg-brand-500/5 p-3 text-[11px] text-slate-300">
            <p className="font-semibold text-brand-300">Ready to connect</p>
            <p className="mt-1">
              Your OAuth client already has the correct redirect URI registered. Click <strong>Connect Google</strong>,
              sign in with the Google account that manages your Search Console properties, and approve the
              Search Console scopes. The connection is saved encrypted automatically.
            </p>
            <p className="mt-1 text-slate-500">
              Registered redirect URI: <code className="text-brand-300">https://searchrank-os.vercel.app/api/auth/google/callback</code>
            </p>
            <p className="mt-1 text-slate-500">
              If Google ever reports <code>redirect_uri_mismatch</code> or <code>access_denied</code>, confirm the URI above is
              on the OAuth client and that your Google account is an approved test user on the consent screen.
            </p>
          </div>
        )}
        {focus === "indexing" && data?.edge && (
          <div className="mt-4 rounded-lg border border-slate-700/40 p-3 text-xs text-slate-400">
            <p className="font-semibold text-slate-200">Microsoft Edge visibility (derived from Bing)</p>
            <p className="mt-1">Clicks: {data.edge.clicks} · Impressions: {data.edge.impressions}</p>
            <p className="mt-1 text-slate-500">{data.edge.note}</p>
          </div>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4"><h2 className="text-sm font-semibold">Search performance</h2></div>
          {data && Object.keys(data.metrics).length ? (
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500"><tr><th className="px-5 py-2">Source</th><th className="px-5 py-2">Clicks</th><th className="px-5 py-2">Impressions</th></tr></thead>
              <tbody>
                {Object.entries(data.metrics).map(([source, value]) => (
                  <tr key={source} className="table-row border-t border-slate-700/30">
                    <td className="px-5 py-2 text-slate-200">{source}</td>
                    <td className="px-5 py-2 text-slate-400">{value.clicks}</td>
                    <td className="px-5 py-2 text-slate-400">{value.impressions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="p-6 text-sm text-slate-500">No performance rows yet. Sync from a connected engine.</p>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4"><h2 className="text-sm font-semibold">Submissions & checks</h2></div>
          {relevantSubs.length === 0 && (data?.checks.length ?? 0) === 0 ? (
            <p className="p-6 text-sm text-slate-500">No submissions or issue checks recorded yet.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-slate-700/30 overflow-auto">
              {relevantSubs.map((sub) => (
                <li key={sub.id} className="flex items-center justify-between gap-3 px-5 py-2 text-xs">
                  <span className="max-w-xs truncate text-slate-300">{sub.engine}: {sub.url}</span>
                  <span className="flex items-center gap-2">
                    <span className={`badge ${sub.status === "accepted" ? "badge-ok" : "badge-muted"}`}>{sub.status}</span>
                    <span className="text-slate-500">{sub.submittedAt.slice(0, 10)}</span>
                  </span>
                </li>
              ))}
              {(data?.checks ?? []).map((check) => (
                <li key={check.id} className="flex items-center justify-between gap-3 px-5 py-2 text-xs">
                  <span className="text-slate-300">{check.kind} check</span>
                  <span className={`badge ${check.status === "ok" ? "badge-ok" : "badge-warn"}`}>{check.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
