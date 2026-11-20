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

Phase 3 was verified end-to-end against Neon: supervisor plan → 3 jobs enqueued →
`pnpm worker:once` → 3 persisted agent runs (audit score 72, analytics reported honestly
without GSC, keyword agent skipped without a data source) → visible in `/dashboard/agents`.

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
| GitHub client | Working | OAuth, public repo discovery, framework detection, branch, PR, merge, reviewed revert-PR rollback |
| Automation pipeline | Working | Approval-gated branch → checks → PR → preview → merge, with audit trail; `/dashboard/automation` |
| Vercel client | Working | OAuth, project discovery, production deployment info |
| Google Search Console | Working | OAuth, sites, search analytics, sitemap submission, URL inspection, issue monitoring |
| Bing Webmaster | Working | Sites, query stats, sitemap/URL submission with quota, crawl issues |
| Edge visibility | Working | Derived from Bing data with an explicit note — no separate Edge API |
| Bing Webmaster | Working | OAuth, sites, quota, URL batch + sitemap submission |
| IndexNow | Working | Multi-engine submission with honest acceptance reporting |
| Technical SEO audit | Working | Real HTTP/HTML checks, deterministic score, broken links, redirects, duplicates, orphans |
| SEO artifacts | Working | Framework-aware sitemap/robots/JSON-LD/metadata proposals from verified rows; approval required before applying |
| Keyword store | Working | Source + retrieval date + history; GSC + Bing query data; value-based priority; no invented volumes/difficulty |
| Content workflow | Working | Evidence-based briefs without AI; state machine with review/approval gates, quality checks and audit log |
| Content Studio | Working | `/dashboard/content` — pipeline stats, evidence detail, editorial transitions |
| 12 agents | Working | Persisted run history; supervisor workflow graph evaluates runs and enqueues evidence-driven jobs; high-risk actions require approval |
| Agent control UI | Working | `/dashboard/agents` — run agents, preview/execute supervisor plan, review run history and approvals |
| Keyword clusters & history | Working | Country/intent clusters with target landing page, immutable ranking snapshots and computed trends |
| Keyword workspace | Working | `/dashboard/keywords` — research trigger, manual fallback, opportunity/priority view |
| Indexing | Working | Sitemap from audited pages, dual-engine submission, per-URL logs, approval gate; `/dashboard/google`, `/dashboard/bing`, `/dashboard/indexing` |
| Dashboard & reports | Working | All figures computed from persisted rows |
| Audit trail | Working | Auth, project changes, approvals and agent actions logged |

## What requires operator credentials

The platform is fully functional locally without external accounts, but live data requires:

- `DATABASE_URL` (Neon) for multi-process deployments
- `MASTER_ENCRYPTION_KEY` (base64 32 bytes) in production
- OAuth apps: GitHub, Vercel, Google Search Console, Bing Webmaster
- `INDEXNOW_KEY` + `INDEXNOW_KEY_LOCATION`
- AI is preconfigured with **GPT-OSS 20B** (open-weight, free, keyless) through Pollinations:
  `AI_PROVIDER=pollinations`, `AI_MODEL=openai-fast`. No AI API key is required.
  Swap to `openai-compatible`/`anthropic` by setting a provider key if desired.
- IndexNow is configured and its key file is hosted at
  `https://searchrank-os.vercel.app/4235824ef8038304f94a5590722617b3.txt`. For client
  domains, set `indexNowKey`/`indexNowKeyLocation` in the project's SEO config — the
  protocol requires the key file on the host being submitted.
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

## Production data state

All sample/demo rows created during development were removed from the Neon database
(`pnpm db:seed` identity, workspace and schedules were retained). The production
dashboard starts empty by design and fills only with real discoveries, audits,
keywords and content. To repeat the cleanup: `pnpm tsx scripts/clean-sample-data.ts`.

## Deployment (live)

The `searchrank-os` Vercel project (`prj_IYgnJc0wWivierVKtc1Uk7LuVi6C`) is deployed at
**https://searchrank-os.vercel.app** and verified healthy (`/api/health`).

Configured in Vercel for Production, Preview and Development:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Dedicated Neon Postgres project `searchrank-os` (migrations + seed applied) |
| `MASTER_ENCRYPTION_KEY` | AES-256-GCM key for OAuth credentials at rest (Secret) |
| `CRON_SECRET` | Protects `/api/cron/scheduler` (Secret) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL` | GitHub OAuth |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Google Search Console OAuth |
| `NEXT_PUBLIC_APP_URL`, `ALLOW_SIGNUPS`, `SESSION_COOKIE_NAME`, `AI_PROVIDER`, `AI_MODEL` | App config (AI = free GPT-OSS 20B) |
| `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` | Vercel API access for deployments/previews (Secret + id); token also stored encrypted in the integration registry |

OAuth redirect URIs that must be registered in the provider consoles:

- `https://searchrank-os.vercel.app/api/integrations/github/callback`
- `https://searchrank-os.vercel.app/api/integrations/google_search_console/callback`

Not yet configured (no credentials provided): Vercel OAuth client, Bing Webmaster OAuth,
IndexNow key, AI provider. The dashboard reports these honestly as not configured.

Vercel Cron runs once daily on the Hobby plan (`0 3 * * *`) and calls
`/api/cron/scheduler` with `Authorization: Bearer $CRON_SECRET`. Queued jobs are executed
by a worker (`pnpm worker`) or a scheduled `pnpm worker:once`.

Docker: set `DATABASE_URL` to Neon, create `.env`, then `docker compose up --build`.
