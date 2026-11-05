# Monitoring audit and plan (2026-10-28)

Source requirements: *Web Watcher: frontend check catalogue* (Ring 1 R0–R23, EXP/KEV, further checks, free/paid packs, build notes 1–14).

## 1. Audit of the existing application

| Area | State before this work |
|---|---|
| Architecture | Node/TypeScript monorepo (`shared`, `server`, `client`), Express 5 API, PostgreSQL (also the job queue, `SKIP LOCKED`), separate scan worker, React 19 + Tailwind 4 SPA. Solid; reused as is. |
| Auth, workspaces, roles, CSRF, SSRF protection | Production-quality, covered by tests. Reused. |
| On-demand audits | Working: availability, HTML, SEO, accessibility (axe), security headers, links, images, JS errors, responsive, visual vs baseline, Lighthouse, reports (PDF/CSV), verification scans, issue lifecycle, AI explanations. Reused. |
| **Scheduled monitoring** | **Missing.** Nothing runs on a schedule; there is no uptime history, response-time trend, TLS expiry, DNS/domain checks, change detection or "watch the watcher". |
| **Alerts** | **Missing.** No e-mail, no incidents, no de-duplication. |
| Plans | Static limits enforced server-side (scans, pages, websites, AI, members). No monitoring limits. |
| **Billing** | **Mocked page only** — plan table and usage meters; no payment provider, plans set by an operator script. |
| Theme / accessibility | Light theme, axe-clean main pages, responsive at 390 px. |

## 2. What changes and why

The audit engine stays exactly as it is. Monitoring is added **beside** it, as a second product surface that reuses the same security layer (`safeFetch`, egress proxy), browser, database, worker process, auth and plans.

New building blocks:

1. **Monitors and watchers** (`monitors`, `monitor_checks`): one monitor per URL, one row per enabled watcher with its own cadence and `next_run_at`. Workers claim due watchers with `FOR UPDATE SKIP LOCKED`, exactly like scans.
2. **Results history** (`check_results`): every run stored with status `up | warning | down | not_assessed | error`, P1–P4 severity, timings and evidence.
3. **Incidents** (`incidents`): opened on the first failing result for a watcher, updated while it persists, resolved when it passes — so one problem produces one alert, not one per run.
4. **Alerts** (`alert_contacts`, `alert_deliveries`): e-mail over SMTP with an in-app delivery log; P1/P2 by default, threshold configurable.
5. **Watch the watcher**: the scheduler records a heartbeat; overdue watchers and crashed runs are stored as `error` results and become "monitoring failure" incidents; the dashboard shows when monitoring itself is behind.
6. **Billing**: Stripe Checkout + Customer Portal + signature-verified webhooks; plan changes only come from webhooks (never from the browser).

## 3. Prioritised implementation plan

| Priority | Item | Catalogue refs |
|---|---|---|
| P0 | Monitor model, scheduler, results history, incidents, R0 "not assessed", retries with backoff, watchdog | R0, notes 1–5, 8, 11, 14 |
| P1 (Free) | Uptime + status + keyword (present/absent, built-in fatal-error texts), TTFB with re-samples, redirect timing, TLS certificate (retry ×3, cert error vs connection error, expiry, TLS ≥ 1.2), HTTPS redirect + canonical host, heartbeat (cron) monitors | R1, R1b, R2, R3, R3b, heartbeat, keyword |
| P2 | E-mail alerts with de-duplication, recovery notices, test e-mail; in-app delivery log | — |
| P3 (Paid) | Security headers + version disclosure + PHP end-of-life; indexing (robots by UA group, noindex, sitemap) + robots.txt diff; mixed content (subresources only); DNS mail (MX/SPF/DMARC) + CAA + DNS change alert; domain expiry (RDAP, `.ie` WHOIS); defacement canary; third-party script inventory; real-browser render (blank page, JS errors, failed assets); exposure sweep (content-confirmed, soft-404 aware, weekly, opt-in); scheduled full audit (accessibility, SEO, visual vs baseline via the existing engine) | R4, R4b, R13, R14, R16, R17, R20, EXP, R6–R8, real-browser, script inventory, visual |
| P4 | Plans with watcher packs, monitor limits, minimum interval, history days; Stripe Checkout, portal, webhooks, status sync | Suggested tiers |
| P5 | Dark theme (Irish Media Agency colours, UptimeRobot-style dashboard), monitoring dashboard, uptime bars, response-time charts, incidents, alert settings, billing management; WCAG 2.2 AA | — |
| P6 | Tests against authorised targets (local fixture for attack-shaped probes; passive checks against the user's own domains), docs | — |

## 4. Deliberately not built (and why)

| Catalogue item | Reason |
|---|---|
| Multi-location confirmation | Needs probes in several regions; single-node deployment. Mitigated with in-run re-samples and retries. |
| Blocklist (Google Web Risk), CrUX field data, PageSpeed API | Need paid/keyed Google APIs not available here. Can be added behind an API key. |
| Origin certificate behind a CDN, control-panel ports (KEV), XML-RPC/REST batch/user enumeration probes | Need the origin IP, or are attack-shaped probes that can get the scanner banned; not run without an explicit, per-site authorisation feature. |
| Lookalike domains, certificate transparency, mail blocklists, subdomain takeover | Need external feeds/services; candidates for a later release. |
| Scripted journeys, form round-trip | Need a recorder and seeded inbox; out of scope for this release. |
