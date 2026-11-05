# Audit comparison — https://yellowumbrellatours.ie/

Original scan `f08251de-647f-4af2-b6ea-8215c23ce0b1` (2026-10-28T09:36:41.222Z): 10 pages, **112 reported issues**.
Fresh scan `9e710e73-569b-4a49-9f1a-364d988d80ad` (2026-10-28T11:17:55.069Z): 98 of 98 pages found, **254 confirmed issues**, 85 need manual review, 0 pending verification (339 issue records in total after grouping).

| Classification of the original findings | Count |
|---|---|
| Confirmed | 73 |
| Needs manual review | 10 |
| Pending verification | 0 |
| Reclassified | 23 |
| False positive | 4 |
| Not reproduced | 2 |

## Confirmed (73)

| Original finding | Rule | Page | Note |
|---|---|---|---|
| ARIA hidden element must not be focusable or contain focusable elements | `axe.aria-hidden-focus` | /blog/ |  |
| Elements must meet minimum color contrast ratio thresholds | `axe.color-contrast` | /tours/ |  |
| Elements must meet minimum color contrast ratio thresholds | `axe.color-contrast` | / |  |
| Elements must meet minimum color contrast ratio thresholds | `axe.color-contrast` | /about-us/ |  |
| Elements must meet minimum color contrast ratio thresholds | `axe.color-contrast` | /contact-us/ |  |
| Elements must meet minimum color contrast ratio thresholds | `axe.color-contrast` | /blog/ |  |
| Elements must meet minimum color contrast ratio thresholds | `axe.color-contrast` | /tours/?city=dublin |  |
| Elements must meet minimum color contrast ratio thresholds | `axe.color-contrast` | /tours/?city=galway |  |
| Elements must meet minimum color contrast ratio thresholds | `axe.color-contrast` | /tours/?city=cork |  |
| Elements must meet minimum color contrast ratio thresholds | `axe.color-contrast` | /tours/?city=derry |  |
| Elements must meet minimum color contrast ratio thresholds | `axe.color-contrast` | /tours/?city=belfast |  |
| Headings should not be empty | `axe.empty-heading` | /about-us/ |  |
| Frames must have an accessible name | `axe.frame-title` | /contact-us/ |  |
| Links must have discernible text | `axe.link-name` | /tours/ |  |
| Links must have discernible text | `axe.link-name` | / |  |
| Links must have discernible text | `axe.link-name` | /about-us/ |  |
| Links must have discernible text | `axe.link-name` | /contact-us/ |  |
| Links must have discernible text | `axe.link-name` | /blog/ |  |
| Links must have discernible text | `axe.link-name` | /tours/?city=dublin |  |
| Links must have discernible text | `axe.link-name` | /tours/?city=galway |  |
| Links must have discernible text | `axe.link-name` | /tours/?city=cork |  |
| Links must have discernible text | `axe.link-name` | /tours/?city=derry |  |
| Links must have discernible text | `axe.link-name` | /tours/?city=belfast |  |
| All page content should be contained by landmarks | `axe.region` | /tours/ |  |
| All page content should be contained by landmarks | `axe.region` | / |  |
| All page content should be contained by landmarks | `axe.region` | /about-us/ |  |
| All page content should be contained by landmarks | `axe.region` | /contact-us/ |  |
| All page content should be contained by landmarks | `axe.region` | /blog/ |  |
| All page content should be contained by landmarks | `axe.region` | /tours/?city=dublin |  |
| All page content should be contained by landmarks | `axe.region` | /tours/?city=galway |  |
| All page content should be contained by landmarks | `axe.region` | /tours/?city=cork |  |
| All page content should be contained by landmarks | `axe.region` | /tours/?city=derry |  |
| All page content should be contained by landmarks | `axe.region` | /tours/?city=belfast |  |
| Select element must have an accessible name | `axe.select-name` | / |  |
| Select element must have an accessible name | `axe.select-name` | /about-us/ |  |
| Select element must have an accessible name | `axe.select-name` | /blog/ |  |
| Heading levels are skipped | `html.heading-level-skipped` | /tours/ |  |
| Heading levels are skipped | `html.heading-level-skipped` | / |  |
| Heading levels are skipped | `html.heading-level-skipped` | /about-us/ |  |
| Heading levels are skipped | `html.heading-level-skipped` | /contact-us/ |  |
| Heading levels are skipped | `html.heading-level-skipped` | /blog/ |  |
| Heading levels are skipped | `html.heading-level-skipped` | /tours/?city=dublin |  |
| Heading levels are skipped | `html.heading-level-skipped` | /tours/?city=galway |  |
| Heading levels are skipped | `html.heading-level-skipped` | /tours/?city=cork |  |
| Heading levels are skipped | `html.heading-level-skipped` | /tours/?city=derry |  |
| Heading levels are skipped | `html.heading-level-skipped` | /tours/?city=belfast |  |
| Large image files | `images.large-file` | / |  |
| Images without width and height attributes | `images.missing-dimensions` | /tours/ |  |
| Images without width and height attributes | `images.missing-dimensions` | / |  |
| Images without width and height attributes | `images.missing-dimensions` | /about-us/ |  |
| Images without width and height attributes | `images.missing-dimensions` | /contact-us/ |  |
| Images without width and height attributes | `images.missing-dimensions` | /blog/ |  |
| Images without width and height attributes | `images.missing-dimensions` | /tours/?city=dublin |  |
| Images without width and height attributes | `images.missing-dimensions` | /tours/?city=galway |  |
| Images without width and height attributes | `images.missing-dimensions` | /tours/?city=cork |  |
| Images without width and height attributes | `images.missing-dimensions` | /tours/?city=derry |  |
| Images without width and height attributes | `images.missing-dimensions` | /tours/?city=belfast |  |
| Images are much larger than displayed | `images.oversized` | / |  |
| Images are much larger than displayed | `images.oversized` | / |  |
| Images are much larger than displayed | `images.oversized` | /blog/ |  |
| Slow Largest Contentful Paint (lab) | `performance.lcp` | /tours/ |  |
| Slow Largest Contentful Paint (lab) | `performance.lcp` | / |  |
| Performance improvement opportunities | `performance.opportunity` | /tours/ |  |
| Performance improvement opportunities | `performance.opportunity` | /tours/ |  |
| Performance improvement opportunities | `performance.opportunity` | /about-us/ |  |
| Cookie set without the Secure flag | `security.cookie-missing-secure` | / |  |
| No Content Security Policy | `security.missing-csp` | / |  |
| No protection against being framed (clickjacking) | `security.missing-frame-protection` | / |  |
| HSTS header not set | `security.missing-hsts` | / |  |
| Referrer-Policy header not set | `security.missing-referrer-policy` | / |  |
| X-Content-Type-Options header not set | `security.missing-x-content-type-options` | / |  |
| Several pages share the same meta description | `seo.duplicate-meta-description` | /tours/?city=galway, /tours/?city=cork, /tours/?city=derry, /tours/, /tours/?city=dublin, /tours/?city=belfast |  |
| Several pages share the same title | `seo.duplicate-title` | /tours/, /tours/?city=dublin, /tours/?city=galway, /tours/?city=cork, /tours/?city=derry, /tours/?city=belfast |  |

