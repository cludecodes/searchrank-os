"use client";

import { useCallback, useEffect, useState } from "react";

interface ReportData {
  periodStart: string;
  periodEnd: string;
  workCompleted: Record<string, number>;
  issuesDiscovered: Record<string, number>;
  issuesResolved: Record<string, number>;
  movements: {
    clicks: number;
    previousClicks: number;
    clicksChangePct: number | null;
    impressions: number;
    previousImpressions: number;
    top3: number;
    top10: number;
  };
  conversions: { leads: number; qualified: number; revenue: number };
  nextActions: string[];
  note: string;
}

export default function ReportsPage() {
  const [report, setReport] = useState<ReportData | null>(null);
  const [days, setDays] = useState(7);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/reports/executive?days=${days}`, { cache: "no-store" });
    if (response.ok) setReport((await response.json()).report);
  }, [days]);

  useEffect(() => { load(); }, [load]);

  async function store() {
    setBusy(true);
    try {
      const response = await fetch("/api/reports/executive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      setStatus(response.ok ? "Executive report saved to the archive." : "Failed to save report.");
      if (response.ok) await load();
    } catch { setStatus("Could not reach the API."); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">SEARCHRANK OS</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">Executive Reports</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Work completed, issues found and resolved, ranking movements, traffic changes, conversions and next actions —
            all computed from persisted data.
          </p>
        </div>
        <div className="flex gap-2">
          <select className="input w-auto py-2 text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button className="btn btn-primary text-xs" disabled={busy} onClick={store}>Save report</button>
        </div>
      </section>

      {status && <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-2 text-xs text-brand-300">{status}</div>}

      {!report ? (
        <div className="card p-6 text-sm text-slate-500">Loading report…</div>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="card p-5"><p className="text-xs text-slate-500">Period</p><p className="mt-1 text-sm font-semibold text-slate-200">{report.periodStart} → {report.periodEnd}</p></div>
            <div className="card p-5"><p className="text-xs text-slate-500">Clicks</p><p className="metric-value mt-1 text-2xl font-bold text-brand-400">{report.movements.clicks}</p><p className="text-[11px] text-slate-500">Prior: {report.movements.previousClicks} · {report.movements.clicksChangePct ?? "—"}%</p></div>
            <div className="card p-5"><p className="text-xs text-slate-500">Impressions</p><p className="metric-value mt-1 text-2xl font-bold text-blue-300">{report.movements.impressions}</p><p className="text-[11px] text-slate-500">Prior: {report.movements.previousImpressions}</p></div>
            <div className="card p-5"><p className="text-xs text-slate-500">Revenue</p><p className="metric-value mt-1 text-2xl font-bold text-amber-300">{report.conversions.revenue}</p><p className="text-[11px] text-slate-500">{report.conversions.leads} leads · {report.conversions.qualified} qualified</p></div>
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            <div className="card p-6">
              <h2 className="text-sm font-semibold">Work completed</h2>
              <ul className="mt-4 space-y-2 text-xs text-slate-400">
                {Object.entries(report.workCompleted).map(([key, value]) => (
                  <li key={key} className="flex justify-between"><span className="capitalize">{key.replace(/([A-Z])/g, " $1")}</span><span className="font-semibold text-slate-200">{value}</span></li>
                ))}
              </ul>
            </div>
            <div className="card p-6">
              <h2 className="text-sm font-semibold">Issues discovered / resolved</h2>
              <ul className="mt-4 space-y-2 text-xs text-slate-400">
                {Object.entries(report.issuesDiscovered).map(([key, value]) => (
                  <li key={key} className="flex justify-between"><span className="capitalize">{key.replace(/([A-Z])/g, " $1")}</span><span className="font-semibold text-amber-300">{value}</span></li>
                ))}
                {Object.entries(report.issuesResolved).map(([key, value]) => (
                  <li key={key} className="flex justify-between"><span className="capitalize">resolved: {key.replace(/([A-Z])/g, " $1")}</span><span className="font-semibold text-brand-400">{value}</span></li>
                ))}
              </ul>
            </div>
          </div>

          <div className="card p-6">
            <h2 className="text-sm font-semibold">Recommended next actions</h2>
            <ol className="mt-4 list-inside list-decimal space-y-2 text-xs text-slate-400">
              {report.nextActions.map((action, index) => <li key={index}>{action}</li>)}
            </ol>
            <p className="mt-4 border-t border-slate-700/30 pt-4 text-[11px] italic text-slate-500">{report.note}</p>
          </div>
        </>
      )}
    </div>
  );
}
