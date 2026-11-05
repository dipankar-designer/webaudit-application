// Step-by-step fixes for Lighthouse audits, written for site owners and developers (WordPress-aware).
// Lighthouse's own description and "Learn more" link are always shown as well; audits without an
// entry here get the generic steps at the bottom.

export const LH_FIXES: Record<string, string[]> = {
  // ---------------------------------------------------------------- performance: insights
  'render-blocking-insight': [
    'Open the table below: each row is a CSS or JavaScript file the browser must download before it can draw the page.',
    'For scripts that are not needed for the first screen, add `defer` (or `async` for independent scripts). In WordPress, WP Rocket → File Optimization → “Load JavaScript deferred” does this.',
    'For CSS, inline the small amount needed for the first screen (“critical CSS”) and load the rest later. WP Rocket → “Optimize CSS delivery” / “Remove unused CSS”.',
    'Remove plugin stylesheets and scripts from pages that do not use them (for example a form plugin’s CSS on every page) with Perfmatters or Asset CleanUp.',
    'Re-run the scan and confirm the render-blocking time has dropped.',
  ],
  'cache-insight': [
    'The table lists files served with a short or missing cache lifetime.',
    'For your own static files (CSS, JS, images, fonts) set `Cache-Control: public, max-age=31536000, immutable` — use versioned file names (WordPress adds `?ver=`) so updates still arrive.',
    'On Cloudflare: Caching → Configuration → Browser Cache TTL, or a Cache Rule for /wp-content/ and /wp-includes/.',
    'Third-party files (analytics, widgets) cannot be changed by you; ignore those rows.',
  ],
  'cls-culprits-insight': [
    'Find the elements listed below — they moved after the page first appeared.',
    'Give every image and video `width` and `height` attributes (or CSS `aspect-ratio`) so space is reserved.',
    'Reserve space for banners, cookie notices, ads and embeds with a fixed `min-height` instead of inserting them above existing content.',
    'Use `font-display: swap` with a fallback font of similar size, or preload the main web font.',
  ],
  'document-latency-insight': [
    'The first response from the server is slow or redirects before reaching the page.',
    'Enable full-page caching (WP Rocket, LiteSpeed Cache or Cloudflare APO) so HTML is served from cache.',
    'Link straight to the final URL (https and the correct www / non-www form) to avoid redirects.',
    'Make sure text compression (Brotli or gzip) is on — Cloudflare enables it by default.',
  ],
  'dom-size-insight': [
    'The page has a very large number of HTML elements, which slows rendering and interaction.',
    'Paginate or lazy-load long lists (tours, blog posts, galleries) instead of rendering everything at once.',
    'Simplify page-builder layouts: remove empty wrappers, hidden sections and duplicated mobile/desktop blocks.',
  ],
  'duplicated-javascript-insight': [
    'The same JavaScript module is shipped more than once (often two copies of a library from different plugins).',
    'Check which plugins bundle the library listed below and keep only one, or let the theme load it once.',
  ],
  'font-display-insight': [
    'Text stays invisible while the web font downloads.',
    'Add `font-display: swap` to the @font-face rules (Google Fonts: add `&display=swap` to the URL; WP Rocket and most font plugins have an option).',
    'Host the fonts locally and preload the one used above the fold.',
  ],
  'forced-reflow-insight': [
    'A script reads layout (sizes, positions) right after changing styles, forcing the browser to recalculate layout.',
    'Look at the source files listed; batch DOM reads before writes, or use `requestAnimationFrame`.',
    'If the file belongs to a plugin or theme, update it or report it to the developer.',
  ],
  'image-delivery-insight': [
    'The images below are larger in file size than needed.',
    'Serve modern formats (WebP or AVIF) — Imagify, ShortPixel or EWWW convert existing images automatically.',
    'Upload images at the size they are displayed (WordPress generates sizes; make the theme use `srcset`).',
    'Compress at quality 75–85; the estimated savings show how much can be saved per image.',
  ],
  'inp-breakdown-insight': [
    'Interactions (clicks, taps) took long to respond. Reduce JavaScript that runs on input: delay non-essential scripts until user interaction (WP Rocket → “Delay JavaScript execution”).',
  ],
  'lcp-breakdown-insight': [
    'This shows where the time to the Largest Contentful Paint goes: server response, resource load delay, load time, render delay.',
    'Large “load delay” → the LCP image is discovered late: preload it and do not lazy-load it.',
    'Large “load time” → the file is heavy: compress it or serve WebP/AVIF.',
    'Large “render delay” → render-blocking CSS/JS: see the render-blocking item.',
  ],
  'lcp-discovery-insight': [
    'The main (LCP) image should be found in the initial HTML and requested early.',
    'Remove `loading="lazy"` from the hero image (WP Rocket → Media → exclude the hero image from LazyLoad).',
    'Add `fetchpriority="high"` to the hero `<img>`, or a `<link rel="preload" as="image">` in the head.',
    'Avoid setting the hero image as a CSS background set by JavaScript (sliders often do this).',
  ],
  'legacy-javascript-insight': [
    'Some scripts include polyfills and transforms modern browsers do not need.',
    'Update the plugins/theme listed, or rebuild your own code targeting modern browsers (no ES5 transpiling).',
  ],
  'modern-http-insight': ['Serve the site over HTTP/2 or HTTP/3 — enabled by default on Cloudflare and most modern hosting.'],
  'network-dependency-tree-insight': [
    'This chain shows requests that wait for other requests. Long chains delay rendering.',
    'Preload critical fonts and CSS found deep in the chain, and use `preconnect` for required third-party origins.',
  ],
  'third-parties-insight': [
    'Third-party code (chat widgets, maps, analytics, embeds) adds main-thread time and transfer size.',
    'Remove what you no longer use; load the rest only where needed and after interaction (facades for YouTube/Maps).',
  ],
  'viewport-insight': ['Add `<meta name="viewport" content="width=device-width, initial-scale=1">` so taps respond without delay on mobile.'],

  // ---------------------------------------------------------------- performance: diagnostics
  'unused-css-rules': [
    'Large parts of the CSS are not used on this page.',
    'Enable “Remove unused CSS” (WP Rocket) or per-page asset control (Perfmatters / Asset CleanUp).',
    'Disable page-builder and plugin stylesheets on pages that do not use those features.',
  ],
  'unused-javascript': [
    'Large parts of the JavaScript are not used on this page.',
    'Unload plugin scripts on pages that do not need them, and delay the rest until interaction.',
    'For third-party scripts, remove unused tags in Google Tag Manager.',
  ],
  'unminified-css': ['Minify CSS (WP Rocket → File Optimization → Minify CSS files, or Cloudflare Auto Minify).'],
  'unminified-javascript': ['Minify JavaScript (WP Rocket → File Optimization → Minify JavaScript files).'],
  'total-byte-weight': [
    'The page downloads a lot of data. Start with the largest files in the table: images, videos, fonts and scripts.',
    'Compress images, lazy-load images below the fold, and remove unused scripts and fonts.',
  ],
  'bootup-time': ['JavaScript takes long to parse and run. Remove or delay the heaviest scripts listed.'],
  'mainthread-work-breakdown': ['The main thread is busy (scripts, style, layout). Reduce JavaScript and simplify complex layouts and animations.'],
  'long-tasks': ['Long tasks block the page from responding. Split heavy scripts, delay non-critical ones and remove unused plugins.'],
  'unsized-images': ['Add `width` and `height` attributes to every listed image so the browser reserves space.'],
  'non-composited-animations': ['Animate only `transform` and `opacity`; avoid animating `width`, `top`, `left` or colours.'],
  'critical-request-chains': ['Shorten chains of dependent requests: preload key fonts/CSS and inline critical CSS.'],
  'lcp-lazy-loaded': ['Do not lazy-load the main (LCP) image — exclude it from the lazy-load plugin.'],
  'prioritize-lcp-image': ['Preload the LCP image and add `fetchpriority="high"`.'],

  // ---------------------------------------------------------------- accessibility
  'color-contrast': [
    'Each row below is text whose colour is too close to its background (WCAG 1.4.3 needs 4.5:1, or 3:1 for large text).',
    'Darken the text or lighten the background in the theme / page builder colour settings; check with a contrast checker.',
    'Re-run the scan; Lighthouse and axe-core recompute the ratio.',
  ],
  'link-name': [
    'These links have no text a screen reader can announce — usually icon-only links (social icons, arrows, image links).',
    'Add visible text, or an `aria-label` that says where the link goes (e.g. `aria-label="Yellow Umbrella Tours on Facebook"`).',
    'For image links, give the image a meaningful `alt` text.',
  ],
  'select-name': [
    'These drop-down menus have no label.',
    'Add a `<label for="…">` or an `aria-label` describing the choice (e.g. “Choose a city”). In form plugins, fill in the field label and do not hide it from assistive technology.',
  ],
  label: ['Every form field needs a programmatic label: a `<label for>` element or `aria-label`. Placeholders do not count.'],
  'button-name': ['Icon-only buttons need an `aria-label` describing the action (e.g. “Open menu”).'],
  'image-alt': ['Add `alt` text describing each meaningful image; use `alt=""` for decorative images. In WordPress: Media Library → Alternative Text.'],
  'heading-order': [
    'Headings jump levels (for example h2 → h4). Screen-reader users navigate by headings, so the outline must be logical.',
    'Change the heading level in the editor (Heading block → H3), and style it with CSS if it must look smaller.',
  ],
  'target-size': ['Make tap targets at least 24×24 CSS pixels, or space small targets apart (WCAG 2.5.8).'],
  'frame-title': ['Give each `<iframe>` a `title` describing its content (e.g. “Map of meeting point”).'],
  'aria-hidden-focus': ['Elements with `aria-hidden="true"` must not contain focusable items. Remove `aria-hidden`, or add `tabindex="-1"` to the hidden links/buttons.'],
  'landmark-one-main': ['Wrap the main content in a `<main>` element (most themes provide it; check page-builder templates).'],
  'document-title': ['Give every page a unique, descriptive `<title>` (Yoast / Rank Math → SEO title).'],
  'html-has-lang': ['Add a `lang` attribute to `<html>` (WordPress: Settings → General → Site Language).'],
  'meta-viewport': ['Do not disable zooming: remove `user-scalable=no` and `maximum-scale` below 5 from the viewport meta tag.'],
  'link-in-text-block': ['Links inside paragraphs must be distinguishable without colour — underline them.'],
  'identical-links-same-purpose': ['Links with the same text should go to the same place (or have text that explains the difference).'],
  list: ['`<ul>`/`<ol>` may only contain `<li>` (and script/template) elements directly.'],
  listitem: ['`<li>` elements must be inside a `<ul>` or `<ol>`.'],
  tabindex: ['Do not use positive `tabindex` values; use 0 or -1 and follow DOM order.'],
  'duplicate-id-aria': ['IDs referenced by ARIA attributes must be unique on the page.'],
  bypass: ['Add a “Skip to content” link or proper landmarks so keyboard users can skip repeated navigation.'],

  // ---------------------------------------------------------------- best practices
  'csp-xss': [
    'There is no effective Content Security Policy against cross-site scripting.',
    'Start with a report-only policy (`Content-Security-Policy-Report-Only`) to see what the site loads, then enforce a policy using nonces or hashes with `strict-dynamic`.',
    'On WordPress, set headers in the server config, Cloudflare (Transform Rules → Response headers) or a headers plugin.',
  ],
  'has-hsts': [
    'Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` once the whole site works over HTTPS.',
    'Cloudflare: SSL/TLS → Edge Certificates → HTTP Strict Transport Security.',
  ],
  'origin-isolation': ['Send `Cross-Origin-Opener-Policy: same-origin` (or `same-origin-allow-popups` if you use payment / login pop-ups).'],
  'clickjacking-mitigation': ['Send `X-Frame-Options: SAMEORIGIN` or CSP `frame-ancestors \'self\'` so other sites cannot frame yours.'],
  'trusted-types-xss': ['Advanced: enable Trusted Types via CSP (`require-trusted-types-for \'script\'`) after testing in report-only mode.'],
  'is-on-https': ['Serve every page and resource over HTTPS; fix any http:// URLs in content (Better Search Replace).'],
  'redirects-http': ['Redirect all http:// requests to https:// (Cloudflare: “Always Use HTTPS”).'],
  'errors-in-console': ['Open the browser console on this page, fix first-party errors, and update or remove plugins causing them.'],
  deprecations: ['Update the scripts/plugins using deprecated browser APIs listed below.'],
  'inspector-issues': ['Fix the issues listed (cookies, mixed content, CSP) — they are reported by Chrome DevTools’ Issues panel.'],
  'third-party-cookies': ['Third-party cookies are being phased out; check the listed services still work without them.'],
  'image-aspect-ratio': ['Display images at their natural aspect ratio (fix CSS width/height that stretches them).'],
  'image-size-responsive': ['Serve images with enough resolution for high-density screens (use `srcset`).'],
  'paste-preventing-inputs': ['Allow pasting into password and other fields.'],
  doctype: ['Start the page with `<!DOCTYPE html>`.'],
  charset: ['Declare `<meta charset="utf-8">` early in the head.'],
  'valid-source-maps': ['Publish source maps for large first-party scripts (optional, helps debugging).'],

  // ---------------------------------------------------------------- SEO
  'link-text': [
    'Links use generic text such as “Read more” or “Click here”.',
    'Change the text to describe the destination (e.g. “Read more about the Galway walking tour”), or add an `aria-label` that does.',
  ],
  'crawlable-anchors': [
    'Some links cannot be followed by search engines — usually `href="javascript:void(0)"` or links without `href`.',
    'Use real URLs in `href`; for buttons that do not navigate, use a `<button>` element instead of a link.',
  ],
  'is-crawlable': ['The page blocks indexing (robots meta tag, X-Robots-Tag or robots.txt). If it should appear in search, remove `noindex` (Yoast/Rank Math → Advanced → Allow search engines).'],
  'meta-description': ['Write a unique meta description (about 150 characters) for this page in Yoast / Rank Math.'],
  'http-status-code': ['The page returned an error status; fix the page or redirect it.'],
  'robots-txt': ['Fix the syntax errors listed in robots.txt.'],
  canonical: ['Point `rel=canonical` to the preferred URL of this page (SEO plugins set it automatically).'],
  hreflang: ['Fix invalid hreflang codes (use ISO language/region codes like `en-IE`).'],
  'structured-data': ['Validate structured data with Google’s Rich Results Test and fix the reported errors.'],

  // ---------------------------------------------------------------- agentic browsing
  'agent-accessibility-tree': ['AI agents read the accessibility tree. Fix the accessibility items above (names, labels, roles) — the same fixes help agents and people.'],
  'llms-txt': ['Optionally publish `/llms.txt` summarising the site for AI agents (an emerging convention, not a standard).'],
};

export const GENERIC_FIX = [
  'Read what Lighthouse found below and open “Learn more” for background.',
  'Fix each item listed in the table, starting with the largest estimated savings.',
  'Re-run the scan to confirm the audit now passes.',
];
