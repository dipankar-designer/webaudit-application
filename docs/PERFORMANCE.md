# Performance analysis: method, scoring and limits

This describes what the Performance section measures, where each number comes from, how scores are
calculated, and what it cannot tell you. Everything shown is measured; anything that could not be
measured is shown as unavailable, never estimated.

## What is tested

- **Which page:** the home (start) page of each Full scan, on **mobile and desktop** — the same scope as
  PageSpeed Insights. Other pages get the scanner's page-level checks (images, JavaScript errors, sizes),
  not a full Lighthouse report.
- **Tool:** Lighthouse (the version is shown in *Test conditions*), run by our server in headless Chrome,
  through the scanner's safety proxy (it blocks requests to private networks).
- **Runs:** `LIGHTHOUSE_RUNS` runs per device (default 3); the run with the **median performance score**
  is reported, and all run scores are listed. One run can vary by 20+ points with network conditions.

## Test conditions (shown in the report)

Every report records Lighthouse's exact settings: emulated screen size and pixel ratio, round-trip time,
throughput, CPU slowdown, throttling method, the test machine's CPU benchmark and the Chrome version.

- **Mobile:** emulated mid-range phone (Moto G Power class), slow-4G network, 4× CPU slowdown.
- **Desktop:** emulated desktop screen, fast network, no CPU slowdown.
- **Simulated, not real:** with Lighthouse's default *simulated* throttling the page loads at full speed and
  Lighthouse models the slower device and network. The report says so: these are **not measurements on
  a real phone or network**.
- **Location matters:** the test machine's distance from the site's server adds latency. A test from a
  server far from the site (or behind a slow connection) scores lower than PageSpeed Insights, which tests
  from Google's data centres.

## Scores

