import Link from "next/link";
import { getRequestContext } from "@/core/auth/request";
import { databaseMode, getDb } from "@/core/db/client";
import { getExecutiveData, type ExecutiveData } from "@/core/reporting/executive";
import { ActionBar } from "@/components/ActionBar";

export const dynamic = "force-dynamic";

function fmtDate(value: unknown): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 16).replace("T", " ");
}

function Kpi({ label, value, hint, change, tone = "brand" }: {
  label: string;
  value: string | number;
  hint?: string;
  change?: number | null;
  tone?: "brand" | "blue" | "amber" | "slate";
}) {
  const toneClass = {
    brand: "text-brand-400",
    blue: "text-blue-300",
    amber: "text-amber-300",
    slate: "text-slate-100",
  }[tone];
  return (
    <div className="card relative overflow-hidden p-5">
      <div className="absolute right-0 top-0 h-16 w-16 rounded-full bg-current opacity-[0.04]" />
      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`metric-value mt-2 text-3xl font-bold ${toneClass}`}>{value}</p>
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        {change !== undefined && change !== null && (
          <span className={change >= 0 ? "text-brand-400" : "text-red-300"}>
            {change >= 0 ? "▲" : "▼"} {Math.abs(change)}%
          </span>
        )}
        {hint && <span className="text-slate-500">{hint}</span>}
      </div>
    </div>
  );
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700/40">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function HealthGauge({ score }: { score: number | null }) {
  const value = score ?? 0;
  const color = value >= 80 ? "#34d399" : value >= 60 ? "#fbbf24" : "#f87171";
  const circumference = 2 * Math.PI * 46;
  const offset = circumference - (value / 100) * circumference;
  return (
    <div className="flex items-center gap-5">
      <svg width="112" height="112" viewBox="0 0 112 112" className="shrink-0">
        <circle cx="56" cy="56" r="46" fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth="9" />
        <circle
          cx="56" cy="56" r="46" fill="none" stroke={color} strokeWidth="9"
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 56 56)"
        />
        <text x="56" y="62" textAnchor="middle" fill={color} fontSize="24" fontWeight="700">{score ?? "—"}</text>
      </svg>
      <div>
        <p className="text-sm font-semibold text-slate-100">Technical SEO health</p>
        <p className="mt-1 text-xs text-slate-500">
          {score === null ? "No audits executed yet" : "Average of persisted audit scores"}
        </p>
      </div>
    </div>
  );
}

