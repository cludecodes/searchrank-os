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

### Phase 4 — Technical SEO automation (completed & verified)
- [x] Deep HTML checks: viewport/mobile signal, image alt + intrinsic dimensions,
      Open Graph/Twitter completeness, JSON-LD parsing
- [x] Fabricated rating/review markup flagged for human review (never emitted)
- [x] Real redirect-chain and redirect-loop detection
- [x] Site-wide analysis: duplicate content/titles/descriptions + orphan pages
      from persisted audit link graphs
- [x] Framework-aware artifact generation (Next.js sitemap route vs static XML,
      robots.txt, Organization JSON-LD, metadata suggestions) from verified rows only
- [x] `seo_artifacts` table with proposal → approved/rejected workflow + audit log
- [x] Job handlers: `seo.artifacts.generate`, `seo.site.analysis`
- [x] APIs: `/api/seo/artifacts` (list/generate/decide), `/api/seo/site-audit`
- [x] Dedicated `/dashboard/audits` workspace with findings evidence and artifact review
- [x] Tests: 8 new Phase 4 tests (59 total), all passing
- [x] End-to-end: 4 artifact proposals generated from audited pages, site analysis
      job executed, artifact approval recorded with reviewer id

### Phase 5 — Keyword intelligence (completed & verified)
- [x] Keyword research engine with two real sources: GSC search analytics and
      Bing Webmaster `GetQueryStats` (documented endpoint)
- [x] Intent classification, commercial relevance scoring, value-based priority
      (observed clicks/impressions/position/intent — never search volume alone)
- [x] Underserved-opportunity detection from impressions/CTR/position
- [x] Country/intent clusters with observed target landing page
- [x] Immutable keyword history snapshots + computed rank trend
- [x] Competitor URLs associated only from registered, observed competitors
- [x] Source + retrieval date on every record; volume/difficulty stay null when
      unavailable; manual keyword fallback without invented statistics
- [x] APIs: `/api/keywords` (list/manual), `/api/keywords/[id]`,
      `/api/keywords/research`, `/api/keywords/clusters`
- [x] Dedicated `/dashboard/keywords` workspace
- [x] Tests: 7 new Phase 5 tests (66 total), all passing
- [x] End-to-end: manual keyword persisted with source=manual/null volume;
      research job executed and honestly skipped with no connected sources

### Phase 6 — Content production (completed & verified)
- [x] Editorial state machine: idea → brief → draft → in_review → approved →
      published, with rejection/revert and admin-only approve/publish
- [x] Required-field validation before review/approval/publish (intent, cluster,
      audience, UVP, research, internal links, URL, metadata, body)
- [x] Evidence-based brief builder from stored keywords/clusters/competitor gaps/
      pages/question queries — works with no AI provider and invents no facts
- [x] Content Strategy Agent now generates deterministic briefs; AI is optional refinement
- [x] Content Production Agent runs quality checks (fabricated claims, keyword
      stuffing, thin content, duplicate risk) and rejects unsafe drafts
- [x] APIs: `/api/content` (list/create), `/api/content/[id]` (edit),
      `/api/content/[id]/transition`, `/api/content/generate`
- [x] `/dashboard/content` Content Studio with pipeline stats, evidence detail
      and transition actions
- [x] IndexNow key configured and hosted at a real key-location URL; per-project
      key-location override added for client domains
- [x] Tests: 6 new Phase 6 tests (72 total), all passing
- [x] End-to-end: brief job → worker → evidence-based brief → full transition
      chain to published; invalid jumps blocked with 409

### Phase 7 — Search engine integration (completed & verified)
- [x] Google Search Console: site listing, search analytics, sitemap submission,
      URL inspection and sitemap issue monitoring — all via real API calls
- [x] Bing Webmaster: site listing, query stats, sitemap submission, URL batch
      submission within real daily quota, crawl-issue monitoring
- [x] Microsoft Edge visibility derived honestly from Bing data (no separate API claim)
- [x] Approval gates for sitemap/URL submissions; IndexNow with per-project key location
- [x] Service layer `src/core/search-engines/service.ts` with real provider responses
      and persisted submission/check/metric records
- [x] Agents: new modes on INDEXING_AGENT and ANALYTICS_AGENT; job handlers
      `search.sync`, `search.issues.monitor`, `search.sitemap.submit`,
      `search.url.inspect`, `search.bing.urls`
- [x] APIs `/api/search-engines` and `/api/search-engines/actions`; dedicated
      `/dashboard/google`, `/dashboard/bing`, `/dashboard/indexing` pages
- [x] Honest behavior: no connected engine → sync returns 0 rows, actions skip
      with a reason; acceptance is never presented as indexing guarantee
- [x] Tests: 7 new Phase 7 tests (79 total), all passing
- [x] End-to-end: endpoints and three dashboard pages returned 200; sync job queued

### Phase 8 — GitHub/Vercel automation (completed & verified)
- [x] `code_pipelines` table with immutable step history, approval ids, checks,
      preview URL and before/after metrics (migration applied to Neon)
- [x] Real GitHub operations: branch, file writes, branch head, PR, merge and
      revert-PR rollback — no force-push to production
- [x] Approval gates: change approval before branch creation, separate merge
      approval before merge, separate rollback approval before revert PR
- [x] Check runner abstraction reading real GitHub check-run conclusions;
      pipelines stop before PR when checks fail
- [x] Vercel preview discovery from real deployments; deployments persisted
- [x] Before/after metrics from persisted audit + search-metric rows only
- [x] APIs `/api/automation/pipelines`, `/api/automation/pipelines/[id]`
      and `/advance`; job handlers `pipeline.advance`, `pipeline.rollback`
- [x] `/dashboard/automation` with proposal form, step timeline, approval
      actions, PR/preview links and metrics delta
- [x] Tests: 6 new Phase 8 tests (85 total), all passing
- [x] Full branch → checks → PR → merge → rollback chain tested with mocked APIs

### Phase 9 — Dashboard (completed & verified)
- [x] Executive aggregation service (`executive.ts`) over persisted rows:
      websites, indexed URLs, audit health, weekly clicks/impressions deltas,
      position, CTR, top-3/top-10, conversions, clusters, content funnel,
      indexing checks, deployments, jobs, approvals, agent runs, activity feed
- [x] Premium overview: health gauge, visibility funnel, content funnel,
      per-project health bars, system health, activity timeline
- [x] AI provider switched to free, keyless open-weight GPT-OSS 20B
      (Pollinations OpenAI-compatible endpoint); live completion verified
- [x] All sample/demo rows removed from production (22 tables truncated);
      admin identity, workspace and schedules retained
- [x] Tests: 3 new Phase 9 tests (88 total), all passing

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