- **Performance score:** Lighthouse's own score (0–100), a weighted combination of lab metrics — not ours.
  Lighthouse publishes the weights and the scoring curves for each version (see the
  [Lighthouse scoring guide](https://developer.chrome.com/docs/lighthouse/performance/performance-scoring)).
  Bands: 0–49 poor, 50–89 needs improvement, 90–100 good.
- **Accessibility, Best Practices, SEO, Agentic Browsing:** Lighthouse's category scores, shown alongside.
- **Kept separate:** the Performance score is never mixed into anything else. WebAudit AI has no single
  "overall website health score"; issues are counted by severity (see [SEVERITY.md](SEVERITY.md)), and
  confirmed issues are counted separately from those needing manual review.

## Core Web Vitals

- **Real users (field data):** the Chrome UX Report's 75th percentile over 28 days, with Google's
  thresholds:

  | Metric | Good | Poor |
  |---|---|---|
  | LCP | ≤ 2.5 s | > 4 s |
  | INP | ≤ 200 ms | > 500 ms |
  | CLS | ≤ 0.1 | > 0.25 |
  | FCP (other notable metric) | ≤ 1.8 s | > 3 s |
  | TTFB (other notable metric) | ≤ 0.8 s | > 1.8 s |

  It needs `CRUX_API_KEY`.
- **Without the key:** the same layout shows this scan's own lab values, labelled *Lab*. The *Lab*
  verdict applies the rule PageSpeed Insights uses when INP has no data: LCP and CLS both Good. INP
  cannot be measured in a lab test and stays N/A.

## Resource analysis

From Lighthouse's network log of the median run:

- **Requests:** every request (up to 300 per report; the largest are kept if there are more), with:
  - type, HTTP status and priority;
  - transferred (compressed) size and decoded size;
  - load time under the test's conditions;
  - protocol;
  - first or third party, using Lighthouse's own classification of origins.
- **Page weight:** totals by resource type.
- **Third parties:** transfer size and main-thread time per company or service.
- **Lighthouse findings per file:** the files Lighthouse's audits flagged (render-blocking, unused
  JavaScript or CSS, not minified, short cache lifetime, image could be smaller, font blocks text,
  legacy or duplicated JavaScript, unsized images, long main-thread tasks), with the bytes or
  milliseconds Lighthouse reports. The row itself is the evidence.

Reports made before 30 October 2026 do not contain this data; run a new Full scan.

## WordPress performance information

Only when the site is detected as WordPress (see [WORDPRESS.md](WORDPRESS.md)):

- **Front-end assets by plugin or theme:**
  - Requests grouped by the `wp-content/plugins/<slug>/`, `wp-content/themes/<slug>/` or `wp-includes/`
    folder they were served from.
  - **This attributes files by location only.** Loading files is not evidence that a plugin slows the page.
    The table lists which of those files Lighthouse actually flagged, and nothing more is claimed.
- **Possible duplicate assets:**
  - Scripts or stylesheets with the same file name loaded from more than one address (for example jQuery
    from WordPress and from a CDN).
  - Same name is a hint, not proof; generic names (`style.css`, `main.js`…) are ignored.
- **Caching and compression indicators:** from the home page response received during the scan.
  - **Headers:** cache headers (Cloudflare, LiteSpeed, Hostinger, Kinsta, Sucuri, Varnish, Nginx and
    others), `Age`, `Cache-Control` and `Content-Encoding`.
  - **HTML signatures:** text that page-cache and optimisation plugins write into the page (WP Rocket,
    W3 Total Cache, WP Super Cache, LiteSpeed Cache, WP Fastest Cache, Hummingbird, Autoptimize).
  - **Evidence:** each indicator shows the exact header or text it came from.
  - **One response only:** it describes that one response, not the site's full configuration. A cache
    "miss" can be normal.
- **Server-side time cannot be measured from outside.** This covers PHP execution, database queries and
  which plugin's code is slow. It needs an authorised tool on the site itself, for example the Query
  Monitor plugin or the host's application performance monitoring, used with the owner's permission.

## Comparison with the previous scan

- **What is compared:** the latest earlier completed scan of the same website, same page and same device.
  - Lighthouse category scores.
  - The five lab metrics.
  - Page weight and request count.
  - Lighthouse performance audits that started or stopped failing (score below or at least 0.9).
- **Normal variation:** differences within normal lab variation are shown as *about the same*, not better
  or worse:
  - under 3 score points;
  - under 5% (and at least 50 ms) for timings;
  - under 0.01 for CLS;
  - under 2% for page weight.
- **Different test conditions** are listed with the comparison, when they apply:
  - Lighthouse version;
  - throttling;
  - emulated screen;
  - a test-machine CPU speed differing by more than 25%;
  - number of runs.
- **No causes:** the comparison never says what caused a change.

## AI Performance Fix Assistant

- **What it does:** writes a prioritised fix plan from this scan's measured data only:
  - metrics and failing audits, with Lighthouse's savings estimates;
  - the heaviest requests;
  - third parties;
  - the WordPress assets, duplicates and delivery indicators described above.
- **Rules in the prompt:**
  - use only the given numbers;
  - call Lighthouse's estimates estimates;
  - never invent causes, scores or improvements;
  - name a plugin only if it is in the data, and only call its files a problem if Lighthouse flagged them;
  - explain when server-side profiling is needed;
  - give each fix a verification step.
- **Runs in the background:** a local model on a CPU can take several minutes. The page shows progress
  and can be left meanwhile.
- **Requirements:** `AI_PROVIDER` (`anthropic` with `ANTHROPIC_API_KEY`, or `ollama`).
  - For Ollama, `OLLAMA_MAX_CTX` caps the context window. Prompts are sized to fit, because Ollama's
    default window silently drops the start of long prompts.

## Monitoring performance over time (assessment)

- **Feasible with the existing infrastructure:** scheduled Full scans would reuse the scan queue and
  worker; the monitoring scheduler already runs timed jobs. A regression alert would reuse the comparison
  above and the alert e-mails.
- **Not built yet:** each scheduled Lighthouse run costs 1–3 minutes of CPU per device. Alerts must apply
  the variability thresholds above, or they would fire on noise.
- **Recommended design:**
  - Weekly scheduled scans per website, with a plan limit.
  - A trend chart from the stored `lighthouse_reports`.
  - Alerts only when a regression beyond the thresholds appears in two consecutive scans.

## Credentials and settings

| Setting | Needed for | Default |
|---|---|---|
| `CRUX_API_KEY` | Real-user Core Web Vitals | not set (lab values shown) |
| `LIGHTHOUSE_RUNS` | Runs per device behind the median | 3 |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY` or `OLLAMA_URL`/`OLLAMA_MODEL` | AI fix plans | AI off |
| `OLLAMA_MAX_CTX` | Largest Ollama context window | 16384 |
