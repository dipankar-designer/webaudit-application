// Operator tool: prints the WordPress and plugin information for a site without running a full scan.
//   npx tsx src/scripts/wpInspect.ts https://example.com [more page URLs…]
// Uses the same SSRF-guarded fetches and public data sources as a scan.

import { safeFetch } from '../security/safeFetch.js';
import { inspectWordPress } from '../scanner/wordpress/inspect.js';

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('Usage: tsx src/scripts/wpInspect.ts <url> [page url …]');
  process.exit(1);
}
const pages: { url: string; html: string; headers: Record<string, string> }[] = [];
for (const u of urls) {
  const r = await safeFetch(u);
  if (r.failure) console.error(`${u}: ${r.failure.message}`);
  else pages.push({ url: r.finalUrl, html: r.body?.toString('utf8') ?? '', headers: r.headers });
}
const report = await inspectWordPress(pages, new URL(urls[0]).origin);
console.log(JSON.stringify(report, null, 2));
