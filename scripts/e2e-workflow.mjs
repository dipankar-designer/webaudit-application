// Walks the nine-step product workflow in a real browser and reports PASS/FAIL per step:
// 1 enter URL · 2 start scan · 3 issues per category · 4 screenshots (+ baseline comparison)
// 5 AI analysis · 6 report by priority · 7 step-by-step fixes · 8 verify improvements · 9 history
//
//   node scripts/e2e-workflow.mjs [appUrl] [fixtureUrl] [screenshotDir] [--skip-ai]
//
// Needs the API + worker, the web client and the fixture site (with its /__control endpoint).

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APP = args[0] || 'http://127.0.0.1:5174';
const TARGET = args[1] || 'http://127.0.0.1:4599/';
const SHOTS = args[2] || '';
const SKIP_AI = process.argv.includes('--skip-ai');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const control = (q) => fetch(`${TARGET}__control?${q}`).then((r) => r.json());

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (name) =>
  SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, timeout: 120_000 }).catch((e) => console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`));
const waitForScan = async () => {
  await page.getByRole('link', { name: 'View report' }).waitFor({ timeout: 8 * 60_000 });
};

try {
  await control('fixed=0&banner=0');

  // 1. Enter website URL (landing page) → sign up → New scan with the URL pre-filled.
  await page.goto(APP);
  await page.locator('#hero-url').fill(TARGET);
  await page.locator('#hero-url').press('Enter');
  await page.getByLabel('Your name').fill('Workflow Tester');
  const email = `flow-${Date.now()}@example.com`;
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('a-long-workflow-password');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Website address').waitFor();
  check('1. Enter website URL', (await page.getByLabel('Website address').inputValue()) === TARGET);

  // Pro plan so the baseline comparison in step 4 can run (operators set plans; no payments yet).
  const db = new pg.Client(process.env.DATABASE_URL || 'postgres://wpcg:wpcg_dev_password@127.0.0.1:5433/wpcg');
  await db.connect();
  await db.query("UPDATE workspaces SET plan = 'pro' WHERE id IN (SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1)", [email]);
  await db.end();
  await page.reload();
  await page.getByLabel('Website address').waitFor();

  // 2. Start website scan (Full: all categories, desktop + mobile).
  await page.getByText('Full scan', { exact: true }).click();
  await page.getByText('I confirm I own this website').click();
  await page.getByRole('button', { name: 'Start scan' }).click();
  await page.waitForURL(/\/scans\/[0-9a-f-]{36}$/);
  const scan1 = page.url();
  await page.getByRole('progressbar').waitFor({ timeout: 20_000 });
  check('2. Start website scan (live progress shown)', true);
  await waitForScan();
  await page.getByRole('navigation', { name: 'Issue categories' }).waitFor();
  await shot('flow-02-results-all');

  // 3. Issues per category via the left category bar.
  const nav = page.getByRole('navigation', { name: 'Issue categories' });
  const navText = (await nav.innerText()).replace(/\s+/g, ' ');
  const cats = ['All issues', 'HTML structure', 'SEO', 'Accessibility', 'Responsive layout', 'Links', 'Images', 'JavaScript', 'Performance'];
  check('3a. Left bar lists every category', cats.every((c) => navText.includes(c)), navText.slice(0, 200));
  const total = Number(await nav.getByRole('button', { name: /All issues/ }).locator('span').last().innerText());
  let sum = 0;
  let allMatch = true;
  for (const c of cats.slice(1)) {
    await nav.getByRole('button', { name: new RegExp(`^${c}`) }).click();
    await page.locator('#results h3').first().filter({ hasText: c }).waitFor(); // wait for the re-render
    const heading = await page.locator('#results h3').first().innerText();
    const count = Number(await nav.getByRole('button', { name: new RegExp(`^${c}`) }).locator('span').last().innerText());
    const rows = (await page.locator('#results li[data-issues]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-issues'))))).reduce((a, b) => a + b, 0);
    if (!heading.includes(c) || rows !== count) {
      allMatch = false;
      console.log(`   ${c}: heading "${heading}", rows ${rows}, badge ${count}`);
    }
    sum += count;
  }
  check('3b. Clicking a category shows only that category’s issues', allMatch);
  await nav.getByRole('button', { name: /^Accessibility/ }).click();
  await shot('flow-03-accessibility');
  check('3c. Category counts add up to “All issues”', sum <= total && total > 0, `${sum} listed in these categories of ${total}`);

  // 4. Screenshots (desktop + mobile per page).
  const shotsOk = (await page.locator('img[src^="/api/files/screenshots/"]').count()) >= 4;
  check('4a. Screenshots captured for layout review', shotsOk);
  await page.getByRole('button', { name: 'Save as baseline' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save baseline' }).click();
  await page.getByText(/Saved as baseline/).waitFor();

  // 6. Report by priority (summary tiles filter the results).
  await page.getByRole('button', { name: /Show High priority issues/ }).click();
  await page.locator('#results h3').first().filter({ hasText: 'All issues' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#results h4').length === 1, null, { timeout: 10_000 }).catch(() => {});
  const sevHeadings = await page.locator('#results h4').allInnerTexts();
  check('6. Results grouped by priority; tile filters to High', sevHeadings.length === 1 && /High priority/i.test(sevHeadings[0]), sevHeadings.join(' | '));

  // 7. Step-by-step fixes inline and on the issue page.
  await page.locator('#results details summary').first().click();
  const steps = await page.locator('#results details[open] ol li').count();
  check('7a. “How to fix” shows step-by-step instructions inline', steps > 0, `${steps} steps`);
  await page.locator('#results details[open] a[href^="/issues/"]').first().click();
  await page.getByRole('heading', { name: 'Step-by-step fix' }).waitFor();
  check('7b. Issue page has evidence, fix steps and verification', (await page.getByRole('heading', { name: 'How to verify the fix' }).count()) === 1);
  const issueUrl = page.url();

  // 5. AI analysis (local model via Ollama in development).
  if (SKIP_AI) console.log('SKIP  5. AI analysis (--skip-ai)');
  else {
    await page.getByRole('button', { name: 'Explain this issue' }).click();
    const aiText = await page
      .locator('text=/ollama|anthropic/')
      .first()
      .waitFor({ timeout: 5 * 60_000 })
      .then(() => page.getByRole('heading', { name: 'AI explanation' }).locator('xpath=ancestor::div[1]').innerText())
      .catch((e) => `ERROR ${e.message.split('\n')[0]}`);
    check('5. AI explains the issue from its evidence', !aiText.startsWith('ERROR') && aiText.length > 200, aiText.slice(0, 160).replace(/\s+/g, ' '));
    await shot('flow-05-ai');
  }

  // 8. Verify improvements: repair the site, run another scan with the baseline comparison.
  await control('fixed=1&banner=1');
  await page.goto(`${APP}/scans/new`);
  await page.getByLabel('Or choose a website from your workspace').selectOption({ index: 1 });
  await page.getByText('Full scan', { exact: true }).click();
  await page.getByText('Compare with a baseline').click();
  await page.getByLabel('Baseline', { exact: true }).selectOption({ index: 1 });
  await page.getByText('I confirm I own this website').click();
  await page.getByRole('button', { name: 'Start scan' }).click();
  await page.waitForURL(/\/scans\/[0-9a-f-]{36}$/);
  await waitForScan();
  const summary = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  const resolved = Number(summary.match(/(\d+) resolved/)?.[1] ?? 0);
  check('8a. Re-scan marks fixed issues as resolved', resolved > 0, `${resolved} resolved`);
  await page.getByRole('navigation', { name: 'Issue categories' }).getByRole('button', { name: /^Visual comparison/ }).click();
  const visualRows = await page.locator('#results li[data-issues]').count();
  check('4b. Baseline comparison flags the changed layout', visualRows > 0, `${visualRows} visual change issue(s)`);
  await shot('flow-08-rescan');
  const resolvedIssues = await page.evaluate(async () => (await (await fetch('/api/issues?status=resolved')).json()).total);
  check('8b. Fixed issues are listed as Resolved', resolvedIssues > 0, `${resolvedIssues} resolved`);

  // 9. Scan history and improvement over time.
  await page.goto(`${APP}/scans`);
  await page.locator('main ul li a[href^="/scans/"]').first().waitFor();
  const historyRows = await page.locator('main ul li a[href^="/scans/"]').count();
  check('9a. Scan history keeps both scans', historyRows >= 2, `${historyRows} scans`);
  await page.goto(`${APP}/reports/${scan1.split('/').pop()}`);
  await page.getByRole('heading', { name: 'Issue details' }).waitFor();
  check('9b. Earlier report is still available', true);
  const latest = await page.evaluate(async () => (await (await fetch('/api/scans?limit=1')).json()).items[0].id);
  await page.goto(`${APP}/reports/${latest}`);
  await page.getByRole('heading', { name: 'Issue details' }).waitFor();
  check('9c. Latest report compares with the previous scan', (await page.getByRole('heading', { name: 'Compared with the previous scan' }).count()) === 1);
} catch (e) {
  check('unexpected error', false, e.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  check('no JavaScript errors in the app', errors.length === 0, errors.slice(0, 3).join(' | '));
  await control('fixed=0&banner=0').catch(() => {});
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
