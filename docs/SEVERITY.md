# Severity policy

Severity is fixed per rule in `server/src/scanner/rules.ts`. It is never computed ad hoc at scan time. Each rule records which criterion below it uses, and the issue page shows that reason.

| Severity | Criterion | Examples |
|---|---|---|
| **Critical** | The website itself cannot be used. Reserved for availability of the start page / site. | Site unreachable, home page 5xx, broken HTTPS certificate |
| **High** | A core function or a group of users is blocked, or search engines are told to drop important content. | Linked page 404/5xx or timing out, broken internal link, first-party uncaught JavaScript error, form posting over HTTP, mixed active content, home page `noindex`, robots.txt blocking the site, site without HTTPS or not redirecting HTTP, axe-core *critical* |
| **Medium** | Degrades the experience or discoverability for some visitors, but the page works. | Missing `lang` or `<title>`, missing viewport meta, broken image, horizontal overflow, invalid JSON-LD, wrong canonical, first-party console errors or failed requests, broken external link, slow lab LCP/CLS/TBT, visual change vs baseline, axe-core *serious* |
| **Low** | Best-practice gap with limited direct impact. | Missing meta description/canonical/doctype/charset, skipped heading levels, duplicate IDs, missing security headers (HSTS, CSP, nosniff, framing), unsized/oversized/large images, redirect chains, third-party script errors, axe-core *moderate* |
| **Informational** | Observation; review whether it is intended. | No sitemap, no Referrer-Policy, version numbers in headers, multiple `<h1>`, page with no internal links, axe-core *minor* |

## axe-core mapping

| axe impact | Severity |
|---|---|
| critical | High |
| serious | Medium |
| moderate | Low |
| minor | Informational |

Critical is reserved for availability, so no accessibility rule can outrank a site that is down. WCAG success criteria come from axe tags (`wcag111` → 1.1.1). Elements axe-core could not evaluate (its *incomplete* results, for serious and critical impact only) become separate "Check manually: …" issues with status **Needs Review**.

## Status, confidence and uncertainty

- **Needs Review**: heuristic checks where a person must judge intent (e.g. `noindex` on an inner page, much less content on mobile, a visual difference, axe incomplete results).
- **Inconclusive**: the scanner could not get a definitive answer (401/403/429, timeouts on links, a page refusing the scanner).
- **Not Tested**: a verification scan could not re-run the check where the issue was seen.
- Each rule also states a **confidence** (high/medium/low) and its **limitations**. Both appear on the issue page and in reports.

Severity is about the impact if the finding is real. It is not a ranking, legal or compliance prediction.
