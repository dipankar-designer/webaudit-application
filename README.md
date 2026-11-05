# WebAudit AI

Website monitoring, security watching, audits and change detection as a standalone SaaS web application (not a WordPress plugin).
Monitor sites around the clock (uptime, response time, certificates, domains, DNS, security headers, exposed files, defacement, new scripts, heartbeats), get one e-mail per incident, and run full audits with a real browser: plain-language findings with evidence, step-by-step fixes, verification scans and reports.

- **Honest monitoring.** A blocked or challenged check is *Not assessed*, never "down"; failures are retried before they count; our own failures are shown as *Monitoring error*; a missing scheduler heartbeat is shown on the dashboard.

- **Real scans only.** Every number in the UI comes from stored scan results. Nothing is simulated; checks that could not run are reported as *partial*, *not completed* or *unavailable*.
- **Safe by design.** Strict SSRF protection (DNS-pinned connections and a filtering proxy for the browser), no form submissions, no logins, and robots.txt respected during discovery.
- **AI is optional.** All checks are deterministic. AI (Anthropic Claude or a local Ollama model) only explains stored evidence when configured.

## Quick start (local development)

Requirements: Node.js 22.19+ (developed on Node 24), Google Chrome or Chromium installed. Docker is **not** required.

```bash
npm install                       # npm 11: if it reports blocked install scripts (esbuild, @embedded-postgres/<platform>),
                                  #   run `npm install-scripts approve <package>` for each, then `npm rebuild`
cp .env.example .env              # then edit if needed
npm run db:start                  # terminal 1: local PostgreSQL 17 (embedded, UTF-8) on port 5433
npm run db:migrate
npm run dev                       # terminal 2: API :4100, worker, web :5174
```

Open http://localhost:5174, create an account and start a scan.

To try scans against the bundled test website (which has deliberate defects):

```bash
# .env: SCAN_ALLOW_PRIVATE_TARGETS=127.0.0.1:4599   (development only; ignored in production)
npx tsx server/test/fixtureSite.ts 4599
```

then scan `http://127.0.0.1:4599/`. `http://127.0.0.1:4599/__control?fixed=1` repairs most of its defects so you can watch issues resolve; `fixed=0` breaks them again.

Scripts:

| Command | What it does |
|---|---|
| `npm run dev` | API (tsx watch), scan worker and Vite dev server together |
| `npm run db:start` | Local PostgreSQL via `embedded-postgres` (dev only) |
| `npm run db:migrate` | Apply SQL migrations |
| `npm test` | Server (unit, security, end-to-end API) and client tests |
| `npm run build` / `npm start` / `npm run worker` | Production build, API, worker |
| `node scripts/e2e-ui.mjs` | Browser end-to-end check of the UI (see docs/TESTING.md) |
| `npm run mail:dev` | Local test inbox for alert e-mails (also started by `npm run dev`): http://127.0.0.1:8025 |
| `npx tsx server/src/scripts/rescan.ts <scanId>` | Operator: re-run a scan's settings over all pages |
| `npx tsx server/src/scripts/exportReport.ts <scanId> out.pdf` | Operator: export a scan's client report as PDF |
| `npx tsx server/src/scripts/wpInspect.ts <url>` | Operator: WordPress and plugin information without a scan |
| `node scripts/e2e-monitoring.mjs` | Browser walk-through of monitoring: add monitor, real scheduler run, charts, alerts, billing, axe WCAG 2.2, keyboard focus, 390px |
| `npm run test:live -w @wpcg/server` | Live watcher checks against real targets (badssl.com, irishmediaagency.ie). Needs internet |
| `node client/scripts/contrast.mjs` | Checks every theme colour pair against WCAG 2.2 AA |
| `node scripts/e2e-workflow.mjs` | Browser walk-through of the nine product steps (enter URL → … → history), incl. AI via Ollama |
| `npm run plan:set -w @wpcg/server -- user@example.com pro` | Operator: change a workspace plan |

## Documentation

- [Audit accuracy: verification before reporting, grouping, states](docs/AUDIT-ACCURACY.md)
- [Performance analysis: method, scoring, resources, comparison and limits](docs/PERFORMANCE.md)
- [WordPress and plugin information: sources and risk levels](docs/WORDPRESS.md)
- [Monitoring: watchers, incidents, alerts, billing, plan and limits](docs/MONITORING.md)
- [Monitoring audit and plan](docs/MONITORING-PLAN.md)
- [Architecture and decisions](docs/ARCHITECTURE.md)
- [Severity policy](docs/SEVERITY.md)
- [Security checklist and SSRF design](docs/SECURITY.md)
- [Privacy, data collected and retention](docs/DATA.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Testing](docs/TESTING.md)
- [Known limitations](docs/LIMITATIONS.md)
- Database schema: [server/src/db/migrations/001_init.sql](server/src/db/migrations/001_init.sql)
- Configuration: [.env.example](.env.example)

