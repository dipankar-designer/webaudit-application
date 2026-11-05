# Security

## SSRF design

Users submit arbitrary URLs, and the scanner fetches them from inside your infrastructure. The defence works in layers:

1. **URL policy** (`security/ssrf.ts → validateScanUrl / assertHostAllowed`). Only `http:` and `https:` are allowed. Credentials in URLs are rejected. Hosts such as `localhost`, `*.local`, `*.internal`, `metadata.google.internal` and single-label names are blocked. Only ports 80, 443, 8080 and 8443 are allowed. The WHATWG URL parser normalises numeric and hex IP forms (`2130706433`, `0x7f.1`) before checking.
2. **IP policy** (`isBlockedIp`). IPv4: 0/8, 10/8, 100.64/10 (CGNAT, Alibaba metadata), 127/8, 169.254/16 (cloud metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4. IPv6 is an allowlist: only global unicast 2000::/3, minus documentation, 6to4 and IETF special ranges. IPv4-mapped and NAT64 addresses are judged by their embedded IPv4.
3. **Connect-time DNS validation** (`guardedLookup`). Every outbound socket resolves DNS through this function. If any resolved address is blocked, the connection fails. Validating the address actually used for the connection closes DNS rebinding.
4. **Every redirect hop is re-validated** (`safeFetch` follows redirects manually, max `SCAN_MAX_REDIRECTS`). An open redirect to an internal address is refused. This is covered by tests.
5. **The browser cannot bypass the rules.** Chrome is launched with `--proxy-server` pointing at the in-process egress proxy. Playwright forces loopback traffic through it as well. The proxy resolves and connects using `guardedLookup` for both plain HTTP and CONNECT tunnels, so sub-resources, `fetch()`, redirects and iframes are all filtered. WebRTC is limited to proxied UDP. Non-web schemes are aborted in the browser context, and service workers are blocked. Lighthouse's Chrome uses the same proxy.
6. **Limits**: total time per request, response size (`SCAN_MAX_RESPONSE_BYTES`, decompressed bytes are counted), crawl depth, page count (plan and hard cap), link count, per-host link concurrency, scan duration (`SCAN_MAX_DURATION_MS`), and at most 2 active scans per website.
7. **Development escape hatch.** `SCAN_ALLOW_PRIVATE_TARGETS` (host or host:port) exists only for local fixtures and is ignored when `NODE_ENV=production`.

## Security checklist

| Item | Where |
|---|---|
| Passwords hashed with scrypt (N=2^15, r=8, p=1, 16-byte salt), constant-time compare, dummy hash for unknown e-mails (no account enumeration) | `auth/passwords.ts`, `routes/auth.ts` |
| Session token: 256-bit random, only its SHA-256 stored, HttpOnly + SameSite=Lax, `Secure` + `__Host-` prefix in production, expiry, other sessions revoked on password change | `auth/session.ts` |
| CSRF: per-session token required in `X-CSRF-Token` for all state-changing requests, plus an Origin check | `auth/session.ts` |
| Rate limiting: auth endpoints 20/15 min per IP; API 600/min per IP | `routes/auth.ts`, `app.ts` |
| Authorisation: every query scoped by `workspace_id` from the session; owner/admin role checks for workspace changes; cross-workspace access returns 404 (tested) | `routes/*` |
| Input validation with zod; JSON body limit 200 kB | `routes/*`, `app.ts` |
| Security headers via helmet: strict CSP (`script-src 'self'`), `frame-ancestors 'none'`, nosniff, HSTS in production behind TLS | `app.ts` |
| Errors: generic message for 500s, no stack traces to clients, logs without request bodies | `http/errors.ts` |
| Stored files served only after an ownership check, from fixed path patterns; path traversal guarded | `storage/files.ts`, `routes/misc.ts` |
| Scanned content shown in the UI is rendered as text (React escaping); the PDF is rendered from escaped HTML with JavaScript disabled and offline | `reports/exporters.ts` |
| Evidence scrubbing: tokens in query strings, e-mail addresses and JWTs are masked; cookie values never stored | `checks/pageRuntime.ts`, `checks/security.ts` |
| CSV export neutralises spreadsheet formulas | `reports/exporters.ts` |
| No user-supplied scripts: ignore selectors limited to a CSS character set and used only as Playwright CSS masks | `routes/scans.ts` |
| Authorisation confirmation stored with each scan (`authorised_at`, `authorised_by`) | `scans` table |
| AI: server-side key only, no tools, evidence wrapped as untrusted data, per-plan quota, can be disabled per workspace | `ai/provider.ts`, `routes/ai.ts` |
| Secrets only in environment variables; `.env` git-ignored | `.env.example` |

## Deployment hardening (operator responsibilities)

- Run the worker in its own container or VM with **egress-only networking**. Block the cloud metadata service and private subnets at the firewall too (defence in depth). The worker must not reach the database host other than on its port.
- Terminate TLS in front of the API, then set `TRUST_PROXY=true` and `APP_ORIGIN` to the public origin.
- Use a dedicated PostgreSQL role with access to this database only.
- Keep Chrome or the Playwright image patched. The scanner loads untrusted pages.
- Rotate `ANTHROPIC_API_KEY` if exposed. Monitor usage.

## Out of scope / not provided

This is not a penetration-testing tool: it never probes for vulnerabilities, brute-forces or submits forms. There is no MFA, e-mail verification or password-reset e-mail yet (see LIMITATIONS).
