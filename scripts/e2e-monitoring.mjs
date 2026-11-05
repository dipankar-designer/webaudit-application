// Monitoring UI end to end in a real browser, against the running dev stack (API + worker + web):
// sign up, add a monitor through the form, wait for the real scheduler to record checks, read the
// detail page (status, chart, uptime bars, watchers, history), add an alert contact, open
// Incidents and Billing, then check every page with axe-core (WCAG 2.2 A/AA), keyboard focus
// visibility and horizontal overflow at 390px.
//
//   node scripts/e2e-monitoring.mjs [appUrl] [targetUrl] [screenshotDir]
//
// Target: the fixture site (`npx tsx server/test/fixtureSite.ts 4599`, allowed by
// SCAN_ALLOW_PRIVATE_TARGETS=127.0.0.1:4599 in .env).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const APP = process.argv[2] || 'http://localhost:5174';
const TARGET = process.argv[3] || 'http://127.0.0.1:4599/';
const SHOTS = process.argv[4] || '';
const INBOX = process.env.DEV_MAIL_API || 'http://127.0.0.1:8025/api/messages';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : detail ? ` (${detail})` : ''}`);
};
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
// Expected API refusals (signed-out session probe, rate-limited "Check now") are not script errors.
page.on('console', (m) => m.type() === 'error' && !/\/api\/auth\/me$|\/api\/monitors\/[^/]+\/run$/.test(m.location().url) && consoleErrors.push(`${m.text()} ${m.location().url}`));
page.on('pageerror', (e) => consoleErrors.push(e.message));
const shot = async (name, p = page) => SHOTS && p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, timeout: 120_000 }).catch(() => {});

async function axeCheck(label, p = page) {
  await p.evaluate(AXE);
  const r = await p.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } }));
  const v = r.violations.map((x) => `${x.id}(${x.nodes.length}): ${x.nodes[0]?.target.join(' ')} ${x.nodes[0]?.failureSummary?.split('\n')[1] ?? ''}`);
  check(`axe WCAG 2.2 A/AA: ${label}`, v.length === 0, v.join(' | '));
}

/** Tabs through the page and confirms every focused control shows a visible focus indicator. */
async function focusCheck(label, stops = 25) {
  const missing = [];
  await page.evaluate(() => document.activeElement?.blur());
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const visible = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1) || s.boxShadow !== 'none';
      return { visible, name: `${el.tagName.toLowerCase()} ${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}` };
    });
    if (r && !r.visible) missing.push(r.name);
  }
  check(`keyboard: visible focus on every stop (${label})`, missing.length === 0, missing.join(', '));
}

try {
  const email = `mon-${Date.now()}@example.com`;
  await page.goto(`${APP}/signup`);
  await page.getByLabel('Your name').fill('Morgan Monitor');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('a-long-test-password');
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /create account/i }).click();
  await page.waitForURL(/\/(dashboard|scans\/new)/);
  check('sign-up signs the user in', true);
  await page.goto(`${APP}/dashboard`);
  await page.getByRole('heading', { name: 'Monitoring' }).waitFor();
  await page.getByRole('heading', { name: 'No monitors yet' }).waitFor();
  check('dashboard shows the monitoring section first', true);
  await shot('m00-dashboard-empty');
  await axeCheck('dashboard (empty)');

  // ---------------------------------------------------------------- add monitor
  await page.getByRole('link', { name: 'Monitors', exact: true }).click();
  await page.getByRole('link', { name: 'Add monitor' }).first().click();
  await page.getByLabel('Name').fill('Fixture site');
  await page.getByLabel('Address').fill(TARGET);
  check('premium watchers are locked on the Free plan', await page.getByRole('checkbox', { name: /Security headers/ }).isDisabled());
  check('faster intervals are marked as paid', (await page.locator('#m-int option[disabled]').count()) > 0);
  await axeCheck('add monitor form');
  await focusCheck('add monitor form', 30);
  const submit = page.getByRole('button', { name: 'Start monitoring' });
  check('submit is disabled until authorisation is confirmed', await submit.isDisabled());
  await page.getByRole('checkbox', { name: /I own this website/ }).check();
  await shot('m01-add-monitor');
  await submit.click();
  await page.waitForURL(/\/monitors\/[0-9a-f-]{36}$/);
  check('monitor created and detail page opened', true);

  // The real worker runs the staggered first checks within a few seconds.
  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    await page.waitForTimeout(3000);
    await page.reload();
    await page.getByRole('heading', { level: 1 }).waitFor();
    up = await page.getByRole('heading', { level: 1 }).getByText('Up', { exact: true }).isVisible().catch(() => false);
  }
  check('the scheduler ran the checks and the monitor shows Up', up);
  await page.getByRole('heading', { name: 'Response time', exact: true }).waitFor();
  check('response-time chart rendered', (await page.locator('svg path[stroke="var(--color-sky-500)"]').count()) > 0);
  check('uptime bars rendered', (await page.getByRole('group', { name: /Daily uptime/ }).count()) === 1);
  // Keyboard reading of the chart.
  await page.getByRole('group', { name: /Response time, 24h/ }).focus();
  await page.keyboard.press('End');
  check('chart is readable by keyboard (tooltip on End key)', await page.getByText(/^Response \d/).first().isVisible());
  const watcherSummaries = await page.locator('h3', { hasText: /SSL\/TLS|Uptime|HTTPS/ }).count();
  check('three free watchers listed', watcherSummaries === 3, String(watcherSummaries));
  check('check history table has rows', (await page.locator('table tbody tr').count()) > 0);
  await shot('m02-monitor-detail');
  await axeCheck('monitor detail');
  await focusCheck('monitor detail', 20);

  // Check now (rate limited to once a minute on the server).
  await page.getByRole('button', { name: 'Check now' }).click();
  await page.getByText(/Checks scheduled|checked in the last minute/).waitFor();
  check('"Check now" responds', true);

  // Settings modal.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Fixture site (renamed)');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Settings saved.').waitFor();
  // The page re-fetches the monitor after saving; wait for the heading to show the new name.
  const renamed = await page.getByRole('heading', { level: 1 }).getByText('Fixture site (renamed)').waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('settings saved through the modal', renamed);

  // ---------------------------------------------------------------- list, incidents, alerts, billing
  await page.goto(`${APP}/monitors`);
  await page.getByRole('link', { name: /Fixture site \(renamed\)/ }).waitFor();
  check('monitors list shows the monitor with uptime', /100(\.00)?%|—/.test(await page.locator('ul li').first().innerText()));
  await shot('m03-monitors');
  await axeCheck('monitors list');

  await page.goto(`${APP}/incidents`);
  await page.getByRole('heading', { name: 'Incidents', level: 1 }).waitFor();
  await page.getByRole('heading', { name: 'No open incidents' }).waitFor();
  check('incidents page shows no open incidents for a healthy site', true);
  await axeCheck('incidents');

  await page.goto(`${APP}/alerts`);
  await page.getByLabel('Add an e-mail address').fill('ops@example.com');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await page.getByText('ops@example.com will receive alerts.').waitFor();
  await page.getByRole('button', { name: 'Send test' }).click();
  await page.getByText(/Test e-mail sent|Not sent: e-mail delivery is not configured|Delivery failed/).waitFor();
  const outcome = await page.getByText(/Test e-mail sent|Not sent: e-mail delivery is not configured|Delivery failed/).innerText();
  check('test alert reports its real delivery outcome', true, outcome);
  // With the local test inbox running (npm run dev), the message must really arrive there.
  const inbox = await fetch(INBOX).then((r) => r.json()).catch(() => null);
  if (inbox) {
    check('test e-mail was delivered to the local test inbox', /Test e-mail sent/.test(outcome) && inbox.some((m) => m.to.includes('ops@example.com') && /test/i.test(m.subject)), outcome);
    check('the Alerts page labels the test inbox as not real delivery', await page.getByText('Alerts go to the local test inbox').isVisible());
  }
  await shot('m04-alerts');
  await axeCheck('alerts');

  // Back: returns to the previous page in this tab.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/alerts'));
  check('"Back" leaves the page', true, new URL(page.url()).pathname);

  await page.goto(`${APP}/billing`);
  await page.getByRole('heading', { name: 'Plans' }).waitFor();
  check('billing shows monitor usage', await page.getByRole('meter', { name: 'Monitors' }).isVisible());
  await shot('m05-billing');
  await axeCheck('billing');

  await page.goto(`${APP}/dashboard`);
  await page.getByRole('heading', { name: 'Monitoring' }).waitFor();
  await page.getByText('Uptime (30 days)').waitFor();
  check('dashboard shows monitoring stats', true);
  await shot('m06-dashboard');
  await axeCheck('dashboard');

  // ---------------------------------------------------------------- 390px
  const monitorUrl = await page.evaluate(async () => (await (await fetch('/api/monitors')).json())[0].id);
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const mp = await m.newPage();
  for (const route of ['/dashboard', '/monitors', '/monitors/new', `/monitors/${monitorUrl}`, '/incidents', '/alerts', '/billing', '/scans/new', '/issues']) {
    await mp.goto(APP + route);
    await mp.getByRole('heading', { level: 1 }).waitFor();
    await mp.waitForTimeout(400);
    const { sw, cw } = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    check(`390px: no horizontal scroll on ${route.replace(/[0-9a-f-]{36}/, ':id')}`, sw <= cw, sw > cw ? `${sw} > ${cw}` : '');
  }
  await mp.goto(`${APP}/monitors/${monitorUrl}`);
  await mp.getByRole('heading', { name: 'Response time', exact: true }).waitFor();
  await shot('m07-detail-390', mp);
  await axeCheck('monitor detail at 390px', mp);
  await m.close();

  check('no JavaScript errors in the browser console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('journey completed without an exception', false, e.message.split('\n')[0]);
  await shot('m99-failure');
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