## Needs manual review (10)

| Original finding | Rule | Page | Note |
|---|---|---|---|
| Check manually: Elements must meet minimum color contrast ratio thresholds | `axe-review.color-contrast` | /tours/ | axe-core could not decide automatically (for example text over an image or gradient). Not a confirmed WCAG failure. |
| Check manually: Elements must meet minimum color contrast ratio thresholds | `axe-review.color-contrast` | / | axe-core could not decide automatically (for example text over an image or gradient). Not a confirmed WCAG failure. |
| Check manually: Elements must meet minimum color contrast ratio thresholds | `axe-review.color-contrast` | /about-us/ | axe-core could not decide automatically (for example text over an image or gradient). Not a confirmed WCAG failure. |
| Check manually: Elements must meet minimum color contrast ratio thresholds | `axe-review.color-contrast` | /contact-us/ | axe-core could not decide automatically (for example text over an image or gradient). Not a confirmed WCAG failure. |
| Check manually: Elements must meet minimum color contrast ratio thresholds | `axe-review.color-contrast` | /blog/ | axe-core could not decide automatically (for example text over an image or gradient). Not a confirmed WCAG failure. |
| Check manually: Elements must meet minimum color contrast ratio thresholds | `axe-review.color-contrast` | /tours/?city=dublin | axe-core could not decide automatically (for example text over an image or gradient). Not a confirmed WCAG failure. |
| Check manually: Elements must meet minimum color contrast ratio thresholds | `axe-review.color-contrast` | /tours/?city=galway | axe-core could not decide automatically (for example text over an image or gradient). Not a confirmed WCAG failure. |
| Check manually: Elements must meet minimum color contrast ratio thresholds | `axe-review.color-contrast` | /tours/?city=cork | axe-core could not decide automatically (for example text over an image or gradient). Not a confirmed WCAG failure. |
| Check manually: Elements must meet minimum color contrast ratio thresholds | `axe-review.color-contrast` | /tours/?city=derry | axe-core could not decide automatically (for example text over an image or gradient). Not a confirmed WCAG failure. |
| Check manually: Elements must meet minimum color contrast ratio thresholds | `axe-review.color-contrast` | /tours/?city=belfast | axe-core could not decide automatically (for example text over an image or gradient). Not a confirmed WCAG failure. |