## Feature status

Status as of version 0.1.0. "Implemented" means it ran end to end and is covered by the automated tests or the browser end-to-end check listed in [docs/TESTING.md](docs/TESTING.md).

### Phase 1: core

| Feature | Status |
|---|---|
| Accounts: sign-up (free plan as trial), sign-in, sign-out, password change, account deletion | Implemented |
| Sessions: HttpOnly SameSite cookie, hashed session tokens, CSRF token, Origin check, rate-limited auth | Implemented |
| Workspaces with owner/admin/member roles; all data isolated per workspace | Implemented |
| Website submission with URL validation, DNS check and pre-flight reachability probe | Implemented |
| SSRF protection (private/reserved IPs, metadata, DNS rebinding, redirects, ports, size/time limits) | Implemented |
| Page discovery: robots.txt, XML sitemaps (incl. index), same-host crawl with depth/page limits | Implemented (gzip sitemaps not read) |
| Availability: status codes, redirects/loops, timeouts, TLS errors, slow responses | Implemented |
| HTML structure: doctype, lang, charset, viewport, headings, duplicate IDs, obsolete elements | Implemented |
| SEO: title, description, duplicates, canonical, noindex (meta + header), robots.txt, sitemap, JSON-LD syntax, internal links | Implemented |
| Accessibility: axe-core 4.14 (WCAG 2.0/2.1/2.2 A/AA + best practice) with WCAG mapping, selectors, manual-review items | Implemented |
| Background job queue (PostgreSQL `SKIP LOCKED`), heartbeats, stale-job recovery, cancellation, time limit | Implemented |
| Dashboard, scan history, issue list and detail, in-app report | Implemented |
| Scan results explorer: priority summary tiles, left category bar (All issues + each category with counts and test status), issues grouped by priority with inline step-by-step fixes | Implemented |

### Phase 2: browser diagnostics

| Feature | Status |
|---|---|
| Broken links: internal and (optional) external, HEAD→GET fallback, per-host concurrency, grouped by target | Implemented |
| Images: broken, missing dimensions, oversized for display size, large files (when measurable) | Implemented |
| JavaScript: uncaught errors, console errors, failed requests, first- vs third-party | Implemented |
| Desktop (1366×900) and mobile (390×844) full-page screenshots | Implemented |
| Responsive: horizontal overflow with offending elements, mobile content drop (needs review) | Implemented |
| Visual regression vs baseline with diff images, thresholds, ignore selectors | Implemented (Pro/Agency plans) |
| Security & configuration: HTTPS, HTTP→HTTPS redirect, mixed content, security headers, insecure forms, cookie Secure flag | Implemented |
| Performance: Lighthouse 13 lab metrics (LCP, FCP, CLS, TBT, score) and opportunities | Implemented (lab data only; first N pages) |

### Phase 3: reporting and verification

| Feature | Status |
|---|---|
| Rule-based remediation: why it matters, steps, example code, verification, references | Implemented |
| Issue lifecycle: Open, Reopened, Needs Review, Inconclusive, Not Tested, Resolved with history | Implemented |
| Resolution only when the same check re-ran on the same pages and viewports | Implemented |
| Verification scans from an issue | Implemented |
| Baselines | Implemented |
| Reports: in-app, printable (print CSS), PDF (rendered by Chrome), CSV (formula-injection safe) | Implemented |
| Previous-scan comparison, resolved and reopened lists, tests not completed, limitations | Implemented |

### Phase 4: AI and commercial readiness

| Feature | Status |
|---|---|
| Optional AI explanations per issue and AI report summaries (Anthropic or Ollama), server-side keys, quota | Implemented. Live Anthropic calls were **not** exercised (no API key on the build machine); the disabled path is tested |
| Server-side quotas: scans/month, pages/scan, websites, AI requests, members, feature flags per plan | Implemented |
| Data retention (hourly), delete scan, delete website, purge workspace data, delete account | Implemented |
| Team: list members, add existing accounts, remove members | Implemented (no invitation e-mails) |
| Branded report name (Agency) | Implemented |
| Billing page with plans and usage | Implemented (Stripe added in Phase 5) |

### Phase 6: verified reporting and WordPress information

