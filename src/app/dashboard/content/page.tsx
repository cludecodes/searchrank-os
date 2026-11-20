"use client";

import { useCallback, useEffect, useState } from "react";

interface ContentView {
  item: {
    id: string;
    title: string;
    status: string;
    intent: string | null;
    proposedUrl: string | null;
    audience: string | null;
    uniqueValueProposition: string | null;
    supportingResearch: string[];
    internalLinkPlan: string[];
    brief: Record<string, unknown>;
    body: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
    originalityScore: number | null;
    createdByAgent: string | null;
    updatedAt: string;
  };
  projectName: string;
}

const STATUSES = ["idea", "brief", "draft", "in_review", "approved", "published", "rejected"];

export default function ContentStudioPage() {
  const [content, setContent] = useState<ContentView[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [selected, setSelected] = useState<ContentView | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [contentRes, projectRes] = await Promise.all([
      fetch("/api/content", { cache: "no-store" }),
      fetch("/api/projects", { cache: "no-store" }),
    ]);
    if (contentRes.ok) setContent((await contentRes.json()).content ?? []);
    if (projectRes.ok) {
      const list = (await projectRes.json()).projects ?? [];
      setProjects(list.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })));
      setSelectedProject((current) => current || list[0]?.id || "");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function generate(mode: "briefs" | "draft") {
    setBusy(true);
    setStatus(`Queued ${mode}…`);
    try {
      const response = await fetch("/api/content/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: selectedProject, mode }),
      });
      const payload = await response.json();
      setStatus(response.ok ? `Job ${String(payload.jobId).slice(0, 8)} queued.` : payload.error || "Failed");
    } catch {
      setStatus("Could not reach the API.");
    } finally { setBusy(false); }
  }

  async function transition(id: string, action: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/content/${id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();
      setStatus(response.ok ? `Content moved to ${payload.content.status}.` : payload.error || "Failed");
      if (response.ok) { await load(); setSelected(null); }
    } catch {
      setStatus("Could not reach the API.");
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">SEARCHRANK OS</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">Content Studio</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Editorial pipeline from evidence-based briefs to published pages. Every item records intent, cluster,
            audience, value proposition, research, internal links and metadata. No doorway pages or keyword stuffing.
          </p>
        </div>
        <select className="input w-auto min-w-52 py-2 text-xs" value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
          <option value="">Select a project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </section>

      {status && <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-2 text-xs text-brand-300">{status}</div>}

      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Autonomous editorial workflow</h2>
            <p className="mt-1 text-xs text-slate-500">Briefs are built from stored keywords/clusters without AI. Article drafting requires an AI provider; human-written drafts are accepted via the API.</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary text-xs" disabled={busy || !selectedProject} onClick={() => generate("briefs")}>Generate briefs</button>
            <button className="btn btn-ghost text-xs" disabled={busy || !selectedProject} onClick={() => generate("draft")}>Draft approved items</button>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {STATUSES.map((s) => (
          <div key={s} className="card p-3">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">{s.replace("_", " ")}</p>
            <p className="metric-value mt-1 text-xl font-bold text-slate-200">{content.filter((c) => c.item.status === s).length}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4"><h2 className="text-sm font-semibold">Content items</h2></div>
          {content.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No content items yet. Generate briefs from your keyword intelligence first.</p>
          ) : (
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-slate-500"><tr><th className="px-4 py-2">Title</th><th className="px-4 py-2">Project</th><th className="px-4 py-2">Intent</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Updated</th></tr></thead>
                <tbody>
                  {content.map((row) => (
                    <tr key={row.item.id} className="table-row cursor-pointer border-t border-slate-700/30" onClick={() => setSelected(row)}>
                      <td className="max-w-xs truncate px-4 py-2 text-slate-200">{row.item.title}</td>
                      <td className="px-4 py-2 text-slate-400">{row.projectName}</td>
                      <td className="px-4 py-2 text-slate-400">{row.item.intent ?? "—"}</td>
                      <td className="px-4 py-2"><span className={`badge ${row.item.status === "published" ? "badge-ok" : row.item.status === "rejected" ? "badge-bad" : "badge-info"}`}>{row.item.status}</span></td>
                      <td className="px-4 py-2 text-slate-500">{row.item.updatedAt.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4">
            <h2 className="text-sm font-semibold">Item detail</h2>
            <p className="mt-1 text-xs text-slate-500">Select a row to inspect its evidence and editorial state.</p>
          </div>
          {!selected ? (
            <p className="p-6 text-sm text-slate-500">No item selected.</p>
          ) : (
            <div className="max-h-[560px] space-y-4 overflow-auto p-5">
              <div>
                <p className="text-sm font-semibold text-slate-100">{selected.item.title}</p>
                <p className="mt-1 text-[11px] text-slate-500">{selected.item.proposedUrl ?? "No URL"} · {selected.item.status}</p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400">
                <p><span className="text-slate-500">Intent:</span> {selected.item.intent ?? "—"}</p>
                <p><span className="text-slate-500">Originality:</span> {selected.item.originalityScore ?? "—"}</p>
                <p className="col-span-2"><span className="text-slate-500">Audience:</span> {selected.item.audience ?? "—"}</p>
                <p className="col-span-2"><span className="text-slate-500">UVP:</span> {selected.item.uniqueValueProposition ?? "—"}</p>
                <p className="col-span-2"><span className="text-slate-500">Meta:</span> {selected.item.metaTitle ?? "—"} / {selected.item.metaDescription ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-300">Supporting research</p>
                <ul className="list-inside list-disc text-[11px] text-slate-400">{(selected.item.supportingResearch ?? []).map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-300">Internal link plan</p>
                <ul className="list-inside list-disc text-[11px] text-slate-400">{(selected.item.internalLinkPlan ?? []).map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-300">Brief</p>
                <pre className="max-h-40 overflow-auto rounded bg-ink-950/70 p-2 text-[10px] text-slate-400">{JSON.stringify(selected.item.brief, null, 2)}</pre>
              </div>
              {selected.item.body && (
                <div>
                  <p className="text-xs font-semibold text-slate-300">Body</p>
                  <p className="whitespace-pre-wrap text-[11px] text-slate-400">{selected.item.body.slice(0, 1500)}</p>
                </div>
              )}
              <div className="flex flex-wrap gap-2 border-t border-slate-700/30 pt-3">
                {selected.item.status === "draft" && <button className="btn btn-primary text-[11px]" disabled={busy} onClick={() => transition(selected.item.id, "submit")}>Submit for review</button>}
                {selected.item.status === "in_review" && (
                  <>
                    <button className="btn btn-primary text-[11px]" disabled={busy} onClick={() => transition(selected.item.id, "approve")}>Approve</button>
                    <button className="btn btn-ghost text-[11px]" disabled={busy} onClick={() => transition(selected.item.id, "reject")}>Reject</button>
                  </>
                )}
                {selected.item.status === "approved" && <button className="btn btn-primary text-[11px]" disabled={busy} onClick={() => transition(selected.item.id, "publish")}>Publish</button>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
