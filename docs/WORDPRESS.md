# WordPress and plugin information

Shown automatically after every completed scan (scan results page, report and PDF) when the scanned
pages identify WordPress. Code: `server/src/scanner/wordpress/`.

## Where each value comes from

| Field | Source | Confidence / when it says "Unknown" |
|---|---|---|
| WordPress detected | Generator tag, REST API discovery link (`api.w.org`), files under `/wp-content/` **and** `/wp-includes/` on the site's own host | Files on other hosts (CDNs of other sites) are ignored |
| WordPress version | Generator meta tag → RSS feed `<generator>` → most common `?ver=` on `/wp-includes/` files | high, high, medium. Hidden everywhere → Unknown |
| Core status | WordPress.org release list (`/core/stable-check/1.0/`): latest, outdated, insecure | Version unknown or API down → Unable to verify |
| Core vulnerabilities | WPVulnerability core endpoint for that exact version | Lookup failed → shown as failed |
| Total installed plugins | **Cannot be read from outside a site.** Always "Unable to verify", with the number detected on public pages | — |
| Plugins | `/wp-content/plugins/<slug>/` files loaded by the scanned pages | Admin-only and security plugins are usually invisible |
| Installed plugin version | `Stable tag` in the plugin's own public `readme.txt` (medium) → a single `?ver=` on its files (low, "verification required") | Neither → Unable to verify (never guessed) |
| Latest version | WordPress.org plugin API | Not listed (premium/custom) → "Not on WordPress.org"; closed → "Closed on WordPress.org" |
| Update status | Installed vs latest, WordPress `version_compare` rules | Either side unknown → Unknown |
| Vulnerabilities | WPVulnerability (wpvulnerability.net, CC0; aggregates CVE, Wordfence, Patchstack, WPScan, JVN) — only records whose version range contains the installed version | Version unknown → the number of published vulnerabilities is mentioned but **not matched** |

## Risk levels

| Level | Rule |
|---|---|
| Critical / High / Medium / Low | Highest CVSS among known vulnerabilities affecting the installed version (≥ 9 / ≥ 7 / ≥ 4 / > 0). No published score → Medium. Unfixed vulnerabilities are never Low |
| High | Plugin closed on WordPress.org for a security reason |
| Medium | No known vulnerability, update available, and not updated on WordPress.org for over two years |
| Low | No known vulnerability affecting the installed version, but an update is available |
| No known risk | Up to date and no known vulnerability (not proof of security) |
| Unknown | Installed version not verifiable, latest version not verifiable for an unlisted plugin, or the vulnerability lookup failed |

## Requests made

To the scanned site (through the same SSRF guard as the scan): `/feed/` (only if the generator tag
is hidden), each detected plugin's `readme.txt` (up to 60 plugins), each theme's `style.css` — all
public files, three at a time. To public APIs: `api.wordpress.org` and `www.wpvulnerability.net`
(cached for six hours per server process).

## Getting complete data

Exact versions and the full plugin list need access to the site itself: WP-CLI `wp plugin list
--format=json`, or an administrator connection. Until such an integration exists the report says
plainly what could not be verified.

## Operator tool

`npx tsx server/src/scripts/wpInspect.ts https://example.com [more page URLs]` prints the same
information without running a scan.
