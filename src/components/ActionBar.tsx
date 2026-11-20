"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ActionBar({ projects }: { projects: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function trigger(type: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setStatus(`Queued ${type}…`);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, projectId: projectId || undefined, payload: body }),
      });
      const payload = await response.json();
      setStatus(response.ok ? `Job ${payload.job?.id?.slice(0, 8)} queued. The worker will pick it up.` : payload.error);
      router.refresh();
    } catch {
      setStatus("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Operations</h2>
          <p className="mt-1 text-xs text-slate-500">Jobs are persisted and executed by the background worker.</p>
        </div>
        <select className="input w-auto min-w-48 py-1.5 text-xs" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">No project selected</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy || !projectId} onClick={() => trigger("seo.audit")}>Run SEO audit</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => trigger("discovery.sync")}>Discover projects</button>
        <button className="btn btn-ghost" disabled={busy || !projectId} onClick={() => trigger("keywords.sync")}>Sync keywords</button>
        <button className="btn btn-ghost" disabled={busy || !projectId} onClick={() => trigger("analytics.sync")}>Sync analytics</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => trigger("supervisor.daily")}>Run supervisor</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => trigger("report.generate")}>Generate report</button>
      </div>
      {status && <p className="mt-3 text-xs text-brand-400">{status}</p>}
    </div>
  );
}
