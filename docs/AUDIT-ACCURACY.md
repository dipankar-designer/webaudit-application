# Audit accuracy: how findings are verified before they are reported

A client report must describe the site's real condition. These rules make sure an automated
detection is never presented as a confirmed defect unless it has been verified.

## Three states

| State in the app | Meaning | Counted as a defect? |
|---|---|---|
| **Confirmed** (status `open`) | A deterministic check failed on the rendered page or response (DOM, accessibility tree, response headers, HTTP status), and single-observation detections were reproduced by a second request. | Yes — the only state in the priority totals |
| **Needs Manual Review** (`needs_review`) | The tool could not decide automatically; a person must check it against the stated criterion (for example axe-core "incomplete" colour contrast over images or gradients). | No |
| **Pending Verification** (`inconclusive`) | Seen once but not reproduced: blocked (401/403/429), timed out, or intermittent (failed in the scan, worked on re-check). | No |

Severity totals on the scan summary, report and PDF count **confirmed issues only**. Review and
pending items are listed with their own counts.

## Verification steps (server/src/scanner/verify.ts)

| Detection | Re-check | Outcome |
|---|---|---|
| Image did not render in Chrome | Fresh GET of the image URL with an image `Accept` header; one retry for timeouts and 5xx | 2xx with real image data (content type or file signature) → **dismissed as a false positive** and listed under "Dismissed false positives"; 4xx/5xx or a non-image response → confirmed, with the re-check result as evidence; 401/403/429/timeout → pending |
| Broken link (internal or external) | Fresh GET after a short pause | Same failure → confirmed, with the re-check as evidence; works now → pending (intermittent); refused → pending |

Chrome's own cancelled requests (`net::ERR_ABORTED` during lazy loading, superseded `srcset`
candidates) are no longer recorded as failed images at all.

## Classification fixes

- **Redirecting internal links are not broken links.** `links.internal-redirect` is severity
  *info* and titled "Internal link goes through a redirect (the link works)". The category is
  called **Links**, not "Broken links".
- **Colour contrast:** axe-core *violations* (computed foreground/background ratio below the WCAG
  threshold) are confirmed; axe-core *incomplete* results are Needs Manual Review, with an
  explanation that they are not WCAG failures until checked.
- **No duplicates across pages:** per rule, every element seen on two or more pages (same
  normalised HTML for accessibility rules, same image URL, same heading, same error with per-request
  tokens removed) is reported in **one site-wide issue** that lists each element and its pages — a
  header icon link without a label on 40 pages is one issue, fixed once. Elements found on a single
  page stay that page's issue. Implemented in `server/src/scanner/consolidate.ts`. Older per-page
  issues covered by a grouped issue are closed as "Merged … it was not fixed" (never counted as
  resolved), and if one is reported per page again it continues as open — never "reopened".
- **Expected third-party behaviour is not reported:** Cloudflare Turnstile's Private Access Token
  probe answers 401 by design and its sandboxed iframe logs fingerprinting messages; neither is
  something the site owner can fix (`isBenignThirdParty` in `checks/pageRuntime.ts`).

## What every finding carries

The affected URL(s) and element(s) (selector, HTML snippet or resource URL), a plain-language
explanation, the evidence (axe-core failure summary, HTTP result, re-check result), the rule id and
detection method (the validation rule), WCAG references where applicable, and a recommended fix
with verification steps.

## Full scans cover all pages

Full scans default to **All pages**: every page found from the start page's links and the XML
sitemap, up to the plan limit (Free 100, Pro and Agency 1,000; hard cap `SCAN_HARD_MAX_PAGES`,
default 1,000). Discovery now reports how many pages exist, so the scope reads "All 57 pages found"
or "100 of 230 pages found — 130 not scanned because of the 100-page limit".

## Comparing a report with a fresh scan

`node scripts/compare-scans.mjs <oldScanId> <newScanId>` classifies every finding of an earlier
report as Confirmed, Needs manual review, Pending verification, Reclassified, False positive
(disproved by re-request) or Not reproduced.
