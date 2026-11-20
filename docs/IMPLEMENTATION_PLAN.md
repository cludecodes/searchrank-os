# SEARCHRANK OS — Implementation Plan

## Environment findings (verified 2026-11-20)

| Item | Finding | Decision |
|---|---|---|
| Workspace | Empty (`D:\SEARCHRANK OS`) | Greenfield build |
| Node | v26.10.0 | Use native `node:crypto`, `fetch`, `node:test` compatibility |
| pnpm | 10.30.3 | Package manager |
| Docker | Not installed | Provide config, but do not depend on it |
| Local Postgres / psql | Not installed | Use **PGlite** (real Postgres compiled to WASM) for local dev + tests |
| Neon account | Configured (org `CStudio`, 3 existing unrelated projects) | **Do not touch existing projects.** Production uses `DATABASE_URL` (Neon serverless) |
| Network / npm registry | Reachable | Install real dependencies |
| OAuth credentials | None provided | Integrations implemented with real APIs; they activate when credentials are supplied. No fake data. |

## Guiding rule

No decorative dashboard. Every metric on screen is computed from rows in Postgres.
Every integration is real HTTP against the provider's API. Agents persist their runs
and outputs. High-risk actions (PR creation, publishing, deployment, indexing
submission) require explicit human approval and write an audit log.

## Architecture

```
Next.js 16 (App Router, RSC)  ──►  Route handlers / Server actions
        │                                    │
        ├── Repository layer (Drizzle ORM) ──┤
        │                                    ▼
        │                       Postgres schema (single source of truth)
        │                       local: PGlite | prod: Neon serverless
        │
        ├── Job queue (DB-backed) ──► Worker process ──► Job handlers
        │                                    │
        │                    ┌───────────────┼────────────────┐
        │                    ▼               ▼                ▼
        │             SEO audit engine   Agents       Search-engine sync
        │
        └── Integration clients (GitHub, Vercel, GSC, Bing, IndexNow)
                    │
                    └── AES-256-GCM encrypted tokens, least-privilege scopes
```

## Data domains (all persisted)

identity (users, sessions, workspaces, memberships), projects, integration
credentials, jobs + logs, SEO audits, pages, keywords + history + clusters,
competitors, content items, backlink opportunities, indexing submissions,
search metrics, deployments, agent runs, approvals, audit logs, reports,
schedules, rate limits.

## Phase execution plan

### Phase 1 — Platform foundation (completed & verified)
- [x] Inspect environment
- [x] Scaffold Next.js 16 + TypeScript 5.9 + Tailwind 4
- [x] Drizzle schema (27 tables) for every domain above + generated migrations
- [x] PGlite local / Neon production database factory + migration runner
- [x] Auth: scrypt hashes, DB sessions, RBAC, rate limiting, audit log
- [x] DB-backed job queue + worker + scheduler with retries and logs
- [x] AI provider abstraction (OpenAI-compatible / Anthropic / injected mock)
- [x] Integration clients with real API endpoints + encrypted credentials
- [x] Technical SEO audit engine with real HTML/HTTP checks
- [x] Agent framework + 12 agent definitions + supervisor orchestration
- [x] Test suite: 37 tests across 7 suites, all passing
- [x] Docs, `.env.example`, Dockerfile, docker-compose, vercel.json
- [x] End-to-end smoke test: login → project → job → worker → persisted audit → dashboard

### Phase 2 — Project discovery engine (completed & verified)
- [x] GitHub/Vercel OAuth connect (start + callback routes, encrypted tokens)
- [x] Repository discovery (public repos only; private never imported)
- [x] Vercel project discovery + production domain resolution
- [x] Framework/technology detection from manifests
- [x] Business category inference (observable metadata only)
- [x] Deployment failure detection (non-READY production deployments)
- [x] Preview deployment identification
- [x] Duplicate domain detection across GitHub + Vercel sources
- [x] Centralized project registry (projects + deployments tables)
- [x] Manual project registration fallback (existing API + UI)
- [x] Discovery dashboard page (`/dashboard/discovery`)
- [x] Tests: 4 discovery engine tests, all passing

### Phase 3 — Multi-agent workforce (completed & verified)
- [x] Supervisor workflow engine: evidence-driven plans, priority assignment,
      duplicate-job prevention, result evaluation, persisted audit events
- [x] CHIEF_SUPERVISOR wired to plan + evaluation + job enqueue
- [x] Keyword agent: country/intent clusters + immutable ranking history
- [x] Competitor agent: content gaps derived from live headings vs stored data
- [x] Indexing agent: sitemap from verified pages, robots discovery, per-URL
      submission logging, approval gate retained
- [x] Analytics agent: real weekly/monthly comparison from persisted metrics
- [x] Quality agent: dangerous code-change detection in approval payloads
- [x] Agent control UI (`/dashboard/agents`): run buttons, plan preview/execute,
      run history, approval queue with decisions
- [x] APIs: `/api/agents` (runs, approvals, evaluations), `/api/supervisor/plan`
- [x] Tests: 10 new Phase 3 tests (51 total), all passing
- [x] End-to-end: supervisor plan → 3 jobs → worker → 3 persisted agent runs
      (audit score 72, honest skip for disconnected sources)

### Phase 4 — Technical SEO automation
Real audit execution, sitemap/robots generation, structured-data validation,
broken-link and orphan-page detection. Never fabricate data.

### Phase 5 — Keyword intelligence
Keyword store with source + retrieval date, intent, clusters, history,
prioritization by business value. No invented volumes.

### Phase 6 — Content production
Briefs → drafts → review → approval → publish workflow, originality checks,
internal-link planning, per-item approval status.

### Phase 7 — Search engine integration
GSC/Bing OAuth + performance sync + sitemap submission; IndexNow notifications.
No indexing guarantees.

### Phase 8 — GitHub/Vercel automation
Branch → lint/typecheck/tests → PR → preview → approval → merge/rollback,
with audit trail.

### Phase 9 — Dashboard
Premium enterprise UI reading only real persisted data.

### Phase 10 — Business growth engine
Problem/demand/intent/weakness mapping tied to qualified leads and revenue.

### Phase 11 — Automation & reporting
Hourly/daily/weekly/monthly schedules; executive reports from real data.

### Phase 12 — Security & quality
Encryption, least privilege, rate limits, RBAC, backups, approvals, tests.

## Testing strategy

- `pnpm test` — Vitest unit/integration suite against in-memory PGlite.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm build` — production Next.js build.
- `pnpm test:e2e` — API smoke tests against a running dev server (later phases).
- External APIs are never called in tests; clients take an injectable `fetch`.

## What requires the operator (you)

To activate live integrations, you will need to provide OAuth app credentials
(GitHub, Vercel, Google, Microsoft/Bing), an IndexNow key, an AI API key, and
`DATABASE_URL` + `MASTER_ENCRYPTION_KEY`. The app will run fully locally with
PGlite without these, and will clearly report "not configured" instead of
inventing data.
