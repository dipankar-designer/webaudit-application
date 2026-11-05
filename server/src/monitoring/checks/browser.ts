// Real-browser render: a page can return 200 and still be blank, stuck, or broken by
// failed scripts and styles. Loads the page in Chrome (through the SSRF egress proxy).

import type { Priority } from '@wpcg/shared';
import { newContext } from '../../scanner/browser.js';
import { isFirstParty, scrub } from '../../scanner/checks/pageRuntime.js';
import type { CheckRunner } from '../types.js';

export const browserCheck: CheckRunner = async ({ monitor, signal }) => {
  const url = monitor.url!;
  const siteHosts = [new URL(url).hostname];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failed: { url: string; type: string; status: number | null; firstParty: boolean }[] = [];
  let ctx;
  try {
    ctx = await newContext({ name: 'desktop', width: 1366, height: 900, mobile: false });
  } catch (e) {
    return { status: 'error', summary: `Monitoring error: the browser could not start (${(e as Error).message.split('\n')[0]})` };
  }
  const abort = () => void ctx.close().catch(() => {});
  signal.addEventListener('abort', abort, { once: true });
  const started = Date.now();
  try {
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && consoleErrors.length < 30 && consoleErrors.push(scrub(m.text())));
    page.on('pageerror', (e) => pageErrors.length < 30 && pageErrors.push(scrub(e.message)));
    page.on('requestfailed', (r) => failed.length < 50 && failed.push({ url: scrub(r.url().replace(/[?#].*$/, '')), type: r.resourceType(), status: null, firstParty: isFirstParty(r.url(), siteHosts) }));
    page.on('response', (r) => {
      if (r.status() < 400 || r.request().isNavigationRequest()) return;
      if (failed.length < 50) failed.push({ url: scrub(r.url().replace(/[?#].*$/, '')), type: r.request().resourceType(), status: r.status(), firstParty: isFirstParty(r.url(), siteHosts) });
    });
    const res = await page.goto(url, { waitUntil: 'load', timeout: 45000 }).catch((e: Error) => {
      if (/Timeout/i.test(e.message)) return null;
      throw e;
    });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const loadMs = Date.now() - started;
    const st = res?.status() ?? null;
    if (st === 401 || st === 403 || st === 429) return { status: 'not_assessed', summary: `Not assessed: the browser was refused (HTTP ${st})`, httpStatus: st, responseMs: loadMs };
    const view = (await page.evaluate(`(() => ({
      textLength: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim().length,
      media: document.querySelectorAll('img, svg, video, canvas, iframe').length,
      title: document.title,
      challenge: /Just a moment|Attention Required|cf-chl/i.test(document.title + (document.body ? document.body.className : '')),
    }))()`)) as { textLength: number; media: number; title: string; challenge: boolean };
    if (view.challenge) return { status: 'not_assessed', summary: 'Not assessed: the browser was shown a bot challenge', httpStatus: st, responseMs: loadMs };

    const findings: { severity: Priority; text: string }[] = [];
    if (view.textLength < 30 && view.media === 0) findings.push({ severity: 'p2', text: 'The page rendered blank (no visible text or media)' });
    const fpCritical = failed.filter((f) => f.firstParty && ['stylesheet', 'script', 'font'].includes(f.type));
    const fpOther = failed.filter((f) => f.firstParty && !['stylesheet', 'script', 'font'].includes(f.type));
    const thirdParty = failed.filter((f) => !f.firstParty);
    if (fpCritical.length) findings.push({ severity: 'p2', text: `${fpCritical.length} of your own CSS/JS/font file(s) failed to load` });
    if (pageErrors.length) findings.push({ severity: 'p3', text: `${pageErrors.length} uncaught JavaScript error(s)` });
    if (fpOther.length) findings.push({ severity: 'p3', text: `${fpOther.length} of your own image/media/data request(s) failed` });
    if (consoleErrors.length) findings.push({ severity: 'p4', text: `${consoleErrors.length} console error(s)` });
    if (thirdParty.length) findings.push({ severity: 'p4', text: `${thirdParty.length} third-party request(s) failed` });
    const detail = { loadMs, title: view.title, textLength: view.textLength, failed: failed.slice(0, 30), pageErrors: pageErrors.slice(0, 10), consoleErrors: consoleErrors.slice(0, 10) };
    if (!findings.length) return { status: 'up', summary: `Rendered in ${(loadMs / 1000).toFixed(1)} s with no script errors or failed assets`, detail, httpStatus: st, responseMs: loadMs };
    const severity = (['p1', 'p2', 'p3', 'p4'] as Priority[]).find((s) => findings.some((f) => f.severity === s))!;
    const blank = findings[0].text.startsWith('The page rendered blank');
    return { status: blank ? 'down' : 'warning', severity, summary: findings.map((f) => f.text).join('; '), detail, httpStatus: st, responseMs: loadMs };
  } catch (e) {
    return { status: 'error', summary: `Monitoring error: the browser render did not complete (${(e as Error).message.split('\n')[0].slice(0, 200)})` };
  } finally {
    signal.removeEventListener('abort', abort);
    await ctx.close().catch(() => {});
  }
};
