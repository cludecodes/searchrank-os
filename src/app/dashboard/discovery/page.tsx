"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function DiscoveryPage() {
  const [integrations, setIntegrations] = useState<Array<{ provider: string; status: string; displayName: string }>>([]);
  const [projects, setProjects] = useState<Array<{
    id: string;
    name: string;
    domain: string | null;
    productionUrl: string | null;
    framework: string | null;
    businessCategory: string | null;
    status: string;
    isDuplicateDomain: boolean;
    isPreview: boolean;
    discoveredBy: string | null;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  async function load() {
    const [intRes, projRes] = await Promise.all([
      fetch("/api/integrations/github", { cache: "no-store" }),
      fetch("/api/projects", { cache: "no-store" }),
    ]);
    const intData = intRes.ok ? (await intRes.json()) : { integrations: [] };
    const projData = projRes.ok ? (await projRes.json()) : { projects: [] };
    setIntegrations(intData.integrations ?? []);
    setProjects(projData.projects ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const connected = (provider: string) =>
    integrations.some((i) => i.provider === provider && i.status === "connected");

  async function runDiscovery() {
    setLoading(true);
    setStatus("Running discovery…");
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "PROJECT_DISCOVERY_AGENT", input: {} }),
      });
      const payload = await response.json();
      setStatus(response.ok
        ? `Discovery started (job ${String(payload.jobId ?? "").slice(0, 8)}). Refresh to see results.`
        : payload.error || "Discovery failed");
    } catch {
      setStatus("Could not reach the API.");
    } finally {
      setLoading(false);
      await load();
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">SEARCHRANK OS</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Project Discovery</h1>
        <p className="mt-2 text-sm text-slate-400">
          Connect GitHub and Vercel to automatically discover repositories, production domains, frameworks and deployment
          health. Private repositories are never imported.
        </p>
      </section>

      <div className="card grid gap-4 sm:grid-cols-2 lg:grid-cols-4 p-5">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">GitHub</p>
          <p className={`text-sm font-semibold ${connected("github") ? "text-brand-400" : "text-slate-300"}`}>
            {connected("github") ? "Connected" : "Not connected"}
          </p>
          {connected("github") ? (
            <a href="/api/integrations/github/start" className="text-xs text-slate-400 hover:underline">Reconnect</a>
          ) : (
            <a href="/api/integrations/github/start" className="btn btn-primary text-xs">Connect GitHub</a>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Vercel</p>
          <p className={`text-sm font-semibold ${connected("vercel") ? "text-brand-400" : "text-slate-300"}`}>
            {connected("vercel") ? "Connected" : "Not connected"}
          </p>
          {connected("vercel") ? (
            <a href="/api/integrations/vercel/start" className="text-xs text-slate-400 hover:underline">Reconnect</a>
          ) : (
            <a href="/api/integrations/vercel/start" className="btn btn-primary text-xs">Connect Vercel</a>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Discovery</p>
          <button
            className="btn btn-primary text-xs w-full"
            disabled={loading || (!connected("github") && !connected("vercel"))}
            onClick={runDiscovery}
          >
            {loading ? "Discovering…" : "Run discovery now"}
          </button>
          <p className="text-xs text-slate-500">
            {!connected("github") && !connected("vercel")
              ? "Connect an integration first"
              : "Discovers repos, Vercel projects, domains, frameworks, duplicates and deployment health"}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Manual registration</p>
          <a href="/dashboard/projects" className="btn btn-ghost text-xs w-full">Register project manually</a>
          <p className="text-xs text-slate-500">Add a production website without a connected integration.</p>
        </div>
      </div>

      {status && (
        <div className={`rounded-lg border p-3 text-xs ${status.startsWith("Discovery started") ? "border-brand-500/30 bg-brand-500/10 text-brand-300" : "border-red-500/30 bg-red-500/10 text-red-300"}`}>
          {status}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-700/40 px-5 py-4">
          <h2 className="text-sm font-semibold">Discovered projects</h2>
          <Link href="/dashboard/projects" className="text-xs text-brand-400 hover:underline">Manage all</Link>
        </div>
        {loading ? (
          <p className="p-6 text-sm text-slate-500">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">
            No projects discovered yet. Connect GitHub or Vercel and run discovery, or register a project manually.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-5 py-3 font-medium">Domain</th>
                  <th className="px-5 py-3 font-medium">Framework</th>
                  <th className="px-5 py-3 font-medium">Category</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Source</th>
                  <th className="px-5 py-3 font-medium">Flags</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id} className="table-row border-t border-slate-700/30 align-top">
                    <td className="px-5 py-3 font-medium text-slate-200">{p.name}</td>
                    <td className="px-5 py-3 text-slate-400 truncate max-w-[200px]">{p.domain ?? "—"}</td>
                    <td className="px-5 py-3 text-slate-400">{p.framework ?? "—"}</td>
                    <td className="px-5 py-3 text-slate-400 capitalize">{p.businessCategory ?? "—"}</td>
                    <td className="px-5 py-3">
                      <span className={`badge ${p.status === "active" ? "badge-ok" : p.status === "error" ? "badge-bad" : "badge-muted"}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-400 capitalize">{p.discoveredBy ?? "manual"}</td>
                    <td className="px-5 py-3">
                      {[p.isDuplicateDomain && "duplicate domain", p.isPreview && "preview"].filter(Boolean).join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card p-5 border-amber-500/25 bg-amber-500/5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-400">How discovery works</h3>
        <ul className="list-disc list-inside space-y-1 text-xs text-slate-400 mt-2">
          <li>Only public repositories are imported; private repositories and credentials are never exposed.</li>
          <li>Framework is detected from repository manifest files (package.json, next.config, etc.).</li>
          <li>Production domains come from Vercel targets or repository homepage URLs.</li>
          <li>Deployment state is read from Vercel deployments; non-READY production deployments are flagged.</li>
          <li>Preview deployments are identified and preview-only projects are marked.</li>
          <li>The same domain appearing under GitHub and Vercel is flagged as a duplicate.</li>
          <li>No ranking, traffic, or ranking data is gathered during discovery.</li>
        </ul>
      </div>
    </div>
  );
}
