import Link from "next/link";
import { getRequestContext } from "@/core/auth/request";
import { getDb, isNeonConfigured } from "@/core/db/client";
import { getDashboardData } from "@/core/reporting/dashboard";
import { ActionBar } from "@/components/ActionBar";

export const dynamic = "force-dynamic";

function formatDate(value: unknown): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 16).replace("T", " ");
}

function Metric({ label, value, hint, tone = "ok" }: { label: string; value: string | number; hint?: string; tone?: "ok" | "info" | "warn" }) {
  const toneClass = tone === "ok" ? "text-brand-400" : tone === "info" ? "text-blue-300" : "text-amber-300";
  return (
    <div className="card p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`metric-value mt-2 text-3xl font-bold ${toneClass}`}>{value}</p>
      {hint && <p className="mt-2 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export default async function OverviewPage() {
  const context = await getRequestContext();
  if (!context) return null;
  const data = await getDashboardData(getDb(), context.workspaceId);
  const allGood = data.configuration.ai.configured && data.configuration.providers.every((p) => p.configured) && data.configuration.indexNow;

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">Executive Overview</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">Search operations at a glance</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            Every figure below is aggregated from persisted Postgres rows. Integrations that are not
            connected are shown as such — no values are simulated.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className={`badge ${data.configuration.database === "neon" ? "badge-ok" : "badge-info"}`}>
            Database: {data.configuration.database}
          </span>
          <span className={`badge ${data.configuration.ai.configured ? "badge-ok" : "badge-warn"}`}>
            AI: {data.configuration.ai.provider}
          </span>
          <span className={`badge ${allGood ? "badge-ok" : "badge-warn"}`}>
            {allGood ? "All integrations configured" : "Some integrations not configured"}
          </span>
        </div>
      </section>

      {!allGood && (
        <div className="card border-amber-500/25 p-4 text-sm text-amber-200/90">
          <strong className="font-semibold">Setup required for live data:</strong> connect OAuth apps in
          <Link href="/dashboard/settings" className="mx-1 underline underline-offset-2">Settings</Link>
          and set an AI provider. Until then, agents that need external data will explicitly skip instead of inventing results.
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Registered websites" value={data.projects.total} hint={`${data.projects.active} active production site(s)`} />
        <Metric label="Technical audits" value={data.audits.total} hint={data.audits.averageScore !== null ? `Average score ${data.audits.averageScore}/100` : "No audits executed yet"} />
        <Metric label="Keyword records" value={data.keywords.total} hint="Stored with source and retrieval date" tone="info" />
        <Metric label="Organic clicks" value={data.search.clicks.toLocaleString()} hint={`${data.search.impressions.toLocaleString()} impressions from connected engines`} />
        <Metric label="Content items" value={data.content.total} hint={`${data.content.inProgress} in progress · ${data.content.published} published`} tone="info" />
        <Metric label="Index submissions" value={data.indexing.total} hint="Acceptance is not an indexing guarantee" />
        <Metric label="Pending approvals" value={data.approvals.pending} hint="High-risk actions wait for a human decision" tone={data.approvals.pending ? "warn" : "ok"} />
        <Metric label="Failed jobs" value={data.jobs.failed ?? 0} hint={`${data.jobs.succeeded ?? 0} succeeded · ${data.jobs.pending ?? 0} pending`} tone={(data.jobs.failed ?? 0) ? "warn" : "ok"} />
      </section>

      <ActionBar projects={data.projectList.map((p) => ({ id: p.id, name: p.name }))} />

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-700/40 px-5 py-4">
            <h2 className="text-sm font-semibold">Project portfolio</h2>
            <Link href="/dashboard/projects" className="text-xs text-brand-400 hover:underline">View all</Link>
          </div>
          {data.projectList.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No projects registered yet. Use Discover projects or register one manually.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-slate-500"><tr><th className="px-5 py-3 font-medium">Project</th><th className="px-5 py-3 font-medium">Domain</th><th className="px-5 py-3 font-medium">Framework</th><th className="px-5 py-3 font-medium">Status</th></tr></thead>
                <tbody>
                  {data.projectList.map((p) => (
                    <tr key={p.id} className="table-row border-t border-slate-700/30">
                      <td className="px-5 py-3 font-medium text-slate-200">{p.name}</td>
                      <td className="px-5 py-3 text-slate-400">{p.domain ?? "—"}</td>
                      <td className="px-5 py-3 text-slate-400">{p.framework ?? "—"}</td>
                      <td className="px-5 py-3"><span className={`badge ${p.status === "active" ? "badge-ok" : "badge-muted"}`}>{p.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4">
            <h2 className="text-sm font-semibold">Agent activity</h2>
          </div>
          {data.recentRuns.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No agent runs recorded yet.</p>
          ) : (
            <ul className="divide-y divide-slate-700/30">
              {data.recentRuns.map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-3 px-5 py-3 text-xs">
                  <span className="font-medium text-slate-200">{run.agentKey.replace(/_/g, " ")}</span>
                  <span className="flex items-center gap-3">
                    <span className={`badge ${run.status === "succeeded" ? "badge-ok" : run.status === "failed" ? "badge-bad" : "badge-muted"}`}>{run.status}</span>
                    <span className="text-slate-500">{formatDate(run.startedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4"><h2 className="text-sm font-semibold">Recent audits</h2></div>
          {data.recentAudits.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No audits executed yet.</p>
          ) : (
            <ul className="divide-y divide-slate-700/30">
              {data.recentAudits.map((audit) => (
                <li key={audit.id} className="flex items-center justify-between px-5 py-3 text-xs">
                  <span className="text-slate-300">{audit.projectName}</span>
                  <span className="flex items-center gap-3">
                    <span className={`badge ${(audit.score ?? 0) >= 80 ? "badge-ok" : (audit.score ?? 0) >= 60 ? "badge-warn" : "badge-bad"}`}>{audit.score ?? "—"}/100</span>
                    <span className="text-slate-500">{formatDate(audit.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4"><h2 className="text-sm font-semibold">Connected services</h2></div>
          <ul className="divide-y divide-slate-700/30">
            {data.configuration.providers.map((provider) => {
              const live = data.connectedIntegrations.find((i) => i.provider === provider.provider);
              return (
                <li key={provider.provider} className="flex items-center justify-between px-5 py-3 text-xs">
                  <span className="text-slate-300">{provider.label}</span>
                  <span className={`badge ${live ? "badge-ok" : "badge-muted"}`}>
                    {live ? `${live.status}` : provider.configured ? "Ready to connect" : "Not configured"}
                  </span>
                </li>
              );
            })}
            <li className="flex items-center justify-between px-5 py-3 text-xs">
              <span className="text-slate-300">IndexNow</span>
              <span className={`badge ${data.configuration.indexNow ? "badge-ok" : "badge-warn"}`}>{data.configuration.indexNow ? "Configured" : "Key missing"}</span>
            </li>
          </ul>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-semibold">Recent jobs</h2>
        {data.recentJobs.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No jobs have been enqueued yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500"><tr><th className="py-2">Type</th><th className="py-2">Status</th><th className="py-2">Attempts</th><th className="py-2">Created</th><th className="py-2">Error</th></tr></thead>
              <tbody>
                {data.recentJobs.map((job) => (
                  <tr key={job.id} className="table-row border-t border-slate-700/30">
                    <td className="py-2 font-medium text-slate-200">{job.type}</td>
                    <td className="py-2"><span className={`badge ${job.status === "succeeded" ? "badge-ok" : job.status === "failed" ? "badge-bad" : "badge-info"}`}>{job.status}</span></td>
                    <td className="py-2 text-slate-400">{job.attempts}/{job.maxAttempts}</td>
                    <td className="py-2 text-slate-500">{formatDate(job.createdAt)}</td>
                    <td className="max-w-xs truncate py-2 text-red-300">{job.lastError ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="flex flex-wrap justify-between gap-2 border-t border-slate-700/30 pt-5 text-xs text-slate-600">
        <span>Database: {isNeonConfigured() ? "Neon serverless Postgres" : "Embedded PGlite Postgres"}</span>
        <span>Audit events: {data.auditLogs.total} · Monitoring checks: {data.monitoring.total} · Deployments: {data.deployments.total}</span>
      </footer>
    </div>
  );
}
