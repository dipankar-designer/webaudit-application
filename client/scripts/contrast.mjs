// Checks the dark theme's text/background pairs against WCAG 2.2 AA.
// Text needs 4.5:1 (3:1 for large text); icons, focus rings and field borders need 3:1.
// Usage: node client/scripts/contrast.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/styles.css'), 'utf8');
const vars = Object.fromEntries([...css.matchAll(/--color-([a-z]+(?:-[a-z0-9]+)*):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
vars.white = '#ffffff';

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const BGS = ['slate-50', 'surface', 'slate-100'];
const pairs = [];
// Body text tints on every neutral background.
for (const fg of ['slate-500', 'slate-600', 'slate-700', 'slate-800', 'slate-900', 'brand-600', 'brand-700', 'brand-800']) for (const bg of BGS) pairs.push([fg, bg, 4.5]);
// Status badges: tinted text on their own tinted fill, and status text on cards.
for (const hue of ['red', 'orange', 'amber', 'emerald', 'sky', 'violet', 'rose', 'brand', 'indigo']) {
  for (const step of ['700', '800']) {
    if (!vars[`${hue}-${step}`]) continue;
    if (vars[`${hue}-50`]) pairs.push([`${hue}-${step}`, `${hue}-50`, 4.5]);
    pairs.push([`${hue}-${step}`, 'surface', 4.5]);
  }
}
pairs.push(['amber-900', 'amber-50', 4.5], ['amber-950', 'amber-50', 4.5], ['sky-900', 'sky-50', 4.5], ['red-900', 'red-50', 4.5], ['emerald-900', 'emerald-50', 4.5], ['violet-950', 'violet-50', 4.5]);
// Filled controls.
pairs.push(['on-brand', 'brand-600', 4.5], ['on-brand', 'brand-400', 4.5], ['white', 'red-600', 4.5], ['white', 'rose-600', 4.5], ['slate-50', 'slate-900', 4.5], ['white', 'ink', 4.5], ['brand-800', 'ink', 4.5], ['slate-800', 'ink', 4.5]);
// Non-text: icons, focus ring, field borders, chart marks.
for (const fg of ['slate-400', 'brand-600', 'emerald-600', 'red-600', 'red-500', 'amber-600', 'sky-600', 'orange-500', 'sky-500', 'amber-400', 'violet-500']) pairs.push([fg, 'surface', 3]);
pairs.push(['slate-400', 'slate-50', 3], ['brand-600', 'slate-50', 3]);

let failed = 0;
for (const [fg, bg, min] of pairs) {
  const a = vars[fg];
  const b = vars[bg];
  if (!a || !b) {
    console.log(`?    ${fg} on ${bg}: missing token`);
    failed++;
    continue;
  }
  const r = ratio(a, b);
  const ok = r >= min;
  if (!ok) failed++;
  if (!ok || process.argv.includes('--all')) console.log(`${ok ? 'ok  ' : 'FAIL'} ${fg.padEnd(12)} on ${bg.padEnd(10)} ${r.toFixed(2)}:1 (needs ${min}:1)`);
}
console.log(`${pairs.length - failed}/${pairs.length} pairs pass WCAG 2.2 AA`);
process.exit(failed ? 1 : 0);