export default async function OverviewPage() {
  const context = await getRequestContext();
  if (!context) return null;
  const data: ExecutiveData = await getExecutiveData(getDb(), context.workspaceId);
  const contentMax = Math.max(1, ...data.content.map((c) => c.total));
  const funnel = [
    { label: "Impressions", value: data.search.impressions },
    { label: "Clicks", value: data.search.clicks },
    { label: "Top 10 terms", value: data.search.top10 },
    { label: "Top 3 terms", value: data.search.top3 },
    { label: "Conversions", value: data.search.conversions },
  ];
  const funnelMax = Math.max(1, ...funnel.map((f) => f.value));

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">Executive Overview</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">Search operations command center</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            Live portfolio intelligence derived only from persisted data. No simulated metrics.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="badge badge-info">Database: {databaseMode()}</span>
          <span className={`badge ${data.ai.configured ? "badge-ok" : "badge-warn"}`}>AI: {data.ai.name}</span>
          <span className="badge badge-muted">Generated {fmtDate(data.generatedAt)}</span>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Registered websites" value={data.sites.total} hint={`${data.sites.active} active`} />
        <Kpi label="Indexed URLs" value={data.pages.indexed} hint={`${data.pages.total} audited pages`} tone="blue" />
        <Kpi label="Organic clicks (7d)" value={data.search.clicks.toLocaleString()} change={data.search.clicksChangePct} hint="vs prior week" />
        <Kpi label="Impressions (7d)" value={data.search.impressions.toLocaleString()} change={data.search.impressionsChangePct} hint="vs prior week" tone="blue" />
        <Kpi label="Average position" value={data.search.averagePosition ?? "—"} hint={data.search.averagePosition !== null ? "lower is better" : "no search data"} tone="amber" />
        <Kpi label="CTR" value={`${data.search.ctr}%`} hint="clicks / impressions" />
        <Kpi label="Keywords in top 3 / 10" value={`${data.search.top3} / ${data.search.top10}`} hint="observed ranking rows" tone="blue" />
        <Kpi label="Organic conversions" value={data.search.conversions} hint="from connected analytics" tone="amber" />
      </section>

      <section className="grid gap-6 xl:grid-cols-3">
        <div className="card p-6">
          <HealthGauge score={data.audits.averageScore} />
          <div className="mt-5 grid grid-cols-3 gap-3 border-t border-slate-700/30 pt-4 text-center text-xs">
            <div><p className="text-slate-500">Audits</p><p className="mt-1 font-semibold text-slate-200">{data.audits.count}</p></div>
            <div><p className="text-slate-500">Index issues</p><p className="mt-1 font-semibold text-slate-200">{data.indexing.issues}</p></div>
            <div><p className="text-slate-500">Orphans</p><p className="mt-1 font-semibold text-slate-200">{data.pages.orphans}</p></div>
          </div>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold">Search visibility funnel</h2>
          <p className="mt-1 text-xs text-slate-500">Weekly window, real provider rows</p>
          <div className="mt-4 space-y-3">
            {funnel.map((item) => (
              <div key={item.label}>
                <div className="flex justify-between text-xs"><span className="text-slate-400">{item.label}</span><span className="font-semibold text-slate-200">{item.value}</span></div>
                <Bar value={item.value} max={funnelMax} color="bg-brand-500" />
              </div>
            ))}
          </div>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold">Content pipeline</h2>
          <p className="mt-1 text-xs text-slate-500">{data.content.reduce((s, c) => s + c.total, 0)} item(s) total</p>
          <div className="mt-4 space-y-3">
            {data.content.length === 0 ? (
              <p className="text-xs text-slate-500">No content items yet.</p>
            ) : data.content.map((row) => (
              <div key={row.status}>
                <div className="flex justify-between text-xs"><span className="capitalize text-slate-400">{row.status.replace("_", " ")}</span><span className="font-semibold text-slate-200">{row.total}</span></div>
                <Bar value={row.total} max={contentMax} color="bg-blue-400" />
              </div>
            ))}
          </div>
        </div>
      </section>

      <ActionBar projects={data.perProject.map((p) => ({ id: p.id, name: p.name }))} />

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-700/40 px-5 py-4">
          <h2 className="text-sm font-semibold">Project portfolio</h2>
          <Link href="/dashboard/projects" className="text-xs text-brand-400 hover:underline">Manage all</Link>
        </div>
        {data.perProject.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">No projects registered. Connect a source or register one manually.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Website</th><th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">SEO health</th><th className="px-5 py-3 font-medium">Keywords</th>
                  <th className="px-5 py-3 font-medium">Clicks</th><th className="px-5 py-3 font-medium">Content</th>
                  <th className="px-5 py-3 font-medium">Deployment</th>
                </tr>
              </thead>
              <tbody>
                {data.perProject.map((p) => (
                  <tr key={p.id} className="table-row border-t border-slate-700/30">
                    <td className="px-5 py-3"><span className="font-medium text-slate-200">{p.name}</span><span className="block text-[10px] text-slate-500">{p.domain ?? "—"}</span></td>
                    <td className="px-5 py-3"><span className={`badge ${p.status === "active" ? "badge-ok" : p.status === "error" ? "badge-bad" : "badge-muted"}`}>{p.status}</span></td>
                    <td className="px-5 py-3"><div className="flex items-center gap-2"><span className="w-8 text-slate-300">{p.auditScore ?? "—"}</span><div className="w-20"><Bar value={p.auditScore ?? 0} max={100} color={(p.auditScore ?? 0) >= 80 ? "bg-brand-500" : "bg-amber-400"} /></div></div></td>
                    <td className="px-5 py-3 text-slate-400">{p.keywords}</td>
                    <td className="px-5 py-3 text-slate-400">{p.clicks}</td>
                    <td className="px-5 py-3 text-slate-400">{p.content}</td>
                    <td className="px-5 py-3 text-slate-400">{p.deployment ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="card p-6">
          <h2 className="text-sm font-semibold">System health</h2>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {data.jobs.length === 0 ? <p className="text-xs text-slate-500">No jobs recorded.</p> : data.jobs.map((row) => (
              <div key={row.status} className="rounded-lg border border-slate-700/40 p-3">
                <p className="text-[11px] capitalize text-slate-500">{row.status}</p>
                <p className="mt-1 text-lg font-bold text-slate-200">{row.total}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-slate-700/30 pt-4 text-xs text-slate-400">
            Pending approvals: <span className="font-semibold text-amber-300">{data.approvals.pending}</span>
          </div>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <ul className="mt-4 space-y-2">
            {data.activity.length === 0 ? (
              <li className="text-xs text-slate-500">No activity recorded yet.</li>
            ) : data.activity.map((entry, index) => (
              <li key={`${entry.action}-${index}`} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-slate-300">{entry.action.replace(/\./g, " → ")}</span>
                <span className="shrink-0 text-slate-500">{fmtDate(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="flex flex-wrap justify-between gap-2 border-t border-slate-700/30 pt-5 text-xs text-slate-600">
        <span>All metrics are aggregates of persisted Postgres rows — none are estimated or fabricated.</span>
        <span>Indexed {data.pages.indexed} · Submissions {data.indexing.submissions} · Checks {data.indexing.checks}</span>
      </footer>
    </div>
  );
}
