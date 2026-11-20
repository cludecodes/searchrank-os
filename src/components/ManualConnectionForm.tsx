"use client";

import { useState } from "react";

interface Diagnostics {
  provider: string;
  label: string;
  oauthAppConfigured: boolean;
  callbackUrl: string | null;
  connected: boolean;
  connectionMethod: string | null;
  status: string | null;
}

export function ManualConnectionForm({ provider, label }: { provider: string; label: string }) {
  const [token, setToken] = useState("");
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<Diagnostics | null>(null);

  async function load() {
    const response = await fetch("/api/integrations/diagnostics", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      setInfo((data.providers ?? []).find((p: Diagnostics) => p.provider === provider) ?? null);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/integrations/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, accessToken: token, accountIdentifier: account || "manual" }),
      });
      const payload = await response.json();
      setStatus(response.ok ? `${label} connected. Token stored encrypted; it is never displayed again.` : payload.error || "Failed");
      if (response.ok) {
        setToken("");
        await load();
        setTimeout(() => location.reload(), 700);
      }
    } catch {
      setStatus("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5" onMouseEnter={() => { if (!info) load(); }}>
      <h2 className="text-sm font-semibold">Connection diagnostics</h2>
      <div className="mt-3 space-y-1 text-xs text-slate-400">
        <p>OAuth app credentials: {info ? (info.oauthAppConfigured ? "configured" : "missing") : "loading…"}</p>
        <p>Callback URL sent to provider: <span className="text-slate-200">{info?.callbackUrl ?? "—"}</span></p>
        <p>Stored connection: {info ? (info.connected ? `${info.status} (${info.connectionMethod ?? "oauth"})` : "none") : "loading…"}</p>
        {!info?.oauthAppConfigured && provider === "vercel" && (
          <p className="text-amber-300">No Vercel OAuth client ID/secret was provided. Use a Vercel API token below to connect.</p>
        )}
        {info?.oauthAppConfigured && !info.connected && (
          <p className="text-amber-300">
            If GitHub reports “redirect_uri is not associated”, add <code className="text-brand-300">{info.callbackUrl}</code>{" "}
            to the OAuth app’s redirect URIs in GitHub Developer Settings — or use a token below.
          </p>
        )}
      </div>

      <form onSubmit={submit} className="mt-4 space-y-3 border-t border-slate-700/40 pt-4">
        <p className="text-xs font-semibold text-slate-300">Connect with an access token</p>
        <input className="input text-xs" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste GitHub / Vercel access token" required minLength={10} />
        <input className="input text-xs" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Account identifier (optional)" />
        <button className="btn btn-primary text-xs" disabled={busy || !token}>Save encrypted token</button>
        {status && <p className="text-xs text-brand-300">{status}</p>}
        <p className="text-[11px] text-slate-500">Tokens are AES-256-GCM encrypted at rest and never echoed back. Use a least-privilege token.</p>
      </form>
    </div>
  );
}
