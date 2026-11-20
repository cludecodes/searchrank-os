"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "login" ? { email, password } : { email, password, name }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Request failed");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500 text-xl font-black text-ink-950">
            SR
          </div>
          <h1 className="text-2xl font-bold tracking-tight">SEARCHRANK OS</h1>
          <p className="mt-2 text-sm text-slate-400">Search intelligence, automation and growth operations.</p>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-7">
          <div className="flex gap-2 rounded-xl bg-slate-900/60 p-1">
            {(["login", "register"] as const).map((option) => (
              <button
                type="button"
                key={option}
                onClick={() => { setMode(option); setError(""); }}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold capitalize transition ${
                  mode === option ? "bg-brand-500 text-ink-950" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {option}
              </button>
            ))}
          </div>

          {mode === "register" && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-400">Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </label>
          )}
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">Email</span>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">Password {mode === "register" && "(12+ characters)"}</span>
            <input className="input" type="password" required minLength={mode === "register" ? 12 : 1} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

          <button className="btn btn-primary w-full" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
          <p className="text-center text-xs text-slate-500">
            Sessions are hashed at rest. Passwords use scrypt. No credentials are stored in plaintext.
          </p>
        </form>
      </div>
    </main>
  );
}
