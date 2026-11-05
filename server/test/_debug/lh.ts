import { runLighthouse } from '../../src/scanner/checks/performance.js';
import { closeBrowser } from '../../src/scanner/browser.js';

let last = Date.now();
const tick = setInterval(() => {
  const now = Date.now();
  if (now - last > 3000) console.log(`!! event loop blocked for ${now - last} ms`);
  last = now;
}, 1000);
for (const vp of [{ name: 'desktop', width: 1366, height: 900, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }] as const) {
  const t0 = Date.now();
  const r = await runLighthouse('https://yellowumbrellatours.ie/', vp);
  console.log(`${vp.name}: ${Date.now() - t0} ms, error=${r.error}, score=${r.metrics?.performanceScore}, lcp=${Math.round(r.metrics?.lcpMs ?? 0)}`);
}
clearInterval(tick);
await closeBrowser();
process.exit(0);
