# Deployment

## Production requirements

- **Node.js 22.19+** (Lighthouse 13 requirement), or the provided Docker image.
- **PostgreSQL 14+** with **UTF8** encoding (the migrator refuses other encodings). Developed and tested on 17.
- **Chrome or Chromium** for the worker. Auto-detected (system Chrome, `/usr/bin/chromium`, or Playwright's bundled Chromium), or set `CHROME_PATH`. The Docker image includes it.
- **Persistent storage** for screenshots (`STORAGE_DIR`), shared by API and worker (same volume or network filesystem). For multiple hosts, use shared storage. An S3 adapter is not implemented yet.
- **TLS-terminating reverse proxy** in front of the API (nginx, Caddy or a cloud load balancer). Set `TRUST_PROXY=true`.
- Worker sizing: Chrome needs roughly 1–1.5 GB RAM per concurrent scan. Start with `WORKER_CONCURRENCY=1`, `SCAN_PAGE_CONCURRENCY=2`. Lighthouse adds 20–40 s per page and viewport on a small VM.

For a staging or production server, start from `.env.staging.example` (production values with `CHANGE_ME` placeholders) instead of `.env.example` (local development values).

## Option A: Docker Compose

```bash
cp .env.example .env
# edit: NODE_ENV=production, APP_ORIGIN=https://app.example.com, TRUST_PROXY=true,
#       SCAN_USER_AGENT with your contact URL, AI settings if wanted
export POSTGRES_PASSWORD=$(openssl rand -base64 24)
docker compose up -d --build
docker compose logs -f api worker
```

The API listens on 127.0.0.1:4100 for your reverse proxy. Scale workers with `docker compose up -d --scale worker=3`. Workers coordinate through PostgreSQL, so no extra configuration is needed.

> The Dockerfile and compose file were not built on the development machine (no Docker there). Treat the first build as a verification step.

## Option B: Node processes

```bash
npm ci && npm run build
export NODE_ENV=production DATABASE_URL=postgres://… APP_ORIGIN=https://app.example.com TRUST_PROXY=true STORAGE_DIR=/var/lib/wpcg
node server/dist/index.js       # API + static web client (migrations run on start)
node server/dist/worker.js      # one or more workers, ideally on a separate host
```

Run both under a supervisor (systemd, PM2, Kubernetes) with restart on failure. Both handle SIGTERM: the worker finishes its active scan before exiting, and a scan interrupted by a crash is re-queued once via the heartbeat check.

## Configuration reference

See `.env.example`. Important production settings:

| Variable | Recommendation |
|---|---|
| `NODE_ENV` | `production` (enables secure cookies and ignores `SCAN_ALLOW_PRIVATE_TARGETS`) |
| `APP_ORIGIN` | Public origin of the app, used by the Origin check |
| `TRUST_PROXY` | `true` behind a proxy so rate limits use the client IP |
| `SCAN_USER_AGENT` | Include a URL where site owners can learn about the bot |
| `SIGNUPS_ENABLED` | `false` to run invitation-only |
| `AI_PROVIDER` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Optional. Default model `claude-opus-5-5`, effort `medium`, server-side refusal fallback enabled |

## Operations

- **Plans:** `node server/dist/scripts/setPlan.js user@example.com pro` (no payment provider is integrated).
- **Retention:** runs hourly inside the API. `node server/dist/scripts/retention.js` runs it once.
- **Health:** `GET /api/health` reports database status and the number of scans with a live heartbeat.
- **Backups:** back up PostgreSQL and `STORAGE_DIR` together.
- **Network isolation for workers:** see docs/SECURITY.md → Deployment hardening.

## Before offering this commercially

Add a payment provider (Stripe Billing is the natural fit: map Stripe prices to `workspaces.plan` from webhooks), transactional e-mail (verification, password reset, invitations, scan-complete notifications), terms of service and a privacy policy, and S3-compatible screenshot storage for multi-host deployments.

## Monitoring, alerts and billing

- Run at least one worker (`npm run worker`); it runs scans and the monitoring scheduler (`MONITORING_ENABLED=true`). Several workers may run concurrently.
- Set `APP_PUBLIC_URL` to the public address (used in alert e-mails, heartbeat URLs and Stripe return URLs).
- E-mail alerts: set the `SMTP_*` variables and `ALERT_FROM` (see `.env.example`). Use a domain with SPF/DKIM/DMARC.
- Stripe: set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_AGENCY`, and point a webhook at `https://<domain>/api/billing/webhook`. The reverse proxy must pass the request body through unchanged (signature verification uses the raw body).
- Outbound access needed by the worker: HTTP/HTTPS to monitored sites, DNS to 1.1.1.1 and 8.8.8.8 (UDP/TCP 53), WHOIS (TCP 43) to whois.weare.ie and whois.eu, HTTPS to rdap.org and the SMTP host.
- Full details: [MONITORING.md](MONITORING.md).
