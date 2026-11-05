# Architecture

```
 Browser (React SPA)
        │  same-origin /api, cookie session + CSRF header
        ▼
 API server (Express 5, Node)  ───────────────┐
   auth · websites · scans · issues ·          │ SQL
   reports (JSON/CSV/PDF) · AI · settings      ▼
        │ enqueue = INSERT scans(status=queued)   PostgreSQL 17
        ▼                                      ▲  users, workspaces, sessions, websites,
 Scan worker(s) (Node)  ── claim with ─────────┘  scans (= job queue), pages, findings,
   FOR UPDATE SKIP LOCKED, heartbeat              issues, events, coverage, screenshots,
        │                                         baselines, visual comparisons, usage
        ├─ safeFetch (Node HTTP, DNS-pinned) ──► target website (discovery, availability, links, headers)
        ├─ Chrome via Playwright ──► egress proxy (SSRF filter) ──► target website
        ├─ Lighthouse's Chrome ────► egress proxy ──► target website
        └─ screenshots / diff images ──► STORAGE_DIR (per workspace / scan)
```

## Repository layout

| Path | Contents |
|---|---|
| `shared/` | Domain vocabulary and API types shared by server and client (severities, statuses, categories, plans, DTOs) |
| `server/src/security/` | SSRF policy (`ssrf.ts`), DNS-pinned HTTP client (`safeFetch.ts`), browser egress proxy (`egressProxy.ts`) |
| `server/src/scanner/` | Engine, discovery, rule catalogue, axe mapping, browser scripts, per-category checks, persistence |
| `server/src/queue/worker.ts` | Job claiming, heartbeat, cancellation, stale recovery |
| `server/src/routes/` | REST API |
| `server/src/reports/` | Report assembly, CSV and PDF export |
| `server/src/ai/` | Optional AI provider (Anthropic SDK / Ollama) |
| `server/src/db/migrations/` | SQL schema |
| `server/test/` | Fixture website, unit, security and end-to-end API tests |
| `client/src/` | React app: pages, UI components, API client |
| `scripts/` | Dev database launcher, browser end-to-end check |

## Key decisions

**Node.js/TypeScript backend instead of Python/FastAPI.** The specification allows another well-justified backend. The scanning stack (Playwright, axe-core, Lighthouse) is native to Node, so one language and runtime covers the API, the worker and the shared domain types used by the React client. There is no IPC between a Python API and a Node browser service. On the development machine Python was also not usable.

**PostgreSQL as both database and job queue.** Scans are rows; workers claim them with `FOR UPDATE SKIP LOCKED`, renew a heartbeat every 10 s, and stale scans (no heartbeat for 3 min) are re-queued once and then failed. This gives durable, transactional queuing without operating Redis. The queue can be swapped for SQS or BullMQ later behind `claimNext()`/`processScan()`. Local development uses a real PostgreSQL 17 from `embedded-postgres`, so tests run against the same engine as production.

**Plain SQL migrations and `pg`.** The schema is a reviewable SQL file. Queries are explicit and scoped by `workspace_id`. A migration lock (`pg_advisory_lock`) serialises the API and worker at start-up, and the migrator refuses non-UTF8 databases.

**Separate API and worker processes.** Browser automation runs in the worker process (or container), so it can be isolated on its own network with egress-only access. In development the worker can run inside the API process (`RUN_WORKER_IN_PROCESS=true`).

**Issues are persistent; findings are per scan.** An issue is identified by a fingerprint `(rule, viewport if relevant, target)` per website. Each scan adds findings (evidence) to issues. Status changes are recorded as events. See *Verification and resolution* below.

**Deterministic rules with documented severity.** Each rule in `scanner/rules.ts` carries its severity, the policy reason (docs/SEVERITY.md), detection method, confidence, limitations and plain-language remediation. axe-core results map impact to severity by a fixed table and add WCAG criteria from axe tags.

**Workspaces from day one.** All customer data hangs off a workspace (team/agency-ready). Plans and limits attach to the workspace, and every query checks membership through the session.

## Scan pipeline

1. **Discovery** (`discovery.ts`): fetch the start URL, then robots.txt and sitemaps (`Sitemap:` lines, or `/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`). Crawl same-host links breadth-first up to `SCAN_MAX_CRAWL_DEPTH` and the page limit. Admin, login, cart, checkout and logout URLs, non-HTML files and robots-disallowed paths are skipped. Redirecting URLs are de-duplicated by final address.
2. **Per page** (bounded concurrency): availability findings from the HTTP response. For HTML pages, an isolated Chrome context per viewport collects console errors, exceptions and failed requests; the DOM is extracted by a read-only script; axe-core runs on the first viewport; and a full-page screenshot is taken when responsive or visual checks are enabled.
3. **Site level**: HTTPS/redirect and header checks on the start page, cross-page SEO (duplicate titles/descriptions, robots, sitemap).
4. **Links**: unique targets checked once (HEAD→GET), at most 2 concurrent requests per host, up to `LINK_CHECK_MAX`.
5. **Visual**: screenshots compared with the baseline scan's screenshots for the same URL and viewport (pixelmatch). Height changes count as changed area. The settings used are stored with each comparison.
6. **Performance**: Lighthouse on the first `LIGHTHOUSE_MAX_PAGES` pages per viewport. Lab metrics are stored per page.
7. **Persist** (one transaction): findings → issues and status transitions, check-run records, and coverage keys.

Every category writes a `check_runs` row: `completed`, `partial`, `failed`, `skipped` or `unavailable`, with a human-readable note. The UI and reports show these, so "no findings" is never confused with "not tested".

## Verification and resolution

Each finding produces a coverage key `check|viewport|page`. Each scan stores the keys it successfully tested. After a scan:

- Detected and new → `open` (or `needs_review` / `inconclusive` for heuristic or blocked results).
- Detected and previously `resolved` → `reopened`.
- Not detected → `resolved` **only if** every coverage key from the issue's last detection was re-tested in this scan. Otherwise the status is unchanged. If the scan was a verification scan for that issue, the status becomes `not_tested` with an explanation.

Examples: a desktop-only quick scan cannot resolve a mobile overflow issue. A scan where Lighthouse did not run cannot resolve performance issues. Pages dropped from the crawl keep their issues open. External-link issues are only resolved by scans that check external links.

## Frontend

React 19, React Router 7, Tailwind CSS 4, Lucide icons and Inter (self-hosted via Fontsource, no external requests). Components in `client/src/components/ui.tsx` cover buttons, badges with text and icon (never colour alone), accessible tooltips, native `<dialog>` modals, and loading, empty and error states. Data loading uses a small `useApi` hook with polling while scans run. The app passes axe-core WCAG A/AA checks on its main pages and has no horizontal scrolling at 390 px (see docs/TESTING.md).

## Package versions

Node 22.19+ (Lighthouse 13 requirement) · Express 5.1 · pg 8.16 · zod 3.25 · Playwright-core 1.63 (system Chrome or Playwright image) · axe-core 4.11+ (4.14 installed) · Lighthouse 13.4 · pixelmatch 7 / pngjs 7 · cheerio 1.2 · @anthropic-ai/sdk 1.3 · React 19.3 · React Router 7.18 · Vite 7.3 · Tailwind 4.3 · Vitest 3.2 · PostgreSQL 17.
