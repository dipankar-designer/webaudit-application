// Developer probe: runs the Lighthouse runner once and writes the compact report to a file.
//   npx tsx src/scripts/lhProbe.ts <url> <mobile|desktop> <out.json>

import fs from 'node:fs';
import { runLighthouse } from '../scanner/checks/performance.js';
import { closeBrowser } from '../scanner/browser.js';

const [url, vp, out] = process.argv.slice(2);
const viewport = vp === 'desktop' ? { name: 'desktop' as const, width: 1366, height: 900, mobile: false } : { name: 'mobile' as const, width: 390, height: 844, mobile: true };
const r = await runLighthouse(url, viewport);
if (r.error || !r.report) {
  console.error(r.error ?? 'no report');
  process.exit(1);
}
fs.writeFileSync(out, JSON.stringify(r.report));
console.log(`Wrote ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
await closeBrowser();
process.exit(0);