| Feature | Status |
|---|---|
| Three states: Confirmed / Needs Manual Review / Pending Verification; severity totals count confirmed issues only | Implemented, tested |
| Re-verification before reporting: broken images and broken links are re-requested; disproved detections listed as dismissed false positives | Implemented, tested on the fixture and on yellowumbrellatours.ie |
| Chrome-cancelled image requests (lazy loading) no longer counted as broken images | Implemented |
| Redirecting internal links reported as informational ("the link works"), category renamed "Links" | Implemented |
| Same element on many pages = one issue listing the pages (accessibility, images, headings) | Implemented, tested |
| Full scans cover all pages (Free 100, Pro/Agency 1,000), honest "X of Y pages found" scope | Implemented |
| WordPress and plugin information after every scan: version, core status, detected plugins with installed/latest version, update status, vulnerabilities (WPVulnerability) and risk; "Unable to verify" where it cannot be verified | Implemented, tested live |
| Report comparison tool (`scripts/compare-scans.mjs`) | Implemented |
| PageSpeed-style Lighthouse report in the Performance view: Mobile/Desktop tabs, circular score gauges for Performance, Accessibility, Best Practices, SEO and Agentic Browsing, lab metrics, filmstrip, “Show audits relevant to” filter, Insights, Diagnostics and every category group (Names and labels, Contrast, Navigation, Trust and Safety, Crawling and Indexing, …) as accordions with step-by-step fixes and affected items | Implemented (Lighthouse runs on the first `LIGHTHOUSE_MAX_PAGES` pages, default 3) |
| Real-user (CrUX) data | Not connected: shown as “No Data”, never estimated |
| Back button on every app page (previous page, or the parent page when opened from a link) | Implemented |
| Local test inbox for alert e-mails in development (`npm run dev` → http://127.0.0.1:8025) | Implemented; real delivery needs an SMTP provider in `.env` |

### Phase 5: monitoring, alerts and billing

| Feature | Status |
|---|---|
| Monitors (website and heartbeat), per-watcher schedules, PostgreSQL scheduler with `SKIP LOCKED`, jitter, per-host pacing, stale-lock recovery, scheduler heartbeat | Implemented, tested |
| Uptime: status, response + first-byte time, 3 tries with backoff, slow-response re-samples, redirect timing, keyword present/absent, fatal-error pages (WP DB error, PHP fatal, maintenance) | Implemented, tested on fixture + live site |
| Bot challenges / blocks (Cloudflare, Sucuri, Wordfence, 401/403/407/429) reported as Not assessed | Implemented, tested |
| SSL/TLS: validity, chain, hostname, expiry (14 days), TLS version; connection failures separate from certificate errors | Implemented, tested live on badssl.com |
| HTTPS redirect and www/apex canonical host | Implemented, tested live |
| Security headers grade, version disclosure, PHP end-of-life | Implemented, tested |
| Search indexing: robots.txt by user-agent, noindex, sitemap, robots.txt change | Implemented, tested |
| Mixed content (subresources only) | Implemented, tested |
| DNS: MX, SPF, DMARC, CAA, record-change events | Implemented, tested live |
| Domain expiry: RDAP, WHOIS for .ie/.eu, transfer lock | Implemented, tested live (.ie) |
| Defacement canary and new third-party script domains, with "this change was expected" | Implemented, tested |
| Exposed files (~45 paths) with content confirmation and soft-404 detection; needs explicit opt-in; contents never stored | Implemented, tested |
| Real-browser render: blank page, JS errors, failed first-party assets | Implemented, tested live |
| Scheduled weekly full audit | Implemented (reuses the scan engine) |
| Incidents: one per problem, escalation, auto-resolve, acknowledge, "monitoring failing" after 3 errors | Implemented, tested |
| E-mail alerts (SMTP): once per incident event per contact, severity threshold, retries, delivery log, test e-mail | Implemented, tested with a real SMTP server in tests. Dev `.env` has no SMTP, so dev sends are logged as skipped |
| History per plan (7/90/365 days) with retention | Implemented |
| Stripe Checkout, Customer Portal, signed webhooks, idempotency, lifecycle (active, trialing, past_due grace, canceled/unpaid → Free) | Implemented; webhook handling tested with real Stripe signatures. **A live Stripe checkout was not run** (no Stripe account keys on this machine) |
| Dashboard: health tiles, monitors list, response-time chart, daily uptime bars, watchers, history, incidents, alerts, billing | Implemented, browser-tested |
| Dark theme in Irish Media Agency colours, WCAG 2.2 AA (contrast, focus, keyboard charts, screen-reader text), responsive to 390px | Implemented; axe + contrast script + keyboard focus checks pass |

### Not implemented

- **Configurable form and functional tests** (Section 8K). Forms are inspected passively but never submitted. The Forms category is reported as "Not run".
- **Multi-location confirmation.** Checks run from the server's own location; a regional network problem can look like downtime (retries reduce this).
- **SMS, Slack, webhook or push alerts.** E-mail only.
- **Public status pages.**
- **Checks that need third-party API keys or inside access** (Google Web Risk, CrUX, origin-certificate, server ports, plugin vulnerabilities, blocklists): see docs/MONITORING.md.
- **Authenticated scanning of private staging sites.** Only publicly reachable pages are scanned. See LIMITATIONS for the intended design.
- **Account e-mail** (verification, password reset, invitations, scan notifications). Only monitoring alerts are e-mailed.
- **Docker image build.** The Dockerfile and compose file were written but not built on the development machine, which has no Docker.