## Reclassified (23)

| Original finding | Rule | Page | Note |
|---|---|---|---|
| Console errors from third-party scripts | `javascript.console-error-third-party` | / | Expected Cloudflare Turnstile behaviour (its token probe answers 401 by design; its iframe logs fingerprinting messages). Not a site defect; no longer reported. |
| Console errors from third-party scripts | `javascript.console-error-third-party` | /about-us/ | Expected Cloudflare Turnstile behaviour (its token probe answers 401 by design; its iframe logs fingerprinting messages). Not a site defect; no longer reported. |
| Console errors from third-party scripts | `javascript.console-error-third-party` | /contact-us/ | Expected Cloudflare Turnstile behaviour (its token probe answers 401 by design; its iframe logs fingerprinting messages). Not a site defect; no longer reported. |
| Console errors from third-party scripts | `javascript.console-error-third-party` | /blog/ | Expected Cloudflare Turnstile behaviour (its token probe answers 401 by design; its iframe logs fingerprinting messages). Not a site defect; no longer reported. |
| Third-party resources failed to load | `javascript.failed-request-third-party` | / | Expected Cloudflare Turnstile behaviour (its token probe answers 401 by design; its iframe logs fingerprinting messages). Not a site defect; no longer reported. |
| Third-party resources failed to load | `javascript.failed-request-third-party` | /about-us/ | Expected Cloudflare Turnstile behaviour (its token probe answers 401 by design; its iframe logs fingerprinting messages). Not a site defect; no longer reported. |
| Third-party resources failed to load | `javascript.failed-request-third-party` | /contact-us/ | Expected Cloudflare Turnstile behaviour (its token probe answers 401 by design; its iframe logs fingerprinting messages). Not a site defect; no longer reported. |
| Third-party resources failed to load | `javascript.failed-request-third-party` | /blog/ | Expected Cloudflare Turnstile behaviour (its token probe answers 401 by design; its iframe logs fingerprinting messages). Not a site defect; no longer reported. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | /tours/, /, /about-us/, /contact-us/, /blog/, /tours/?city=dublin, /tours/?city=galway, /tours/?city=cork, /tours/?city=derry, /tours/?city=belfast | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | /tours/, /tours/?city=dublin, /tours/?city=galway, /tours/?city=cork, /tours/?city=derry, /tours/?city=belfast | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | /tours/, /tours/?city=dublin, /tours/?city=belfast | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | /tours/ | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | /tours/ | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | / | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | /tours/, /, /about-us/, /contact-us/, /blog/, /tours/?city=dublin, /tours/?city=galway, /tours/?city=cork, /tours/?city=derry, /tours/?city=belfast | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | / | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | / | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | / | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | / | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | /tours/?city=dublin | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | /tours/?city=dublin | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | /tours/?city=dublin | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |
| Internal link goes through a redirect (the link works) | `links.internal-redirect` | /tours/?city=dublin | The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link. |

## False positive (4)

| Original finding | Rule | Page | Note |
|---|---|---|---|
| Image failed to load | `images.broken` | /tours/ | All 8 image(s) load: re-requested live, each returned HTTP 200 image/jpeg / HTTP 200 image/webp with image data. The original scan counted Chrome's own cancelled lazy-load requests as failures (fixed). |
| Image failed to load | `images.broken` | /about-us/ | All 12 image(s) load: re-requested live, each returned HTTP 200 image/webp / HTTP 200 image/jpeg with image data. The original scan counted Chrome's own cancelled lazy-load requests as failures (fixed). |
| Image failed to load | `images.broken` | /contact-us/ | All 2 image(s) load: re-requested live, each returned HTTP 200 image/webp with image data. The original scan counted Chrome's own cancelled lazy-load requests as failures (fixed). |
| Image failed to load | `images.broken` | /blog/ | All 2 image(s) load: re-requested live, each returned HTTP 200 image/webp with image data. The original scan counted Chrome's own cancelled lazy-load requests as failures (fixed). |

## Not reproduced (2)

| Original finding | Rule | Page | Note |
|---|---|---|---|
| Slow Largest Contentful Paint (lab) | `performance.lcp` | /about-us/ | Not found when the same check re-ran on the same page. |
| Performance improvement opportunities | `performance.opportunity` | / | Not found when the same check re-ran on the same page. |

