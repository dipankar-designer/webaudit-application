# Testing

## Automated suites

Start the development database first (`npm run db:start`). The tests use the separate `wpcg_test` database, which is reset on every run.

```bash
npm test                      # all workspaces
npm test -w @wpcg/server      # 93 tests, ~4 minutes (real Chrome scans)
npm test -w @wpcg/client      # component and formatting tests
```

### Server (`server/test/`)

| File | Covers |
|---|---|
| `units.test.ts` | robots.txt rules, URL normalisation and link extraction, axe→severity/WCAG mapping, rule catalogue completeness (every rule has severity reason, steps and verification; Critical only for availability), fingerprints and coverage keys, pixel comparison, evidence scrubbing, first-party detection, CSV escaping |
| `security.test.ts` | 19 private/reserved IP forms blocked, public IPs allowed, URL policy (schemes, credentials, decimal/hex IPs, ports, internal names), connect-time DNS blocking, open redirect to an internal service refused, response size cap, egress proxy refusing HTTP and CONNECT to internal and metadata addresses |
| `integration.test.ts` | Real API + PostgreSQL + Chrome against `fixtureSite.ts`: auth, CSRF and Origin protection, no account enumeration, cookie flags, refused targets, authorisation confirmation, plan limits, a full scan detecting 20 expected defect types and *not* reporting absent ones, link grouping, viewport-specific overflow, review statuses, workspace isolation (scans, issues, reports, screenshots), overview numbers equal database counts, visual comparison plan gating, resolution of fixed issues while untested ones stay open, visual change flagged for review, report/CSV/PDF export, reopening, verification scans (resolve and Not Tested), cancellation, monthly quota, deletion with files, AI disabled path |
| `performance.test.ts` | Advanced performance analysis on hand-made Lighthouse fragments (labelled as such): request extraction (sizes, durations, first/third party, `data:` URLs skipped, 300-request cap), exact test settings with missing values as null, scan comparison (measured changes, newly failing/now passing audits, different-condition notes, first scan), WordPress asset grouping by folder, possible duplicate assets, caching/compression indicators with evidence, and the AI prompt (measured data only, rules against invented causes) |

Also in `integration.test.ts`: the comparison endpoint against the latest earlier scan (workspace-scoped), and the AI fix-plan endpoints when AI is not configured. In `client/src`: `useApi` (path-scoped data, `keepPrevious`, polling recovery) and the comparison's noise thresholds.

The fixture site (`server/test/fixtureSite.ts`) has deliberate defects: missing `lang`, broken link and image, redirecting link, uncaught JS error and console error, 1200 px wide element, oversized image, heading skip, duplicate IDs, unlabeled input, low contrast, invalid JSON-LD, `noindex`, a 500 page in the sitemap, and a robots-disallowed path. `setFixed(true)` repairs most of them; `setBanner(true)` changes the layout for visual comparison.

## Browser end-to-end check of the UI

With the API (and a worker), the web client and the fixture site running (fixture on 4599 with `SCAN_ALLOW_PRIVATE_TARGETS=127.0.0.1:4599`):

```bash
node scripts/e2e-ui.mjs http://127.0.0.1:5174 http://127.0.0.1:4599/ ./screens
```

It takes about 2 minutes and runs 52 checks: the public landing page (with axe-core), the landing scan box carrying the address through sign-up, preflight blocking a private address, scope summary before scanning, authorisation gate, a full scan through the form with live progress, UI counts matching stored data, report sections, CSV and PDF downloads, issue filters, all ten issue-detail sections, axe-core WCAG A/AA on the app's own pages, no horizontal scrolling at 390 px on every main route, the mobile menu, sign-out, and no console errors.

## Results at the time of writing (2026-10-26)

- Server: **93/93 passed** (`npx vitest run` in `server/`).
- Client: **4/4 passed**.
- UI end-to-end: **52/52 passed**.
- Production bundle (`npm run build`, `node server/dist/index.js`) served the SPA and API and completed a real scan of a public website (https://example.com, 1 page, desktop + mobile, Lighthouse) in 23 s.

## Not covered by automated tests

- Live Anthropic and Ollama calls (no API key on the build machine). The code paths compile against the official SDK types; only the disabled path is tested.
- Docker image build.
- Very large sites (hundreds of pages), slow or hostile servers beyond the fixture, and non-Windows hosts (development and tests ran on Windows 11 with Chrome).

## Product workflow walk-through

`node scripts/e2e-workflow.mjs http://127.0.0.1:5174 http://127.0.0.1:4599/ ./screens` (add `--skip-ai` if no AI provider is configured) follows the nine product steps in a real browser: enter the URL on the landing page → start a Full scan → check the left category bar (every category listed, clicking one shows only its issues, counts add up) → screenshots and baseline → AI explanation (local Ollama in development; this can take a few minutes on a CPU-only machine) → priority tiles filter the results → inline "How to fix" steps and the issue page → repair the fixture and re-scan to see issues resolved and the visual change flagged → scan history and earlier reports.

## Monitoring (Phase 5)

See [MONITORING.md § Tests](MONITORING.md#tests). Summary of the last run (2026-10-28):

| Suite | Result |
|---|---|
| `npm test -w @wpcg/server` (unit, security, scans, monitoring) | 120/120 |
| `npm run test:live -w @wpcg/server` (badssl.com, irishmediaagency.ie) | 8/8 |
| `node scripts/e2e-monitoring.mjs` (UI, scheduler, axe WCAG 2.2, keyboard, 390px) | 40/40 |
| `node scripts/e2e-ui.mjs` (existing audit UI, dark theme regression) | 52/52 |
| `node scripts/e2e-workflow.mjs --skip-ai` (nine-step audit workflow) | 16/16 |
| `node client/scripts/contrast.mjs` (theme colour pairs) | 83/83 |
| `npm test -w @wpcg/server` after verified reporting + Lighthouse report (2026-10-28 PM) | 129/129 |
| Client tests (WordPress section, verification panel, Back fallback) | 9/9 |
| Live: three all-pages full scans of yellowumbrellatours.ie (98/98 pages); comparison in `docs/audits/` | Done |

Mocks: none of these present simulated results as real. The SMTP server in the monitoring tests is a real local SMTP listener; Stripe events are signed with Stripe's own test-header helper and verified by the production code path. No live Stripe payment and no delivery through a public mail provider were performed.
