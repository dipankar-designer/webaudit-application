# Privacy, data collected and retention

## What is collected and where

| Data | Stored in | Notes |
|---|---|---|
| Account: name, e-mail, scrypt password hash, last login time | PostgreSQL `users` | No passwords in logs |
| Sessions: SHA-256 of the session token, CSRF token, expiry, last seen | `sessions` | Expired sessions are purged hourly. No IP addresses or user agents are stored |
| Workspace settings, memberships, plan | `workspaces`, `memberships` | |
| Website addresses | `websites` | |
| Scan configuration, who confirmed authorisation and when | `scans` | |
| Per page: URL, final URL, HTTP status, content type, response time, title, redirect chain, error text, Lighthouse lab metrics | `scan_pages` | **Page bodies are not stored** |
| Findings: page URL, viewport, evidence (selectors, short HTML snippets up to 400 characters, header values, error messages) | `findings` | Tokens in URLs, e-mail addresses and JWTs are masked. Cookie *names* only |
| Issues, status history | `issues`, `issue_events` | |
| Full-page screenshots and diff images (PNG) | `STORAGE_DIR/<workspace>/<scan>/` | Capped at 8000 CSS px tall. May show personal data that the scanned site displays publicly |
| Usage counters | `usage_events` | For quotas |
| AI outputs | `ai_outputs` | Only when AI is used |

Not collected: form submissions (forms are never submitted), credentials or content of scanned sites behind logins, payment details, analytics or tracking. The web client loads no third-party resources: fonts are self-hosted.

## What leaves the server

- Requests to the websites being scanned (and, if enabled, to sites they link to).
- With `AI_PROVIDER=anthropic`, when a user clicks "Explain this issue" or "Add an AI summary": the issue's stored description, rule, recommended steps and up to five pages of evidence (or the report summary) are sent to Anthropic's API. With `ollama`, the same data goes to the configured Ollama server.

## Retention and deletion

- **Automatic:** every hour the API deletes scans older than the workspace's retention period (default `DEFAULT_RETENTION_DAYS`=90, configurable 1–3650 days in Settings), together with their pages, findings and screenshots. It also deletes issues not detected within that period. Baseline scans are kept until the baseline is removed. Run on demand: `npm run retention -w @wpcg/server`.
- **Manual:** delete a scan, delete a website (all its data), "Delete all scan data" (workspace owner), and "Delete my account" (also deletes workspaces where you are the only owner). Deletion removes database rows and screenshot files immediately. Database backups follow your own backup retention.

## Access

Data is visible only to members of the workspace. Every API query is scoped to the session's workspace, screenshots are served only after an ownership check, and cross-workspace requests return 404.
