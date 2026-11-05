import { discoverPages, extractLinksFromHtml, normalisePageUrl } from '../../src/scanner/discovery.js';
import { checkLinks } from '../../src/scanner/checks/links.js';

const start = Date.now();
let last = Date.now();
const tick = setInterval(() => {
  const now = Date.now();
  if (now - last > 3000) console.log(`!! event loop blocked for ${now - last} ms`);
  last = now;
}, 1000);

const d = await discoverPages('https://yellowumbrellatours.ie/', { maxPages: 10, maxDepth: 3 });
console.log(`discovered ${d.pages.length} pages in ${Date.now() - start} ms`);
const targets = new Map<string, { pageUrl: string; text: string }[]>();
for (const p of d.pages) {
  if (!p.response?.body) continue;
  for (const href of extractLinksFromHtml(p.response.body.toString('utf8'), p.response.finalUrl)) {
    const n = normalisePageUrl(href)!;
    targets.set(n, [...(targets.get(n) ?? []), { pageUrl: p.url, text: '' }]);
  }
}
console.log(`${targets.size} targets`);
const known = new Map(d.pages.filter((p) => p.response).map((p) => [p.url, p.response!]));
const t0 = Date.now();
const out = await checkLinks({
  targets,
  known,
  siteHosts: d.scopeHosts,
  pages: d.pages.map((p) => p.url),
  checkExternal: false,
  onProgress: (n, total) => console.log(`  ${n}/${total} at ${Date.now() - t0} ms`),
});
console.log(`links done in ${Date.now() - t0} ms: checked ${out.checked}, findings ${out.findings.length}`);
clearInterval(tick);
process.exit(0);
