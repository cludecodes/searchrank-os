"use client";

import { useCallback, useEffect, useState } from "react";

interface KeywordView {
  id: string;
  keyword: { id: string; keyword: string; country: string; language: string; intent: string | null; searchVolume: number | null; keywordDifficulty: number | null; commercialRelevance: number | null; priority: number; currentRank: number | null; source: string | null; retrievedAt: string | null; targetUrl: string | null; competitorUrls: string[]; notes: string | null };
  clusterName: string | null;
  rankTrend: number | null;
  historyPoints: number;
}

interface ClusterView {
  cluster: { id: string; name: string; description: string | null; targetUrl: string | null };
  projectName: string;
  keywordCount: number;
}

export default function KeywordsPage() {
  const [keywords, setKeywords] = useState<KeywordView[]>([]);
  const [clusters, setClusters] = useState<ClusterView[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [newKeyword, setNewKeyword] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [kwRes, clusterRes, projectRes] = await Promise.all([
      fetch("/api/keywords", { cache: "no-store" }),
      fetch("/api/keywords/clusters", { cache: "no-store" }),
      fetch("/api/projects", { cache: "no-store" }),
    ]);
    if (kwRes.ok) setKeywords((await kwRes.json()).keywords ?? []);
    if (clusterRes.ok) setClusters((await clusterRes.json()).clusters ?? []);
    if (projectRes.ok) {
      const list = (await projectRes.json()).projects ?? [];
      setProjects(list.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })));
      setSelectedProject((current) => current || list[0]?.id || "");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function post(url: string, body: Record<string, unknown>, label: string) {
    setBusy(true);
    setStatus(`${label}…`);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      setStatus(response.ok ? `${label} queued/saved (${String(payload.jobId ?? payload.keyword?.id ?? "").slice(0, 8)}).` : payload.error || "Failed");
      if (response.ok) { setNewKeyword(""); await load(); }
    } catch {
      setStatus("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">SEARCHRANK OS</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">Keyword Intelligence</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Real query data from connected search engines with source and retrieval date. Volume and difficulty stay
            empty when no provider supplies them — nothing is estimated.
          </p>
        </div>
        <select className="input w-auto min-w-52 py-2 text-xs" value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
          <option value="">Select a project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </section>

      {status && <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-2 text-xs text-brand-300">{status}</div>}

      <div className="card flex flex-wrap items-end gap-3 p-5">
        <div className="min-w-52 flex-1">
          <p className="mb-1.5 text-xs font-medium text-slate-400">Run research from connected sources</p>
          <button className="btn btn-primary text-xs" disabled={busy || !selectedProject}
            onClick={() => post("/api/keywords/research", { projectId: selectedProject }, "Research job")}>Run keyword research</button>
        </div>
        <div className="min-w-64 flex-1">
          <p className="mb-1.5 text-xs font-medium text-slate-400">Manual keyword fallback</p>
          <div className="flex gap-2">
            <input className="input text-xs" value={newKeyword} onChange={(e) => setNewKeyword(e.target.value)} placeholder="e.g. emergency plumber london" />
            <button className="btn btn-ghost text-xs" disabled={busy || !selectedProject || !newKeyword}
              onClick={() => post("/api/keywords", { projectId: selectedProject, keyword: newKeyword }, "Keyword")}>Add</button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card p-4"><p className="text-xs text-slate-500">Keyword records</p><p className="metric-value mt-1 text-2xl font-bold text-brand-400">{keywords.length}</p></div>
        <div className="card p-4"><p className="text-xs text-slate-500">Clusters</p><p className="metric-value mt-1 text-2xl font-bold text-blue-300">{clusters.length}</p></div>
        <div className="card p-4"><p className="text-xs text-slate-500">High priority (≥60)</p><p className="metric-value mt-1 text-2xl font-bold text-amber-300">{keywords.filter((k) => k.keyword.priority >= 60).length}</p></div>
        <div className="card p-4"><p className="text-xs text-slate-500">With rank history</p><p className="metric-value mt-1 text-2xl font-bold text-slate-200">{keywords.filter((k) => k.historyPoints > 0).length}</p></div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-slate-700/40 px-5 py-4"><h2 className="text-sm font-semibold">Keyword records</h2></div>
        {keywords.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">No keywords stored yet. Connect Google Search Console/Bing or add one manually.</p>
        ) : (
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="px-4 py-2">Keyword</th><th className="px-4 py-2">Country</th><th className="px-4 py-2">Intent</th>
                  <th className="px-4 py-2">Target landing page</th><th className="px-4 py-2">Rank</th><th className="px-4 py-2">Trend</th>
                  <th className="px-4 py-2">Priority</th><th className="px-4 py-2">Volume / Difficulty</th><th className="px-4 py-2">Source</th><th className="px-4 py-2">Retrieved</th>
                </tr>
              </thead>
              <tbody>
                {keywords.map((row) => {
                  const k = row.keyword;
                  return (
                    <tr key={k.id} className="table-row border-t border-slate-700/30 align-top">
                      <td className="max-w-xs px-4 py-2 text-slate-200"><span className="block truncate">{k.keyword}</span>{k.notes && <span className="block text-[10px] text-amber-300">{k.notes}</span>}</td>
                      <td className="px-4 py-2 text-slate-400">{k.country}</td>
                      <td className="px-4 py-2 text-slate-400">{k.intent ?? "—"}</td>
                      <td className="max-w-[180px] truncate px-4 py-2 text-slate-400">{k.targetUrl ?? "—"}</td>
                      <td className="px-4 py-2 text-slate-300">{k.currentRank ?? "—"}</td>
                      <td className="px-4 py-2">{row.rankTrend === null ? "—" : <span className={row.rankTrend <= 0 ? "text-brand-400" : "text-red-300"}>{row.rankTrend}</span>}</td>
                      <td className="px-4 py-2"><span className={`badge ${k.priority >= 60 ? "badge-ok" : k.priority >= 30 ? "badge-warn" : "badge-muted"}`}>{k.priority}</span></td>
                      <td className="px-4 py-2 text-slate-500">{k.searchVolume ?? "—"} / {k.keywordDifficulty ?? "—"}</td>
                      <td className="px-4 py-2 text-slate-400">{k.source ?? "—"}</td>
                      <td className="px-4 py-2 text-slate-500">{k.retrievedAt ? k.retrievedAt.slice(0, 10) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-slate-700/40 px-5 py-4"><h2 className="text-sm font-semibold">Country / intent clusters</h2></div>
        {clusters.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">No clusters yet — they are built from researched keywords.</p>
        ) : (
          <ul className="divide-y divide-slate-700/30">
            {clusters.map((c) => (
              <li key={c.cluster.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-xs">
                <div>
                  <p className="font-semibold text-slate-200">{c.cluster.name} <span className="text-slate-500">· {c.projectName}</span></p>
                  <p className="mt-1 text-slate-400">{c.cluster.description}</p>
                </div>
                <span className="badge badge-info">{c.keywordCount} keyword(s)</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
