# Known limitations

## Inherent to automated auditing

- **Accessibility:** axe-core finds only part of WCAG failures. Keyboard flows, focus order, meaningful alt text, captions, cognitive load and screen-reader experience need human testing. A clean scan does not mean conformance.
- **Performance:** Lighthouse lab results from one run on the scanner's hardware and network. They are not field Core Web Vitals, INP is not measured, and results vary between runs.
- **SEO:** technical signals only, no ranking predictions. Structured data is checked for JSON syntax, not schema.org validity.
- **Security:** passive observations of public responses. It is not a vulnerability scanner or penetration test.
- **Visual comparison:** dynamic content (sliders, ads, dates, consent banners, lazy-loaded media, font loading) can cause differences. Use ignore selectors and review each change.
- **JavaScript-heavy sites:** discovery follows links in server-delivered HTML and sitemaps. Links that only appear after JavaScript runs are found on scanned pages (via the rendered DOM) for link checking, but are not used to discover new pages.
- **Bot protection:** firewalls and CDNs may block or rate-limit the scanner. Those results are reported as *Inconclusive*, not as defects.

## Not implemented in this version

- **Configurable form and functional tests** (spec 8K). Forms are only inspected (labels via axe-core, insecure actions); nothing is submitted. The intended design: per-website test definitions (selectors, test values, expected outcome) that are only allowed against hosts the owner has verified (DNS TXT or file token), with dry-run by default, plus a hard rule against payment and e-mail endpoints.
- **Authenticated or private staging scans.** Only public URLs are scanned. The intended design is an explicit integration (verified host, scoped test credentials stored encrypted, or an outbound agent/plugin on the staging site) rather than bypassing access controls.
- **Payments.** No Stripe or other provider. Plans are set by an operator (`plan:set`).
- **E-mail:** no verification, password reset, invitations or notifications. Members are added only if they already have an account.
- **Scheduled or recurring scans** and change alerts.
- **Gzip-compressed sitemaps** (`.xml.gz`) are skipped, with a note in the scan.
- **Screenshot storage** is the local filesystem. Multi-host deployments need a shared volume. An S3 adapter is not written.
- **Screenshots** are capped at 8000 CSS px tall. Content below that is not compared visually.
- **Link checks** are capped by `LINK_CHECK_MAX` (default 300 unique targets per scan). Pages with unchecked links are not counted as covered, so their link issues are not resolved by that scan.
- **Lighthouse** runs only on the first `LIGHTHOUSE_MAX_PAGES` pages (default 3) per viewport.
- **Report branding** is a name only (no logo upload).
- **AI**: provider calls were not exercised live during development. Generated text is not post-validated beyond prompt rules and labelling as AI output. There is no "apply change" feature: the AI never modifies sites, by design.
- **Mobile viewport:** one phone profile (390×844 at 2× density), not a device matrix.
