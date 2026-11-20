"use client";

import { useCallback, useEffect, useState } from "react";

interface Finding {
  id: string;
  category: string;
  severity: string;
  title: string;
  detail: string;
  recommendation?: string;
  evidence?: string;
}

interface AuditView {
  id: string;
  score: number | null;
  createdAt: string;
  projectName: string;
  status: string;
  findings: { findings?: Finding[]; limitations?: string[]; redirects?: { chain: string[]; loop: boolean } };
}

interface ArtifactView {
  id: string;
  projectName: string;
  kind: string;
  path: string;
  content: string;
  rationale: string | null;
  status: string;
}

const fmt = (value: string) => value.slice(0, 16).replace("T", " ");

export default function AuditsPage() {
  const [audits, setAudits] = useState<AuditView[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedAudit, setSelectedAudit] = useState<AuditView | null>(null);
  const [expandedArtifact, setExpandedArtifact] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [auditRes, artifactRes, projectRes] = await Promise.all([
      fetch("/api/audits", { cache: "no-store" }),
      fetch("/api/seo/artifacts", { cache: "no-store" }),
      fetch("/api/projects", { cache: "no-store" }),
    ]);
    if (auditRes.ok) setAudits((await auditRes.json()).audits ?? []);
    if (artifactRes.ok) setArtifacts((await artifactRes.json()).artifacts ?? []);
    if (projectRes.ok) {
      const list = (await projectRes.json()).projects ?? [];
      setProjects(list.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })));
      setSelectedProject((current) => current || list[0]?.id || "");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function trigger(url: string, body: Record<string, unknown>, label: string) {
    setBusy(true);
    setStatus(`Queued ${label}…`);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      setStatus(response.ok ? `${label} job ${String(payload.jobId).slice(0, 8)} queued.` : payload.error || "Failed");
    } catch {
      setStatus("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, decision: "approve" | "reject") {
    setBusy(true);
    try {
      const response = await fetch("/api/seo/artifacts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      setStatus(response.ok ? `Artifact ${decision}d.` : "Failed to decide");
      await load();
    } catch {
      setStatus("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  const findings = selectedAudit?.findings?.findings ?? [];

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">SEARCHRANK OS</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">SEO Audits</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Real HTML/HTTP checks and framework-aware artifact proposals. Scores are deductions from observed
            failures. Nothing is applied to a website without your approval.
          </p>
        </div>
        <select className="input w-auto min-w-52 py-2 text-xs" value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
          <option value="">Select a project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </section>

      {status && <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-2 text-xs text-brand-300">{status}</div>}

      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary text-xs" disabled={busy || !selectedProject}
          onClick={() => trigger("/api/audits", { projectId: selectedProject }, "audit")}>Run technical audit</button>
        <button className="btn btn-ghost text-xs" disabled={busy || !selectedProject}
          onClick={() => trigger("/api/seo/artifacts", { projectId: selectedProject }, "artifact generation")}>Generate artifacts</button>
        <button className="btn btn-ghost text-xs" disabled={busy || !selectedProject}
          onClick={() => trigger("/api/seo/site-audit", { projectId: selectedProject }, "site analysis")}>Detect duplicates & orphans</button>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4"><h2 className="text-sm font-semibold">Audit history</h2></div>
          {audits.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No audits executed yet.</p>
          ) : (
            <ul className="max-h-[420px] divide-y divide-slate-700/30 overflow-auto">
              {audits.map((audit) => (
                <li key={audit.id}>
                  <button
                    className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left text-xs hover:bg-slate-700/10"
                    onClick={() => setSelectedAudit(audit)}
                  >
                    <span className="text-slate-200">{audit.projectName}</span>
                    <span className="flex items-center gap-3">
                      <span className={`badge ${(audit.score ?? 0) >= 80 ? "badge-ok" : (audit.score ?? 0) >= 60 ? "badge-warn" : "badge-bad"}`}>{audit.score ?? "—"}/100</span>
                      <span className="text-slate-500">{fmt(audit.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4">
            <h2 className="text-sm font-semibold">Findings</h2>
            <p className="mt-1 text-xs text-slate-500">{selectedAudit ? `${findings.length} check(s) from the selected audit` : "Select an audit to inspect its evidence."}</p>
          </div>
          {!selectedAudit ? (
            <p className="p-6 text-sm text-slate-500">No audit selected.</p>
          ) : (
            <div className="max-h-[420px] space-y-2 overflow-auto p-4">
              {findings.map((f) => (
                <div key={f.id} className="rounded-lg border border-slate-700/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-200">{f.title}</span>
                    <span className={`badge ${f.severity === "critical" ? "badge-bad" : f.severity === "warning" ? "badge-warn" : f.severity === "pass" ? "badge-ok" : "badge-muted"}`}>{f.severity}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{f.detail}</p>
                  {f.recommendation && <p className="mt-1 text-[11px] text-brand-400">→ {f.recommendation}</p>}
                </div>
              ))}
              {(selectedAudit.findings?.limitations ?? []).map((note) => (
                <p key={note} className="text-[11px] italic text-slate-500">Note: {note}</p>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-slate-700/40 px-5 py-4">
          <h2 className="text-sm font-semibold">Artifact proposals</h2>
          <p className="mt-1 text-xs text-slate-500">Generated from verified data only. Approval is required before applying to a repository.</p>
        </div>
        {artifacts.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">No artifacts generated yet.</p>
        ) : (
          <ul className="divide-y divide-slate-700/30">
            {artifacts.map((artifact) => (
              <li key={artifact.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-200">{artifact.path}</p>
                    <p className="mt-1 text-[11px] text-slate-500">{artifact.projectName} · {artifact.kind}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`badge ${artifact.status === "approved" ? "badge-ok" : artifact.status === "rejected" ? "badge-bad" : "badge-warn"}`}>{artifact.status}</span>
                    <button className="btn btn-ghost px-2 py-1 text-[11px]" onClick={() => setExpandedArtifact(expandedArtifact === artifact.id ? null : artifact.id)}>View</button>
                    {artifact.status === "proposed" && (
                      <>
                        <button className="btn btn-primary px-2 py-1 text-[11px]" disabled={busy} onClick={() => decide(artifact.id, "approve")}>Approve</button>
                        <button className="btn btn-ghost px-2 py-1 text-[11px]" disabled={busy} onClick={() => decide(artifact.id, "reject")}>Reject</button>
                      </>
                    )}
                  </div>
                </div>
                {artifact.rationale && <p className="mt-1 text-[11px] text-slate-400">{artifact.rationale}</p>}
                {expandedArtifact === artifact.id && (
                  <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-ink-950/80 p-3 text-[11px] text-slate-300">{artifact.content}</pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
