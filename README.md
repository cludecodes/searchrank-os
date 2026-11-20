# SEARCHRANK OS

Evidence-driven SEO operations platform. This repository contains the **working foundation**:
persistent Postgres storage, authentication and RBAC, a durable background job system, real
integration clients, an HTML/HTTP technical SEO audit engine, twelve AI agents, an approval
workflow, and a dashboard that renders only persisted data.

> No decorative metrics. If an integration is not connected, the UI says so. No rankings,
> traffic, ratings, testimonials or statistics are invented.

## Verified environment

Node v26.10.0 · pnpm 10.30.3 · no Docker or local Postgres installed. Local development and
tests therefore use **PGlite** (the real Postgres engine compiled to WASM). Production uses
**Neon serverless Postgres** via `DATABASE_URL`. Both drivers share one Drizzle schema and the
same generated SQL migrations.

## Quick start

```powershell
pnpm install
Copy-Item .env.example .env.local
# Set SEED_ADMIN_PASSWORD in .env.local, then:
pnpm db:generate     # already generated; re-run only after schema changes
pnpm db:migrate
pnpm db:seed
pnpm dev             # http://localhost:3000
```

In a second terminal, run the background worker:

```powershell
pnpm worker
```

Or process everything currently due once (useful for cron / CI):

```powershell
pnpm worker:once
```

Local PGlite is a single-process embedded database. Never open the same PGlite directory from
two processes (that corrupts it). If you want the web app and a separate worker process
simultaneously, set `DATABASE_URL` to a Neon Postgres connection string. Within one Next.js
process, the PGlite instance is shared on `globalThis` so route handlers and server components
see the same data.

## Verification

```powershell
pnpm typecheck   # TypeScript strict
pnpm test        # Vitest: database, security, jobs, AI, integrations, SEO, agents
pnpm build       # production Next.js build
```

37 tests currently pass across 7 suites. External APIs are never called by tests; every client
accepts an injected `fetch`.

An end-to-end smoke test was also performed against a clean local database: admin login →
manual project registration → audit job enqueue → `pnpm worker:once` → audit score 69 persisted
→ real score visible in `/dashboard` and `/dashboard/audits`.

## What works today

| Capability | Status | Notes |
|---|---|---|
| Users, workspaces, RBAC | Working | scrypt password hashes, DB-backed sessions, role hierarchy |
| Rate limiting | Working | Durable Postgres fixed-window limiter |
| Project registry | Working | Manual registration + GitHub/Vercel discovery agents |
| Credential storage | Working | AES-256-GCM envelopes; raw secrets never stored |
| Job queue | Working | Atomic claiming, retries with backoff, stale-lock recovery, logs |
| Scheduler | Working | hourly/daily/weekly/monthly schedules + Vercel Cron endpoint |
| AI abstraction | Working | OpenAI-compatible, Anthropic, or explicit "not configured" |
| GitHub client | Working | OAuth, public repo discovery, framework detection, branch + PR |
| Vercel client | Working | OAuth, project discovery, production deployment info |
| Google Search Console | Working | OAuth, sites, search analytics, sitemaps, URL inspection |
| Bing Webmaster | Working | OAuth, sites, quota, URL batch + sitemap submission |
| IndexNow | Working | Multi-engine submission with honest acceptance reporting |
| Technical SEO audit | Working | Real HTTP/HTML checks, deterministic score, broken-link checks |
| Keyword store | Working | Source + retrieval date + history; no invented volumes |
| Content workflow | Working | Brief → draft → review → approval → publish |
| 12 agents | Working | Each persists an agent run; high-risk actions require approval |
| Dashboard & reports | Working | All figures computed from persisted rows |
| Audit trail | Working | Auth, project changes, approvals and agent actions logged |

## What requires operator credentials

The platform is fully functional locally without external accounts, but live data requires:

- `DATABASE_URL` (Neon) for multi-process deployments
- `MASTER_ENCRYPTION_KEY` (base64 32 bytes) in production
- OAuth apps: GitHub, Vercel, Google Search Console, Bing Webmaster
- `INDEXNOW_KEY` + `INDEXNOW_KEY_LOCATION`
- `AI_PROVIDER` / `AI_API_KEY` / `AI_MODEL` for content and strategy agents
- `CRON_SECRET` if using Vercel Cron

See `.env.example`. Never commit `.env.local`.

## Architecture

```
src/
  app/                    Next.js App Router UI + API route handlers
  core/
    agents/               12 agent definitions + run framework
    ai/                   provider abstraction (OpenAI-compatible / Anthropic)
    auth/                 request context and permission guards
    db/                   schema, client factory, migrations
    integrations/         GitHub, Vercel, GSC, Bing, IndexNow, credentials, OAuth
    jobs/                 durable queue, worker, handlers
    reporting/            dashboard aggregates and section data
    seo/                  audit engine and persistence
    security/             crypto, passwords, sessions, RBAC, rate limits
tests/                    Vitest suites
scripts/                  migrate, seed, worker, worker-once
docs/IMPLEMENTATION_PLAN.md   phase-by-phase plan and scope
```

## Honest limitations

- Core Web Vitals and mobile friendliness need field/lab data from an authorized provider.
  The audit reports them as unavailable rather than guessing.
- IndexNow and sitemap submissions are requests; they do not guarantee crawling or indexing.
- No ranking position is generated. Rankings come only from GSC/Bing data when connected.
- The current UI covers the dashboard and all navigation sections with real data tables;
  deeper per-record editing screens are follow-on work.
- Existing Neon projects in the configured account were left untouched.

## Deployment

Docker: set `DATABASE_URL` to Neon, create `.env`, then `docker compose up --build`.
Vercel: import the repo, set the environment variables above, and deploy. Vercel Cron calls
`/api/cron/scheduler` every five minutes; run a worker (or a scheduled `worker:once`) to
execute queued jobs.
