"use client";

import { useCallback, useEffect, useState } from "react";

interface Opportunity {
  id: string;
  problem: string;
  searchDemand: string | null;
  buyerIntent: string | null;
  competitorWeakness: string | null;
  contentOpportunity: string | null;
  conversionOpportunity: string | null;
  referral: string | null;
  score: number;
  status: string;
  evidence: Record<string, unknown>;
}

interface Metrics {
  leads: number;
  qualified: number;
  sales: number;
  revenue: number;
  byLanding: Array<{ landingPage: string; leads: number; revenue: number }>;
  note: string;
}

export default function GrowthPage() {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const projectRes = await fetch("/api/projects", { cache: "no-store" });
    if (!projectRes.ok) return;
    const list = (await projectRes.json()).projects ?? [];
    setProjects(list.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })));
    setSelectedProject((current) => current || list[0]?.id || "");
  }, []);

  const loadData = useCallback(async (projectId: string) => {
    if (!projectId) return;
    const response = await fetch(`/api/growth?projectId=${projectId}`, { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      setOpportunities(data.opportunities ?? []);
      setMetrics(data.metrics ?? null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadData(selectedProject); }, [selectedProject, loadData]);

  async function buildPlan() {
    setBusy(true);
    setStatus("Building plan from persisted evidence…");
    try {
      const response = await fetch("/api/growth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: selectedProject }),
      });
      const payload = await response.json();
      setStatus(response.ok ? `Plan built: ${payload.created} new opportunity(ies).` : payload.error || "Failed");
      await loadData(selectedProject);
    } catch { setStatus("Could not reach the API."); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">SEARCHRANK OS</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">Business Growth Engine</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Customer problems, real search demand, buyer intent and competitor weaknesses mapped to content and conversion
            opportunities. Revenue is measured only from recorded conversions.
          </p>
        </div>
        <select className="input w-auto min-w-52 py-2 text-xs" value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
          <option value="">Select a project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </section>

      {status && <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-2 text-xs text-brand-300">{status}</div>}

      <div className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <h2 className="text-sm font-semibold">Growth opportunities</h2>
          <p className="mt-1 text-xs text-slate-500">
            Derived only from stored keywords, competitor gaps, questions and audited pages.
          </p>
        </div>
        <button className="btn btn-primary text-xs" disabled={busy || !selectedProject} onClick={buildPlan}>Build plan</button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card p-5"><p className="text-xs text-slate-500">Total leads</p><p className="metric-value mt-1 text-2xl font-bold text-brand-400">{metrics?.leads ?? 0}</p></div>
        <div className="card p-5"><p className="text-xs text-slate-500">Qualified leads</p><p className="metric-value mt-1 text-2xl font-bold text-blue-300">{metrics?.qualified ?? 0}</p></div>
        <div className="card p-5"><p className="text-xs text-slate-500">Sales</p><p className="metric-value mt-1 text-2xl font-bold text-slate-200">{metrics?.sales ?? 0}</p></div>
        <div className="card p-5"><p className="text-xs text-slate-500">Revenue</p><p className="metric-value mt-1 text-2xl font-bold text-amber-300">{metrics?.revenue ?? 0}</p></div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-slate-700/40 px-5 py-4"><h2 className="text-sm font-semibold">Opportunity map</h2></div>
        {opportunities.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">No opportunities yet. Build a plan from real keyword and competitor data first.</p>
        ) : (
          <ul className="max-h-[520px] divide-y divide-slate-700/30 overflow-auto">
            {opportunities.map((op) => (
              <li key={op.id} className="px-5 py-3">
                <button
                  className="flex w-full items-start justify-between gap-3 text-left"
                  onClick={() => setExpanded(expanded === op.id ? null : op.id)}
                >
                  <span className="text-xs text-slate-200">{op.problem}</span>
                  <span className={`badge ${op.score >= 60 ? "badge-ok" : op.score >= 40 ? "badge-warn" : "badge-muted"}`}>{op.score}</span>
                </button>
                {expanded === op.id && (
                  <div className="mt-3 grid gap-2 text-[11px] text-slate-400 sm:grid-cols-2">
                    <p><span className="text-slate-500">Demand:</span> {op.searchDemand ?? "—"}</p>
                    <p><span className="text-slate-500">Intent:</span> {op.buyerIntent ?? "—"}</p>
                    <p><span className="text-slate-500">Competitor weakness:</span> {op.competitorWeakness ?? "—"}</p>
                    <p><span className="text-slate-500">Referral:</span> {op.referral ?? "—"}</p>
                    <p className="sm:col-span-2"><span className="text-slate-500">Content:</span> {op.contentOpportunity ?? "—"}</p>
                    <p className="sm:col-span-2"><span className="text-slate-500">Conversion:</span> {op.conversionOpportunity ?? "—"}</p>
                    <pre className="sm:col-span-2 rounded bg-ink-950/70 p-2 text-[10px]">{JSON.stringify(op.evidence, null, 2)}</pre>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {metrics && metrics.byLanding.length > 0 && (
        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4">
            <h2 className="text-sm font-semibold">Revenue by landing page</h2>
            <p className="mt-1 text-xs text-slate-500">{metrics.note}</p>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500"><tr><th className="px-5 py-2">Landing page</th><th className="px-5 py-2">Leads</th><th className="px-5 py-2">Revenue</th></tr></thead>
            <tbody>
              {metrics.byLanding.map((row) => (
                <tr key={row.landingPage} className="table-row border-t border-slate-700/30">
                  <td className="px-5 py-2 text-slate-200">{row.landingPage}</td>
                  <td className="px-5 py-2 text-slate-400">{row.leads}</td>
                  <td className="px-5 py-2 text-amber-300">{row.revenue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
