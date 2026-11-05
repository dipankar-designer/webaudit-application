// UI end-to-end check in a real browser: sign up, run a scan from the New Scan form, wait for
// results, open the report and an issue, check every main route at 390px for horizontal
// overflow, and run axe-core on the app's own pages.
//
//   node scripts/e2e-ui.mjs [appUrl] [targetUrl] [screenshotDir]
//
// Needs the API (with a worker), the web client and a scan target running, e.g. the fixture
// site: `npx tsx server/test/fixtureSite.ts 4599` with SCAN_ALLOW_PRIVATE_TARGETS=127.0.0.1:4599.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const APP = process.argv[2] || 'http://127.0.0.1:5174';
const TARGET = process.argv[3] || 'http://127.0.0.1:4599/';
const SHOTS = process.argv[4] || '';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: Number(process.env.E2E_WIDTH) || 1366, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));
// Screenshots are for human review only; a slow capture must not fail the run.
const shot = async (name, p = page) =>
  SHOTS &&
  p
    .screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, timeout: 120_000 })
    .catch((e) => console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`));

async function axeCheck(label, p = page) {
  await p.evaluate(AXE);
  const r = await p.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } }));
  const v = r.violations.map((x) => `${x.id}(${x.nodes.length}): ${x.nodes[0]?.target.join(' ')}`);
  check(`axe-core WCAG A/AA on ${label}`, v.length === 0, v.join(' | '));
}

try {
  // ---------------------------------------------------------------- sign up
  await page.goto(APP);
  await page.getByRole('heading', { level: 1 }).waitFor();
  check('first visit shows the public landing page', /Know what is broken/.test((await page.getByRole('heading', { level: 1 }).textContent()) ?? ''));
  check('landing offers sign-in only as a secondary link', await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).isVisible());
  await shot('00-landing');
  await axeCheck('landing page');
  await page.goto(`${APP}/login`);
  await axeCheck('sign-in page');
  await page.goto(APP);
  await page.locator('#hero-url').fill(TARGET);
  await page.locator('#hero-url').press('Enter');
  await page.waitForURL(/\/signup\?url=/);
  check('landing scan box leads to sign-up with the address', decodeURIComponent(page.url()).includes(TARGET));
  const email = `ui-${Date.now()}@example.com`;
  await page.getByLabel('Your name').fill('Una Tester');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('a-long-ui-password');
  await page.getByLabel('Company or agency name').fill('Tester Agency');
  await page.getByRole('button', { name: 'Create account' }).click();
  const terms = await page.getByRole('alert').textContent({ timeout: 5000 }).catch(() => '');
  check('sign-up refuses without the acceptable-use confirmation', /acceptable-use/i.test(terms ?? ''), terms ?? '');
  consoleErrors.length = 0; // the 400 above was provoked on purpose
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/scans\/new/);
  await page.getByLabel('Website address').waitFor();
  check('sign-up lands on New scan', /\/scans\/new/.test(page.url()));
  check('the address from the landing page is pre-filled', (await page.getByLabel('Website address').inputValue()) === TARGET);

  // ---------------------------------------------------------------- new scan
  await page.getByLabel('Website address').fill('http://127.0.0.1:4100/');
  await page.getByRole('button', { name: 'Check address' }).click();
  const blocked = await page.locator('#preflight-result').textContent({ timeout: 10000 });
  check('preflight blocks a private address', /cannot be scanned/i.test(blocked ?? ''), blocked?.slice(0, 120));
  await page.getByLabel('Website address').fill(TARGET);
  await page.getByRole('button', { name: 'Check address' }).click();
  await page.locator('#preflight-result').getByText(/Reachable/).waitFor({ timeout: 15000 });
  check('preflight confirms the target', true);
  await page.getByText('Full scan', { exact: true }).click();
  const scope = await page.getByText('What this scan will do').locator('xpath=ancestor::section').textContent();
  check('scope summary shown before starting (full scans cover every page found)', /Scan every page found/.test(scope ?? '') && /What it will not do/.test(scope ?? ''));
  await shot('01-new-scan');
  await axeCheck('New scan form');
  const start = page.getByRole('button', { name: 'Start scan' });
  check('start is disabled until authorisation is confirmed', await start.isDisabled());
  await page.getByText('I confirm I own this website').click();
  await start.click();
  await page.waitForURL(/\/scans\/[0-9a-f-]{36}$/);
  const scanUrl = page.url();
  check('scan created and progress page opened', true, scanUrl);
  await page.getByRole('progressbar').waitFor({ timeout: 15000 }).then(() => check('live progress is shown', true)).catch(() => check('live progress is shown', false));
  await shot('02-scan-progress');
  await page.getByRole('link', { name: 'View report' }).waitFor({ timeout: 6 * 60_000 });
  check('scan completed in the UI', true);
  await shot('03-scan-results');

  await page.getByRole('navigation', { name: 'Issue categories' }).waitFor();
  const statText = await page.locator('main').textContent();
  check('results show the audit summary and category bar', /Audit summary/.test(statText ?? '') && /Audit results/.test(statText ?? ''));
  const issuesFound = Number(
    await page.getByRole('navigation', { name: 'Issue categories' }).getByRole('button', { name: /All issues/ }).locator('span').last().innerText(),
  );
  const api = await page.evaluate(async (u) => (await fetch(`/api/scans/${u.split('/').pop()}`)).json(), scanUrl);
  check('UI issue count matches stored scan summary', issuesFound === api.scan.summary.issuesDetected, `${issuesFound} vs ${api.scan.summary.issuesDetected}`);
  await axeCheck('scan results');

  // The issue list shows 10 rows per page and pages in place (no URL change, no reload).
  const issuesNav = page.getByRole('navigation', { name: 'Issues pages' });
  if (await issuesNav.count()) {
    const before = page.url();
    await issuesNav.getByRole('button', { name: 'Page 2' }).click();
    check('issue list pages in place (10 per page)', /Showing 11–/.test(await issuesNav.innerText()) && page.url() === before);
    await issuesNav.getByRole('button', { name: 'Page 1' }).click();
  }

  // PageSpeed-style Lighthouse report in the Performance category.
  await page.getByRole('navigation', { name: 'Issue categories' }).getByRole('button', { name: /Performance/ }).click();
  await page.getByRole('heading', { name: 'Diagnose performance issues' }).waitFor({ timeout: 30_000 });
  const fieldSection = page.getByRole('region', { name: 'Discover what your real users are experiencing' });
  await fieldSection.getByText(/not connected yet|Core Web Vitals Assessment|No Data|could not be loaded/).first().waitFor({ timeout: 30_000 });
  check(
    'real-user data section sits above “Diagnose performance issues” and states its real status',
    (await fieldSection.isVisible()) && (await fieldSection.evaluate((s) => !!(s.compareDocumentPosition(document.getElementById('lh-diagnose')) & Node.DOCUMENT_POSITION_FOLLOWING))),
  );
  // Without a Chrome UX Report key (as on this box) the PageSpeed layout shows this scan's own Lighthouse
  // values, labelled as lab data; INP (real visitors only) stays N/A, and no Core Web Vitals verdict is given.
  if (/not connected yet/.test(await fieldSection.innerText())) {
    await fieldSection.getByText(/^Measured /).waitFor({ timeout: 30_000 });
    const realField = await fieldSection.innerText();
    if (SHOTS) await fieldSection.screenshot({ path: `${SHOTS}/03g-field-not-connected.png` });
    const labImgs = await fieldSection.getByRole('img', { name: / lab value / }).count();
    check(
      'not connected: lab values with coloured scale bars and a Passed/Failed verdict tagged “Lab”',
      labImgs >= 3 && /lab measurements/.test(realField) && /Not real-user data/.test(realField) && /Core Web Vitals Assessment:\s*(Passed|Failed)\s*Lab/.test(realField),
      `${labImgs} lab values`,
    );
    check('not connected: INP stays N/A (a lab test cannot measure it)', (await fieldSection.getByRole('img', { name: /^INP: needs real visitors/ }).count()) === 1);
    check('lab verdict says which measurements decided it', /(Passed: |Failed because )Largest Contentful Paint is [\d.]+ m?s \(Good is ≤ 2\.5 s\)/.test(realField));

    // A slow site (as most mobile lab runs are): the TEST raises this report's LCP and CLS for one request.
    await page.route('**/lighthouse/report?**', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.audits['largest-contentful-paint'].numericValue = 7200;
      body.audits['cumulative-layout-shift'].numericValue = 0.217;
      await route.fulfill({ response: res, json: body });
    });
    await page.reload();
    await page.getByRole('navigation', { name: 'Issue categories' }).getByRole('button', { name: /Performance/ }).click();
    await fieldSection.getByText(/Failed because/).waitFor({ timeout: 30_000 });
    const failedText = await fieldSection.innerText();
    if (SHOTS) await fieldSection.screenshot({ path: `${SHOTS}/03h-lab-failed-reason.png` });
    check(
      'lab “Failed” names each failing measurement and its limit',
      /Failed because Largest Contentful Paint is 7\.2 s \(Good is ≤ 2\.5 s\) and Cumulative Layout Shift is 0\.22 \(Good is ≤ 0\.1\)\./.test(failedText) && /stricter than most real visits/.test(failedText),
      failedText.match(/Failed because[^\n]*/)?.[0],
    );
    await page.unroute('**/lighthouse/report?**');
    await page.reload();
    await page.getByRole('navigation', { name: 'Issue categories' }).getByRole('button', { name: /Performance/ }).click();
    await page.getByRole('heading', { name: 'Diagnose performance issues' }).waitFor({ timeout: 30_000 });
  }
  check('Performance shows the Lighthouse report with category gauges', (await page.getByRole('list', { name: 'Category scores' }).getByRole('link').count()) >= 4);
  check('lab metrics are listed', await page.getByText('Largest Contentful Paint').first().isVisible());
  check('the report is for the home page, like PageSpeed Insights', (await page.getByText(/^Lighthouse report for http/).innerText()).trim().endsWith(new URL(TARGET).origin + '/'));
  const diag = page.locator('details', { has: page.getByRole('heading', { name: 'Diagnose performance issues' }) });
  await diag.locator('summary').first().click();
  const collapsed = !(await diag.evaluate((d) => d.open));
  await diag.locator('summary').first().click();
  check('“Diagnose performance issues” is an accordion (collapses and reopens)', collapsed && (await diag.evaluate((d) => d.open)));
  const perfAudit = page.locator('#lh-performance details > summary').first();
  if (await perfAudit.count()) {
    await perfAudit.click();
    check('an audit accordion opens with fix steps or findings', await page.locator('#lh-performance details[open]').first().getByText(/How to fix|What Lighthouse found/).first().isVisible());
  }
  await shot('03b-performance-mobile');
  await axeCheck('Lighthouse report (mobile)');
  check('“Diagnose performance issues” is labelled Mobile on the Mobile tab', /Mobile/.test(await page.locator('#lh-diagnose').innerText()));
  await page.getByRole('tab', { name: 'Desktop' }).click();
  const desktopPanel = page.getByRole('tabpanel', { name: 'Desktop report' });
  await desktopPanel.getByText('Emulated desktop').first().waitFor({ timeout: 30_000 });
  check('Desktop tab switches the report', await page.getByRole('tab', { name: 'Desktop' }).getAttribute('aria-selected') === 'true');
  check(
    'Desktop tab has its own “Diagnose performance issues” with the desktop Lighthouse run',
    /Desktop/.test(await desktopPanel.locator('#lh-diagnose').innerText()) && (await desktopPanel.getByRole('list', { name: 'Category scores' }).getByRole('link').count()) >= 4,
  );

  // Advanced performance panels (real data from this scan's Lighthouse run).
  const panel = async (name) => {
    await page.locator('summary', { has: page.getByRole('heading', { name }) }).click();
    return page.locator('details', { has: page.getByRole('heading', { name }) });
  };
  const resources = await panel('Resource analysis');
  check('resource analysis lists the measured requests', (await resources.getByRole('region', { name: 'Network requests' }).locator('tbody tr').count()) > 0);
  const conditions = await panel('Test conditions');
  check('test conditions state the exact, simulated settings', /round trip[\s\S]*not a measurement on a real/.test(await conditions.innerText()));
  const compare = await panel('Compared with the previous scan');
  await compare.getByText(/first scan of this page|Compared with the scan of/).first().waitFor({ timeout: 30_000 });
  check('comparison panel answers (first scan of a new account)', /first scan of this page/.test(await compare.innerText()));
  await axeCheck('Lighthouse report with performance panels open (desktop)');

  // Field-data rendering. This box has no Chrome UX Report key, so the TEST supplies a sample answer in
  // the API's shape for this one request (the app itself never invents field data).
  const rec = (m) => ({ metrics: m, firstDate: '2026-09-30', lastDate: '2026-10-27' });
  const metric = (p75, distribution) => ({ p75, distribution });
  const sample = {
    status: 'ok', message: null, pageUrl: new URL(TARGET).origin + '/', origin: new URL(TARGET).origin, fetchedAt: new Date().toISOString(),
    phone: { url: null, origin: rec({ lcp: metric(2500, [0.75, 0.17, 0.08]), inp: metric(102, [0.86, 0.1, 0.04]), cls: metric(0, [0.9, 0.07, 0.03]), fcp: metric(2400, [0.62, 0.24, 0.14]), ttfb: metric(1850, [0.6, 0.1, 0.3]) }) },
    // Desktop: INP and TTFB without enough data, as in a typical low-traffic page.
    desktop: { url: rec({ lcp: metric(2600, [0.74, 0.14, 0.12]), cls: metric(0.01, [0.97, 0.01, 0.02]), fcp: metric(2100, [0.72, 0.12, 0.16]) }), origin: null },
  };
  await page.route('**/field-data?**', (route) => route.fulfill({ json: sample }));
  await page.reload();
  await page.getByRole('navigation', { name: 'Issue categories' }).getByRole('button', { name: /Performance/ }).click();
  const field = page.getByRole('region', { name: 'Discover what your real users are experiencing' });
  await field.getByText('Core Web Vitals Assessment:').waitFor({ timeout: 30_000 });
  if (SHOTS) await field.screenshot({ path: `${SHOTS}/03e-field-section.png` });
  const fieldText = await field.innerText();
  check('field data: Core Web Vitals passes when LCP, INP and CLS are all good at p75', /Core Web Vitals Assessment:\s*Passed/.test(fieldText));
  check('field data: p75 values formatted like PageSpeed Insights', ['2.5 s', '102 ms', '1.9 s'].every((v) => fieldText.includes(v)) && /\b0\b/.test(fieldText));
  check('field data: falls back to the origin when the URL has too little traffic', /not enough real-user data for this exact URL/.test(fieldText));
  check('field data: “Other notable metrics” and the 28-day period are shown', /Other notable metrics/i.test(fieldText) && /Latest 28-day period/.test(fieldText));
  check('field data: TTFB rated poor with a shape, not colour alone', /TTFB 75th percentile 1\.9 s, poor/.test((await field.getByRole('img', { name: /^TTFB/ }).getAttribute('aria-label')) ?? ''));
  await field.getByRole('button', { name: 'Expand view' }).click();
  check('field data: “Expand view” shows the good / needs improvement / poor shares', (await field.innerText()).includes('75%') && (await field.getByRole('button', { name: 'Collapse view' }).getAttribute('aria-expanded')) === 'true');
  await field.getByRole('button', { name: 'Origin' }).click();
  check('field data: This URL / Origin toggle', (await field.getByRole('button', { name: 'Origin' }).getAttribute('aria-pressed')) === 'true' && !/exact URL/.test(await field.innerText()));
  await shot('03d-field-data-mobile');
  await axeCheck('real-user data section');
  const periodHelp = field.getByRole('button', { name: 'Collection period' });
  await periodHelp.focus();
  const tipShown = /2026/.test((await field.getByRole('tooltip').innerText().catch(() => '')) ?? '') && !!(await periodHelp.getAttribute('aria-describedby'));
  await page.keyboard.press('Escape');
  check('field data: “?” tooltips show the 28-day period on focus and close with Escape', tipShown && (await field.getByRole('tooltip').count()) === 0);
  await field.getByRole('button', { name: 'Collapse view' }).click();
  await page.getByRole('tab', { name: 'Desktop' }).click();
  await field.getByRole('button', { name: 'This URL' }).click();
  const desktopField = await field.innerText();
  check('field data: Desktop tab shows desktop data (LCP needs improvement → assessment failed)', /Core Web Vitals Assessment:\s*Failed/.test(desktopField) && desktopField.includes('2.6 s'));
  check('field data: metrics without enough data show N/A on a grey bar', (desktopField.match(/N\/A/g) ?? []).length === 2 && (await field.getByRole('img', { name: /^INP: not enough real-user data/ }).count()) === 1);
  if (SHOTS) await field.screenshot({ path: `${SHOTS}/03f-field-section-desktop.png` });
  await axeCheck('real-user data section (desktop, N/A metrics)');
  await page.unroute('**/field-data?**');
  await shot('03c-performance-desktop');

  // ---------------------------------------------------------------- report
  await page.getByRole('link', { name: 'View report' }).click();
  await page.getByRole('heading', { name: 'Issue details' }).waitFor();
  const report = (await page.locator('main').textContent()) ?? '';
  for (const section of ['Summary', 'Results by category', 'Top priorities', 'Pages tested', 'Screenshot evidence', 'Limitations'])
    check(`report has “${section}”`, report.includes(section));
  check('report states automated testing limits', /cannot establish WCAG conformance/.test(report));
  await shot('04-report');
  const csv = await page.evaluate(async (u) => (await fetch(`/api/reports/${u.split('/').pop()}/issues.csv`)).text(), scanUrl);
  check('CSV export downloads', csv.split('\r\n').length > 5);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), page.getByRole('button', { name: 'PDF' }).click()]);
  const pdfPath = await download.path();
  const head = fs.readFileSync(pdfPath).subarray(0, 4).toString();
  check('PDF export downloads a real PDF', head === '%PDF', download.suggestedFilename());

  // ---------------------------------------------------------------- issues
  await page.goto(`${APP}/issues`);
  await page.getByText(/\d+ issues?/).first().waitFor();
  const rows = await page.locator('main ul li a[href^="/issues/"]').count();
  check('issues list populated from scan', rows > 10, `${rows} rows`);
  await page.getByLabel('Severity').selectOption('high');
  await page.waitForTimeout(800);
  const highTitles = await page.locator('main ul li a[href^="/issues/"]').allTextContents();
  check('severity filter works', highTitles.length > 0 && highTitles.every((t) => t.includes('High')), `${highTitles.length} high`);
  await page.locator('main ul li a[href^="/issues/"]').first().click();
  await page.getByRole('heading', { name: 'What was detected?' }).waitFor();
  const headings = await page.locator('article h2').allTextContents();
  const want = ['What was detected?', 'Where was it detected?', 'Why does it matter?', 'What evidence supports the finding?', 'How serious is it?', 'What should you do?', 'Step-by-step fix', 'Example code', 'How to verify the fix', 'Run a verification scan'];
  check('issue page has all 10 sections', want.every((w) => headings.some((h) => h.includes(w))), headings.join(' / '));
  await page.getByText('Technical details for developers').click();
  check('technical details expand', await page.getByText('Detection method').isVisible());
  await shot('05-issue');
  await axeCheck('issue detail');

  // ---------------------------------------------------------------- overview metrics
  await page.goto(`${APP}/dashboard`);
  await page.getByText('Latest scan activity').waitFor();
  const ov = await page.evaluate(async () => (await fetch('/api/overview')).json());
  const highShown = await page.getByText('High priority').locator('xpath=ancestor::a').locator('div.text-3xl').textContent();
  check('overview “High priority” equals stored data', Number(highShown) === ov.highIssues, `${highShown} vs ${ov.highIssues}`);
  await shot('06-overview');
  await axeCheck('overview');

  // ---------------------------------------------------------------- mobile 390px
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const mp = await m.newPage();
  mp.on('pageerror', (e) => consoleErrors.push(e.message));
  const reportPath = new URL(page.url()).origin + '/reports/' + scanUrl.split('/').pop();
  const issueHref = await page.evaluate(async () => (await (await fetch('/api/issues?limit=1')).json()).items[0].id);
  for (const route of ['/', '/dashboard', '/websites', '/scans/new', '/scans', scanUrl.replace(APP, ''), '/issues', `/issues/${issueHref}`, '/baselines', reportPath.replace(APP, ''), '/settings', '/billing']) {
    await mp.goto(`${APP}${route}`);
    await mp.waitForLoadState('networkidle');
    await mp.waitForTimeout(300);
    const { sw, cw } = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    check(`390px: no horizontal scroll on ${route.length > 40 ? route.slice(0, 40) + '…' : route}`, sw <= cw, `${sw} > ${cw}`);
  }
  await mp.goto(`${APP}/dashboard`);
  await mp.getByRole('button', { name: 'Open menu' }).click();
  check('mobile menu opens', await mp.getByRole('dialog', { name: 'Menu' }).isVisible());
  await shot('07-mobile-menu', mp);
  await mp.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Issues' }).click();
  await mp.waitForURL(/\/issues/);
  check('mobile menu navigates and closes', !(await mp.getByRole('dialog', { name: 'Menu' }).isVisible().catch(() => false)));
  await shot('08-mobile-issues', mp);
  await m.close();

  // ---------------------------------------------------------------- sign out
  await page.goto(`${APP}/dashboard`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  check('sign out returns to the landing page', true);
  const after = await page.evaluate(async () => (await fetch('/api/overview')).status);
  check('session is gone after sign out', after === 401);
} catch (e) {
  check('unexpected error', false, e.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  const relevant = consoleErrors.filter((t) => !/401|Unauthorized|favicon/i.test(t));
  check('no browser console errors in the app', relevant.length === 0, relevant.slice(0, 5).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
