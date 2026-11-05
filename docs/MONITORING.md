# Monitoring

How WebAudit AI watches websites, decides what is a problem, alerts people and charges for it.
The design rationale and the audit of the original app are in [MONITORING-PLAN.md](MONITORING-PLAN.md).

## Concepts

| Term | Meaning |
|---|---|
| Monitor | One website URL (or one heartbeat) in a workspace. |
| Watcher | One kind of check on a monitor (uptime, TLS, DNS, ...). Each has its own schedule, last result and baseline. |
| Check result | One stored run of a watcher: status, priority, summary, details, response and first-byte time, attempts, time. |
| Incident | One open problem per watcher. Opened by a failing result, updated while it persists, resolved when the watcher passes. |
| Alert | An e-mail to each enabled contact when an incident opens or resolves (once per event per contact). |

### Statuses

| Status | Meaning | Opens/closes incidents? |
|---|---|---|
| Up | The check passed. | Resolves |
| Warning | Works, but needs attention (slow, expiring soon, missing headers, changed). | Opens (P2–P4) |
| Down | Failed after retries. | Opens (P1/P2) |
| Not assessed | The site blocked or challenged us, the target is not applicable (e.g. TLS on an http:// URL), or the watcher needs an opt-in. **Never treated as down.** | Neither |
| Monitoring error | Our own run failed (crash, time limit, stale lock). Three in a row open a P3 "monitoring failing" incident. | Only after 3 |

A monitor's overall status is the worst *assessed* watcher status; it is Not assessed only when no watcher could assess.

### Priorities

P1 act now · P2 urgent · P3 fix soon · P4 housekeeping. Each workspace chooses the lowest priority that is e-mailed (default P2).

## Watchers

| Watcher | Plan | Default cadence | What it does | Production notes |
|---|---|---|---|---|
| Uptime & response time | Free | monitor interval (≥5 min Free, ≥1 min paid) | GET with a fresh connection; 3 tries (2 s, 5 s backoff); first-byte > 3 s is re-sampled twice; redirect chain > 1.5 s warns; keyword present/absent; WordPress database error, PHP fatal and maintenance pages count as down | Homepage and "money pages" are P1, other URLs P2 |
| SSL/TLS | Free | 1 h | Handshake with SNI; expired, untrusted, self-signed or wrong-host → P1; < 14 days → P2; < TLS 1.2 → P2. A failed TCP connection is Not assessed (uptime reports the outage) | Live-tested against badssl.com |
| HTTPS redirect | Free | 1 d | http:// must redirect to https://; www and apex must agree | |
| Security headers | Pro | 1 d | HSTS, nosniff, framing, Referrer-Policy; grade A–F; version disclosure; PHP end-of-life → P2 | |
| Search indexing | Pro | 1 d | robots.txt evaluated for Googlebot and Bingbot groups; homepage noindex (meta and header); sitemap; robots.txt change event | |
| Mixed content | Pro | 1 d | http:// subresources (src, srcset, stylesheets, CSS url()) on HTTPS pages; plain links are ignored | |
| DNS & mail | Pro | 1 d | MX, SPF, DMARC policy, CAA; change events for A, AAAA, MX, NS (via 1.1.1.1 and 8.8.8.8) | |
| Domain expiry | Pro | 1 d | RDAP (rdap.org), WHOIS for .ie and .eu; < 14 days P1, < 30 P2, < 60 P3; transfer lock | Some registries do not publish expiry; then Not assessed |
| Defacement canary | Pro | 1 h | Hash of title + main heading against an accepted baseline; challenge pages are never stored as baseline | "This change was expected" resets the baseline |
| Third-party scripts | Pro | 1 d | Alerts on a new external script domain (card skimmers, injected trackers) | Same accept flow |
| Exposed files | Pro, **opt-in** | 1 week | ~45 well-known paths (.env, .git, backups, SQL dumps, phpinfo, adminer, logs, keys, directory listings). A hit is reported only when the **content** matches; a soft-404 probe prevents false hits. Contents are never stored | Looks like an attack to a WAF, so it needs a second, explicit authorisation |
| Real-browser render | Pro | 1 d | Chrome: blank page, JS errors, failed first-party CSS/JS/fonts (P2), third-party failures (P4) | |
| Scheduled audit | Pro | 1 week | Full scan with the audit engine (accessibility, SEO, links, images, performance, visual comparison when a baseline exists) | Counts against the monthly scan quota |
| Heartbeat | Free | monitor interval + grace | The job calls `https://<app>/api/heartbeat/<token>` (GET or POST). Overdue → P2 | Token is a 144-bit secret; endpoint is rate-limited |

### Reliability rules

- **Retries:** uptime and TLS retry with backoff before reporting a failure.
- **No false downs from blocks:** Cloudflare/Sucuri/Wordfence challenges, `cf-mitigated`, and 401/403/407/429 responses are Not assessed.
- **Pacing:** at least 250 ms between our requests to the same host; watchers of a new monitor start staggered; long intervals get up to 10% jitter.
- **No duplicate alerts:** one open incident per watcher (database unique index); one delivery row per incident, contact and event (unique constraint) claimed before sending.
- **Failed deliveries** are retried for one hour, then left as failed in the delivery log.
- **Stale runs:** a watcher locked for more than 10 minutes (worker crashed) is released and recorded as a Monitoring error.
- **Watching the watcher:** the scheduler writes a heartbeat every loop; the dashboard warns when it is older than 2 minutes.
- **History:** every run is stored with timestamps. Kept 7 / 90 / 365 days (Free / Pro / Agency); results referenced by open incidents are kept.

## What cannot be checked from outside

These need inside access or third-party accounts and are not claimed:

- Server resources (disk, memory, PHP workers), database health, cron execution (except via heartbeats), backups' integrity.
- Plugin/theme vulnerability databases (needs a WPScan/Patchstack key), malware scanning of files on disk.
- Google Safe Browsing / Web Risk, Chrome UX Report field data and PageSpeed Insights (need API keys).
- Mail blocklists, lookalike domains, certificate-transparency monitoring, subdomain takeover.
- Origin certificates behind a CDN, open ports and services.
- Logged-in journeys, checkout and form submissions (forms are never submitted).
- Multi-region confirmation: all checks run from the server's location.

## Plans and access control

Limits live in `shared/src/index.ts` (`PLANS`) and are enforced on the server:

| | Free | Pro | Agency |
|---|---|---|---|
| Monitors | 3 | 25 | 150 |
| Fastest uptime check | 5 min | 1 min | 1 min |
| Watchers | Uptime, TLS, HTTPS, heartbeat | All | All |
| History | 7 days | 90 days | 365 days |
| Alert contacts | 1 | 5 | 20 |

When a workspace drops to a lower plan, watchers it is no longer entitled to stop at their next run (shown as paused) and its interval floor applies to new changes.

## Billing (Stripe)

1. Create two recurring Prices in Stripe and set `STRIPE_PRICE_PRO` / `STRIPE_PRICE_AGENCY`.
2. Add a webhook endpoint `https://<your-domain>/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and set `STRIPE_WEBHOOK_SECRET`.
3. Set `STRIPE_SECRET_KEY` and `APP_PUBLIC_URL`.
4. Enable the Customer Portal in Stripe (plan switching, cancellation, payment methods, invoices).

Rules:

- The plan changes **only** inside the webhook handler, after `stripe.webhooks.constructEvent` verifies the signature on the raw body. The `?checkout=success` return page only polls.
- Every event id is stored (`stripe_events`); replays are acknowledged and ignored. If processing fails the id is removed and Stripe retries.
- `active`/`trialing` → the plan mapped from the Price; `past_due` → plan kept while Stripe retries; `canceled`, `unpaid`, `incomplete_expired`, `paused` → Free.
- Plans set by an operator (`npm run plan:set`) are recorded with `plan_source = operator`.

Test locally with the Stripe CLI: `stripe listen --forward-to localhost:4100/api/billing/webhook`, then use the printed `whsec_...` as `STRIPE_WEBHOOK_SECRET` and Stripe's test cards.

## E-mail

**Development:** `npm run dev` also starts a local test inbox (`scripts/dev-mail.mjs`): SMTP on
127.0.0.1:2525, messages readable at http://127.0.0.1:8025. The dev `.env` points `SMTP_HOST` at it and
sets `SMTP_DEV_INBOX_URL`, so the Alerts page says mail goes to the test inbox, not real mailboxes.

**Real delivery:** any SMTP provider (Postmark, SES, Mailgun, Microsoft 365). Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `ALERT_FROM`. Use a sending domain with SPF, DKIM and DMARC so alerts are not filtered as spam. "Send test" on the Alerts page reports the real outcome.

## Running

- Development: `npm run dev` starts API, worker (with the scheduler) and web client.
- Production: run the API (`npm start`) and at least one worker (`npm run worker`). Several workers can run at once; claiming uses `FOR UPDATE SKIP LOCKED`.
- `MONITORING_ENABLED=false` on a worker makes it process scans only.

## Tests

| Command | What it proves |
|---|---|
| `npm test -w @wpcg/server` (`test/monitoring.test.ts`) | Watchers against a local fixture site that can go down, slow, challenged, defaced, leak files or answer soft-404s; scheduler persistence; incident open/dedupe/resolve; e-mail delivery through a real SMTP server; heartbeat; plan limits; workspace isolation; Stripe webhooks with real signatures, replay, grace and downgrade |
| `npm run test:live -w @wpcg/server` | TLS against badssl.com (valid, expired, wrong host, self-signed, untrusted root) and passive checks on irishmediaagency.ie |
| `node scripts/e2e-monitoring.mjs` | The UI with the real dev stack: add monitor, scheduler run, charts, settings, alerts, billing; axe WCAG 2.2 A/AA, keyboard focus, 390px overflow, no console errors |
