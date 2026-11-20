"use client";

import { useCallback, useEffect, useState } from "react";

interface AgentView {
  key: string;
  name: string;
  mission: string;
  responsibilities: string[];
  toolsets: string[];
  canMutateProduction: boolean;
  evaluation: { runs: number; succeeded: number; failed: number; skipped: number; successRate: number; lastStatus: string } | null;
}

interface RunView {
  id: string;
  agentKey: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  output: Record<string, unknown>;
  error: string | null;
}

interface ApprovalView {
  id: string;
  actionType: string;
  description: string;
  risk: string;
  status: string;
  createdAt: string;
}

interface PlanView {
  generatedAt: string;
  totalPlanned: number;
  plans: Array<{ projectName: string; jobs: Array<{ type: string; priority: string; reason: string }> }>;
  evaluations: Array<{ agentKey: string; successRate: number; runs: number }>;
}

const fmt = (value: string | null) => (value ? value.slice(0, 16).replace("T", " ") : "—");

export default function AgentsControlPage() {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [agentRes, projectRes] = await Promise.all([
      fetch("/api/agents", { cache: "no-store" }),
      fetch("/api/projects", { cache: "no-store" }),
    ]);
    if (agentRes.ok) {
      const data = await agentRes.json();
      setAgents(data.agents ?? []);
      setRuns(data.runs ?? []);
      setApprovals((data.approvals ?? []).filter((a: ApprovalView) => a.status === "pending"));
    }
    if (projectRes.ok) {
      const data = await projectRes.json();
      setProjects((data.projects ?? []).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })));
      setSelectedProject((current) => current || data.projects?.[0]?.id || "");
    }
  }, []);

  const loadPlan = useCallback(async () => {
    const response = await fetch("/api/supervisor/plan", { cache: "no-store" });
    if (response.ok) setPlan((await response.json()).plan);
  }, []);

  useEffect(() => { load(); loadPlan(); }, [load, loadPlan]);

  async function runAgent(key: string) {
    setBusy(true);
    setStatus(`Queued ${key}…`);
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: key, projectId: selectedProject || undefined, input: {} }),
      });
      const payload = await response.json();
      setStatus(response.ok ? `Job ${String(payload.jobId).slice(0, 8)} queued.` : payload.error || "Failed");
      await load();
    } catch {
      setStatus("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  async function executePlan() {
    setBusy(true);
    setStatus("Executing supervisor plan…");
    try {
      const response = await fetch("/api/supervisor/plan", { method: "POST" });
      const payload = await response.json();
      setStatus(response.ok ? `Enqueued ${payload.enqueued?.length ?? 0} job(s).` : payload.error || "Failed");
      await load();
      await loadPlan();
    } catch {
      setStatus("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  async function decideApproval(id: string, decision: "approve" | "reject") {
    setBusy(true);
    try {
      const response = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: id, decision }),
      });
      const payload = await response.json();
      setStatus(response.ok ? `Approval ${decision}d.` : payload.error || "Failed");
      await load();
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
          <h1 className="mt-2 text-3xl font-bold tracking-tight">AI Agents Control</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Twelve independent agents, each with a persisted run history. High-risk actions create an approval
            request — no agent mutates production directly.
          </p>
        </div>
        <select className="input w-auto min-w-52 py-2 text-xs" value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
          <option value="">No project selected</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </section>

      {status && <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-2 text-xs text-brand-300">{status}</div>}

      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Chief Supervisor — workflow plan</h2>
            <p className="mt-1 text-xs text-slate-500">
              {plan ? `${plan.totalPlanned} planned job(s) across ${plan.plans.length} project(s), derived from persisted evidence.` : "Loading plan…"}
            </p>
          </div>
          <button className="btn btn-primary text-xs" disabled={busy} onClick={executePlan}>Execute plan now</button>
        </div>
        {plan && plan.plans.length > 0 && (
          <ul className="mt-4 space-y-2">
            {plan.plans.map((p) => (
              <li key={p.projectName} className="rounded-lg border border-slate-700/40 px-3 py-2 text-xs">
                <p className="font-semibold text-slate-200">{p.projectName}</p>
                <ul className="mt-1 list-inside list-disc text-slate-400">
                  {p.jobs.map((j, i) => (
                    <li key={i}><span className="text-brand-400">{j.type}</span> ({j.priority}) — {j.reason}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Agent workforce</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <div key={agent.key} className="card flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-100">{agent.name}</p>
                  <p className="mt-1 text-[11px] leading-snug text-slate-500">{agent.mission}</p>
                </div>
                <span className={`badge ${agent.canMutateProduction ? "badge-warn" : "badge-info"}`}>
                  {agent.canMutateProduction ? "gated" : "read-only"}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {agent.toolsets.slice(0, 4).map((tool) => <span key={tool} className="badge badge-muted">{tool}</span>)}
              </div>
              <div className="mt-auto flex items-center justify-between gap-2 border-t border-slate-700/30 pt-3">
                <span className="text-[11px] text-slate-500">
                  {agent.evaluation?.runs
                    ? `${agent.evaluation.runs} run(s) · ${agent.evaluation.successRate}% success`
                    : "No runs yet"}
                </span>
                <button className="btn btn-ghost px-2 py-1 text-[11px]" disabled={busy} onClick={() => runAgent(agent.key)}>Run</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4">
            <h2 className="text-sm font-semibold">Run history</h2>
            <p className="mt-1 text-xs text-slate-500">Each run stores input, output, status and timestamps.</p>
          </div>
          {runs.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No agent runs recorded yet.</p>
          ) : (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-slate-500"><tr><th className="px-5 py-2">Agent</th><th className="px-5 py-2">Status</th><th className="px-5 py-2">Started</th><th className="px-5 py-2">Summary</th></tr></thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="table-row border-t border-slate-700/30 align-top">
                      <td className="px-5 py-2 text-slate-200">{run.agentKey.replace(/_/g, " ")}</td>
                      <td className="px-5 py-2">
                        <span className={`badge ${run.status === "succeeded" ? "badge-ok" : run.status === "failed" ? "badge-bad" : "badge-muted"}`}>{run.status}</span>
                      </td>
                      <td className="px-5 py-2 text-slate-500">{fmt(run.startedAt)}</td>
                      <td className="max-w-xs truncate px-5 py-2 text-slate-400">{String(run.output?.summary ?? run.error ?? "—")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-700/40 px-5 py-4">
            <h2 className="text-sm font-semibold">Approval queue</h2>
            <p className="mt-1 text-xs text-slate-500">High-risk agent actions wait here for a human decision.</p>
          </div>
          {approvals.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No pending approvals.</p>
          ) : (
            <ul className="max-h-96 space-y-2 overflow-auto p-4">
              {approvals.map((approval) => (
                <li key={approval.id} className="rounded-lg border border-slate-700/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-200">{approval.actionType}</span>
                    <span className={`badge ${approval.risk === "high" || approval.risk === "critical" ? "badge-bad" : "badge-warn"}`}>{approval.risk}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{approval.description}</p>
                  <div className="mt-2 flex gap-2">
                    <button className="btn btn-primary px-2 py-1 text-[11px]" disabled={busy} onClick={() => decideApproval(approval.id, "approve")}>Approve</button>
                    <button className="btn btn-ghost px-2 py-1 text-[11px]" disabled={busy} onClick={() => decideApproval(approval.id, "reject")}>Reject</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
