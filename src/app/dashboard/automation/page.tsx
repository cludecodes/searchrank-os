"use client";

import { useCallback, useEffect, useState } from "react";

interface PipelineView {
  id: string;
  title: string;
  status: string;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  previewUrl: string | null;
  changeApprovalId: string | null;
  mergeApprovalId: string | null;
  steps: Array<{ name: string; status: string; detail: string; at: string }>;
  beforeMetrics: Record<string, unknown>;
  afterMetrics: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export default function AutomationPage() {
  const [pipelines, setPipelines] = useState<PipelineView[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string; repository: string | null }>>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [delta, setDelta] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [pRes, projRes] = await Promise.all([
      fetch("/api/automation/pipelines", { cache: "no-store" }),
      fetch("/api/projects", { cache: "no-store" }),
    ]);
    if (pRes.ok) setPipelines((await pRes.json()).pipelines ?? []);
    if (projRes.ok) {
      const list = (await projRes.json()).projects ?? [];
      setProjects(list.map((p: { id: string; name: string; repositoryFullName?: string }) => ({
        id: p.id, name: p.name, repository: p.repositoryFullName ?? null,
      })));
      setSelectedProject((current) => current || list[0]?.id || "");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/automation/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: selectedProject,
          title,
          description: "Proposed SEO improvement from the platform.",
          changes: [{ path, content }],
        }),
      });
      const payload = await response.json();
      setStatus(response.ok ? `Proposal created. Approval ${String(payload.approvalId).slice(0, 8)} is required.` : payload.error || "Failed");
      if (response.ok) { setTitle(""); setPath(""); setContent(""); await load(); }
    } catch { setStatus("Could not reach the API."); }
    finally { setBusy(false); }
  }

  async function advance(id: string, rollbackApprovalId?: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/automation/pipelines/${id}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rollbackApprovalId ? { rollbackApprovalId } : {}),
      });
      const payload = await response.json();
      setStatus(response.ok ? `Next step queued (job ${String(payload.jobId).slice(0, 8)}).` : payload.error || "Failed");
      await load();
    } catch { setStatus("Could not reach the API."); }
    finally { setBusy(false); }
  }

  async function decide(approvalId: string, decision: "approve" | "reject") {
    setBusy(true);
    try {
      const response = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId, decision }),
      });
      setStatus(response.ok ? `Approval ${decision}d. Run the next step to continue.` : "Failed");
      await load();
    } catch { setStatus("Could not reach the API."); }
    finally { setBusy(false); }
  }

  async function inspect(id: string) {
    const response = await fetch(`/api/automation/pipelines/${id}`, { cache: "no-store" });
    if (response.ok) setDelta((await response.json()).delta);
  }

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">SEARCHRANK OS</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">GitHub / Vercel Automation</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-400">
          Safe development pipeline: proposal → approval → branch → checks → PR → preview → merge approval → merge.
          Production is never overwritten without explicit approval, and rollback is a reviewed PR.
        </p>
      </section>

      {status && <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-2 text-xs text-brand-300">{status}</div>}

      <div className="card p-5">
        <h2 className="text-sm font-semibold">Propose a code change</h2>
        <p className="mt-1 text-xs text-slate-500">Nothing is written to a repository until an administrator approves.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <input className="input text-xs" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, e.g. Improve metadata on pricing page" />
          <input className="input text-xs" value={path} onChange={(e) => setPath(e.target.value)} placeholder="File path, e.g. src/app/page.tsx" />
          <textarea className="input min-h-32 text-xs md:col-span-2" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Proposed full file content" />
        </div>
        <button className="btn btn-primary mt-3 text-xs" disabled={busy || !selectedProject || !title || !path || !content} onClick={create}>Create proposal</button>
      </div>

      <div className="space-y-3">
        {pipelines.length === 0 ? (
          <div className="card p-6 text-sm text-slate-500">No pipelines yet. Create a proposal to start the approval-gated workflow.</div>
        ) : pipelines.map((p) => (
          <div key={p.id} className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-100">{p.title}</p>
                <p className="mt-1 text-[11px] text-slate-500">{p.id.slice(0, 8)} · {new Date(p.createdAt).toISOString().slice(0, 16).replace("T", " ")}</p>
              </div>
              <span className={`badge ${p.status === "merged" ? "badge-ok" : p.status === "rejected" || p.status === "checks_failed" ? "badge-bad" : "badge-info"}`}>{p.status}</span>
            </div>

            <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
              {p.branch && <span className="badge badge-muted">branch: {p.branch}</span>}
              {p.prUrl && <a className="badge badge-info" href={p.prUrl} target="_blank" rel="noreferrer">PR #{p.prNumber} ↗</a>}
              {p.previewUrl && <a className="badge badge-ok" href={p.previewUrl} target="_blank" rel="noreferrer">Preview ↗</a>}
            </div>

            <ol className="mt-3 space-y-1">
              {p.steps.map((s, i) => (
                <li key={i} className="flex gap-2 text-[11px] text-slate-400">
                  <span className={s.status === "completed" ? "text-brand-400" : s.status === "failed" ? "text-red-300" : "text-slate-500"}>●</span>
                  <span className="font-medium text-slate-300">{s.name}</span>
                  <span className="truncate">{s.detail}</span>
                </li>
              ))}
            </ol>

            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-700/30 pt-3">
              {p.changeApprovalId && p.status === "awaiting_approval" && (
                <>
                  <button className="btn btn-primary text-[11px]" disabled={busy} onClick={() => decide(p.changeApprovalId!, "approve")}>Approve change</button>
                  <button className="btn btn-ghost text-[11px]" disabled={busy} onClick={() => decide(p.changeApprovalId!, "reject")}>Reject</button>
                </>
              )}
              {p.mergeApprovalId && p.status === "awaiting_merge" && (
                <button className="btn btn-primary text-[11px]" disabled={busy} onClick={() => decide(p.mergeApprovalId!, "approve")}>Approve merge</button>
              )}
              {p.status === "merged" && (
                <button className="btn btn-ghost text-[11px]" disabled={busy} onClick={() => advance(p.id)}>Request rollback</button>
              )}
              {p.status !== "merged" && p.status !== "reverted" && p.status !== "rejected" && p.status !== "checks_failed" && (
                <button className="btn btn-ghost text-[11px]" disabled={busy}
                  onClick={() => advance(p.id, p.steps.some((s) => s.name === "rollback_requested") ? (p.changeApprovalId ?? undefined) : undefined)}>
                  {p.steps.some((s) => s.name === "rollback_requested") ? "Open rollback PR" : "Run next step"}
                </button>
              )}
              <button className="btn btn-ghost text-[11px]" onClick={() => inspect(p.id)}>Before / after metrics</button>
            </div>
            {delta && <pre className="mt-3 rounded bg-ink-950/70 p-2 text-[10px] text-slate-400">{JSON.stringify(delta, null, 2)}</pre>}
          </div>
        ))}
      </div>

      <div className="card p-5 text-[11px] text-slate-500">
        <p className="font-semibold text-slate-300">Safety guarantees</p>
        <ul className="mt-2 list-inside list-disc space-y-1">
          <li>Branch and PR creation require an approved change request.</li>
          <li>Checks must pass before a PR is opened; failures stop the pipeline.</li>
          <li>Merging requires a separate approval and is logged in the audit trail.</li>
          <li>Rollback opens a reviewed revert PR — production is never force-pushed.</li>
        </ul>
      </div>
    </div>
  );
}
