// Scan orchestration: discovery → per-page HTTP + browser checks → site-level checks →
// link checks → visual comparison → persistence. Each category records honestly whether it
// completed, partially ran, failed, or was skipped.

import type { Page } from 'playwright-core';
import {
  CATEGORIES,
  VIEWPORTS,
  type Category,
  type CheckRunStatus,
  type ScanSummary,
  type ViewportName,
  type WordPressReportDTO,
} from '@wpcg/shared';
import { config } from '../config.js';
import { query, tx } from '../db/pool.js';
import { safeFetch, type SafeResponse } from '../security/safeFetch.js';
import { BlockedTargetError } from '../security/ssrf.js';
import { readStored, relScanPath, writeStored } from '../storage/files.js';
import { newContext } from './browser.js';
import { EXTRACT_SCRIPT, LAZY_SCROLL_SCRIPT, stabiliseCss, type Extracted } from './browserScripts.js';
import { axeFindings, axeVersion, runAxe } from './checks/accessibility.js';
import { availabilityFindings } from './checks/availability.js';
import { htmlFindings, seoPageFindings, seoSiteFindings } from './checks/document.js';
import { checkLinks } from './checks/links.js';
import { imageFindings, javascriptFindings, mobileContentFindings, overflowFindings, type RuntimeLog } from './checks/pageRuntime.js';
import { pageSecurityFindings, siteSecurityFindings } from './checks/security.js';
import { compareScreenshots } from './checks/visual.js';
import { discoverPages, normalisePageUrl, type DiscoveredPage } from './discovery.js';
import { runLighthouse, lighthouseAvailable } from './checks/performance.js';
import { persistFindings } from './persist.js';
import { consolidateFindings } from './consolidate.js';
import { verifyFindings } from './verify.js';
import { inspectWordPress } from './wordpress/inspect.js';
import { R } from './rules.js';
import { coverageKey, type RawFinding, type ScanJob, type Viewport } from './types.js';

export class ScanPolicyError extends Error {}

export interface ScanControl {
  signal: AbortSignal;
  progress: (phase: string, done: number, total: number, message: string) => void;
}

interface CheckTally {
  ran: number;
  failed: number;
  notes: string[];
  started: number;
  ended: number | null;
}

const BROWSER_CHECKS: Category[] = ['html', 'seo', 'accessibility', 'security', 'javascript', 'images', 'responsive', 'visual', 'links', 'performance'];
const MAX_SCREENSHOT_HEIGHT = 8000;

export async function runScan(job: ScanJob, ctl: ScanControl): Promise<ScanSummary> {
  const cfg = job.config;
  const selected = new Set<Category>(cfg.checks);
  const viewports: Viewport[] = cfg.viewports.map((name) => ({ name, ...VIEWPORTS[name] }));
  const findings: RawFinding[] = [];
  const coverage = new Set<string>();
  const tally = new Map<Category, CheckTally>();
  const t = (c: Category) => {
    let v = tally.get(c);
    if (!v) tally.set(c, (v = { ran: 0, failed: 0, notes: [], started: Date.now(), ended: null }));
    return v;
  };
  const ran = (c: Category, viewport: ViewportName | null, pageUrl: string, check: string = c) => {
    t(c).ran++;
    coverage.add(coverageKey(check, viewport, pageUrl));
  };

  // Visual comparison needs an entitled plan and a baseline from the same website.
  let baselineScanId: string | null = null;
  if (selected.has('visual')) {
    if (!job.plan.visualComparison) t('visual').notes.push('Visual comparison is not included in the current plan.');
    else if (!cfg.baselineId) t('visual').notes.push('No baseline was selected, so screenshots were captured but not compared.');
    else {
      const b = await query<{ scan_id: string }>('SELECT scan_id FROM baselines WHERE id = $1 AND website_id = $2', [cfg.baselineId, job.websiteId]);
      if (b[0]) baselineScanId = b[0].scan_id;
      else t('visual').notes.push('The selected baseline no longer exists.');
    }
  }
  const needScreens = selected.has('responsive') || selected.has('visual');
  const needBrowser = BROWSER_CHECKS.some((c) => selected.has(c));

  // ---------------------------------------------------------------- discovery
  ctl.progress('discovery', 0, cfg.maxPages, 'Reading robots.txt, sitemaps and links');
  const discovery = await discoverPages(job.baseUrl, {
    maxPages: cfg.maxPages,
    maxDepth: config.SCAN_MAX_CRAWL_DEPTH,
    selectedUrls: cfg.pageMode === 'selected' ? cfg.selectedUrls : undefined,
    signal: ctl.signal,
    onProgress: (msg, n) => ctl.progress('discovery', n, cfg.maxPages, msg),
  });
  const startUrl = normalisePageUrl(discovery.startUrl)!;
  const origin = new URL(startUrl).origin;
  const startRes = discovery.pages.find((p) => p.url === startUrl)?.response ?? (await safeFetch(startUrl, { signal: ctl.signal }));
  if (startRes.failure?.kind === 'blocked') throw new ScanPolicyError(startRes.failure.message);
  const siteHosts = discovery.scopeHosts;
  const notes = [...discovery.notes];

  // ---------------------------------------------------------------- pages
  const pageResults: { url: string; res: SafeResponse; extracted: Extracted | null; testable: boolean; pageId: string }[] = [];
  const linkTargets = new Map<string, { pageUrl: string; text: string }[]>();
  const screenshots: { pageId: string; url: string; viewport: ViewportName; screenshotId: string; path: string; hidden: string[] }[] = [];
  let done = 0;
  let failedPages = 0;

  const processPage = async (dp: DiscoveredPage) => {
    if (ctl.signal.aborted) return;
    const res = dp.response ?? (await safeFetch(dp.url, { signal: ctl.signal }));
    // Stopped mid-request (cancel or the scan's time limit): the page was not tested — it did not time out.
    if (!dp.response && ctl.signal.aborted) return;
    if (res.failure?.kind === 'blocked') {
      notes.push(`Skipped ${dp.url}: ${res.failure.message}`);
      return;
    }
    const isStart = dp.url === startUrl;
    const pageRow = await query<{ id: string }>(
      `INSERT INTO scan_pages (scan_id, url, final_url, status_code, content_type, load_ms, error, source, depth, redirect_chain)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (scan_id, url) DO UPDATE SET final_url = EXCLUDED.final_url RETURNING id`,
      [job.id, dp.url, res.finalUrl, res.status, res.headers['content-type'] ?? null, res.durationMs, res.failure?.message ?? null, dp.source, dp.depth, JSON.stringify(res.redirects)],
    );
    const pageId = pageRow[0].id;
    const avail = availabilityFindings(dp.url, res, isStart, origin);
    if (selected.has('availability')) {
      findings.push(...avail.findings);
      ran('availability', null, dp.url);
    }
    const isHtml = /text\/html|application\/xhtml/i.test(res.headers['content-type'] ?? '');
    let extracted: Extracted | null = null;
    if (!avail.testable || !isHtml) {
      if (!avail.testable) failedPages++;
      pageResults.push({ url: dp.url, res, extracted, testable: false, pageId });
      return;
    }

    if (needBrowser) {
      const perViewport = new Map<ViewportName, Extracted>();
      for (const [i, vp] of viewports.entries()) {
        if (ctl.signal.aborted) return;
        const r = await visitInBrowser(dp.url, vp, {
          primary: i === 0,
          runAxe: i === 0 && selected.has('accessibility'),
          screenshot: needScreens,
          hide: cfg.ignoreSelectors,
          signal: ctl.signal,
        });
        if (r.error) {
          await query('UPDATE scan_pages SET error = $2 WHERE id = $1', [pageId, `Browser (${vp.name}): ${r.error}`]);
          for (const c of BROWSER_CHECKS) if (selected.has(c)) t(c).failed++;
          continue;
        }
        const x = r.extracted!;
        perViewport.set(vp.name, x);
        if (i === 0) {
          extracted = x;
          await query('UPDATE scan_pages SET title = $2 WHERE id = $1', [pageId, x.title]);
          if (selected.has('html')) {
            findings.push(...htmlFindings(dp.url, x, res));
            ran('html', null, dp.url);
          }
          if (selected.has('seo')) {
            findings.push(...seoPageFindings(dp.url, x, res, isStart, siteHosts));
            ran('seo', null, dp.url);
          }
          if (selected.has('security')) {
            findings.push(...pageSecurityFindings(dp.url, x));
            ran('security', null, dp.url);
          }
          if (selected.has('javascript')) {
            findings.push(...javascriptFindings(dp.url, r.log, siteHosts));
            ran('javascript', null, dp.url);
          }
          if (selected.has('accessibility')) {
            if (r.axe) {
              findings.push(...axeFindings(dp.url, r.axe));
              ran('accessibility', null, dp.url);
            } else {
              t('accessibility').failed++;
              if (r.axeError) t('accessibility').notes.push(`axe-core failed on ${dp.url}: ${r.axeError}`);
            }
          }
          if (selected.has('links') || selected.has('seo')) {
            for (const l of x.links) {
              const n = normalisePageUrl(l.href);
              if (!n || n.includes('/cdn-cgi/')) continue; // Cloudflare service links (JS-only e-mail protection etc.)
              const list = linkTargets.get(n) ?? [];
              if (!list.some((s) => s.pageUrl === dp.url)) list.push({ pageUrl: dp.url, text: l.text });
              linkTargets.set(n, list);
            }
            if (selected.has('links') && x.malformedLinks.length)
              findings.push({
                rule: R.malformedLink,
                target: dp.url,
                pageUrl: dp.url,
                viewport: null,
                evidence: [{ label: `${x.malformedLinks.length} malformed link(s)`, value: x.malformedLinks.slice(0, 10).map((m) => `${m.raw}${m.text ? `   ("${m.text}")` : ''}`).join('\n'), code: true }],
              });
          }
        }
        if (selected.has('images')) {
          const imgs = imageFindings(dp.url, x, r.log, vp.name, vp.mobile ? 2 : 1);
          // Viewport-independent image findings come from the primary viewport only.
          findings.push(...imgs.filter((f) => f.rule.viewportDependent || i === 0));
          coverage.add(coverageKey('images', vp.name, dp.url));
          if (i === 0) ran('images', null, dp.url);
        }
        if (selected.has('responsive')) {
          findings.push(...overflowFindings(dp.url, x, vp.name));
          ran('responsive', vp.name, dp.url);
        }
        if (r.screenshot) {
          const file = relScanPath(job.workspaceId, job.id, `${pageId}-${vp.name}.png`);
          await writeStored(file, r.screenshot.png);
          const s = await query<{ id: string }>(
            'INSERT INTO screenshots (scan_id, page_id, viewport, width, height, path, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
            [job.id, pageId, vp.name, r.screenshot.width, r.screenshot.height, file, r.screenshot.png.length],
          );
          screenshots.push({ pageId, url: dp.url, viewport: vp.name, screenshotId: s[0].id, path: file, hidden: cfg.ignoreSelectors });
        }
      }
      const d = perViewport.get('desktop');
      const m = perViewport.get('mobile');
      if (selected.has('responsive') && d && m) findings.push(...mobileContentFindings(dp.url, d, m));
    }
    pageResults.push({ url: dp.url, res, extracted, testable: true, pageId });
  };

  // Bounded concurrency over pages.
  const queue = [...discovery.pages];
  const total = queue.length;
  ctl.progress('pages', 0, total, `Scanning ${total} page(s)`);
  await Promise.all(
    Array.from({ length: Math.min(config.SCAN_PAGE_CONCURRENCY, Math.max(1, total)) }, async () => {
      for (let dp = queue.shift(); dp; dp = queue.shift()) {
        if (ctl.signal.aborted) return;
        try {
          await processPage(dp);
        } catch (e) {
          if (ctl.signal.aborted) return;
          failedPages++;
          notes.push(`Page ${dp.url} could not be processed: ${(e as Error).message.split('\n')[0]}`);
        }
        done++;
        ctl.progress('pages', done, total, `Scanned ${done} of ${total} page(s)`);
      }
    }),
  );
  // Run between phases and before saving: a cancel stops the scan without changing any issue status,
  // and a time limit reached in any phase (not only during pages) skips the remaining checks with a note.
  let timedOut = false;
  const checkpoint = () => {
    if (ctl.signal.aborted && !deadlineHit(ctl.signal)) throw new Error('cancelled');
    if (!timedOut && ctl.signal.aborted) {
      timedOut = true;
      notes.push(`The scan reached its time limit (${Math.round(config.SCAN_MAX_DURATION_MS / 60000)} min); results cover the work finished before then and later checks were skipped.`);
    }
  };
  checkpoint();

  const htmlPages = pageResults.filter((p) => p.testable && p.extracted);

  // ---------------------------------------------------------------- site-level checks
  if (!timedOut && startRes.status !== null && !startRes.failure) {
    if (selected.has('security')) {
      ctl.progress('site', 0, 1, 'Checking HTTPS and security headers');
      findings.push(...(await siteSecurityFindings(startUrl, startRes, ctl.signal)));
      coverage.add(coverageKey('security-site', null, startUrl));
    }
    if (selected.has('seo')) {
      findings.push(
        ...seoSiteFindings({
          startUrl,
          origin,
          pages: htmlPages.map((p) => ({ url: p.url, title: p.extracted!.title, description: p.extracted!.descriptions[0] ?? null })),
          robots: discovery.robots,
          sitemapFound: discovery.sitemapFound,
        }),
      );
      coverage.add(coverageKey('seo-site', null, startUrl));
      for (const p of htmlPages) coverage.add(coverageKey('seo-site', null, p.url));
    }
  }

  // ---------------------------------------------------------------- links
  checkpoint();
  if (selected.has('links') && !timedOut) {
    const known = new Map<string, SafeResponse>();
    for (const p of pageResults) known.set(p.url, p.res);
    ctl.progress('links', 0, linkTargets.size, 'Checking links');
    const out = await checkLinks({
      targets: linkTargets,
      known,
      siteHosts,
      pages: htmlPages.map((p) => p.url),
      checkExternal: cfg.checkExternalLinks,
      signal: ctl.signal,
      onProgress: (d, n) => ctl.progress('links', d, n, `Checked ${d} of ${n} link(s)`),
    });
    findings.push(...out.findings);
    for (const p of out.covered.internal) coverage.add(coverageKey('links', null, p));
    for (const p of out.covered.external) coverage.add(coverageKey('links-external', null, p));
    const tl = t('links');
    tl.ran = out.covered.internal.size;
    tl.notes.push(`${out.checked} unique link target(s) checked.`);
    if (out.skippedExternal) tl.notes.push(`${out.skippedExternal} external link(s) not checked (external link checking is off).`);
    if (out.skippedOverLimit) {
      tl.notes.push(`${out.skippedOverLimit} link(s) not checked because of the ${config.LINK_CHECK_MAX}-link limit.`);
      tl.failed++;
    }
    if (out.blocked) tl.notes.push(`${out.blocked} link(s) point to private or reserved addresses and were not requested.`);
  }

  // ---------------------------------------------------------------- visual comparison
  checkpoint();
  if (selected.has('visual') && baselineScanId && !timedOut) {
    const tv = t('visual');
    const baseShots = await query<{ id: string; path: string; viewport: ViewportName; url: string }>(
      `SELECT s.id, s.path, s.viewport, p.url FROM screenshots s JOIN scan_pages p ON p.id = s.page_id WHERE s.scan_id = $1`,
      [baselineScanId],
    );
    const baselineCfg = await query<{ config: { ignoreSelectors?: string[] } }>('SELECT config FROM scans WHERE id = $1', [baselineScanId]);
    const baselineHidden = baselineCfg[0]?.config.ignoreSelectors ?? [];
    const sameHide = JSON.stringify([...baselineHidden].sort()) === JSON.stringify([...cfg.ignoreSelectors].sort());
    if (!sameHide) tv.notes.push('The baseline was captured with different ignore selectors, which can cause extra differences.');
    ctl.progress('visual', 0, screenshots.length, 'Comparing screenshots with the baseline');
    let i = 0;
    for (const shot of screenshots) {
      i++;
      const base = baseShots.find((b) => b.url === shot.url && b.viewport === shot.viewport);
      const settings = { thresholdPct: cfg.visualThresholdPct, pixelTolerance: cfg.pixelTolerance, ignoreSelectors: cfg.ignoreSelectors, baselineIgnoreSelectors: baselineHidden };
      if (!base) {
        await query(
          `INSERT INTO visual_comparisons (scan_id, baseline_scan_id, page_url, viewport, status, threshold_pct, pixel_tolerance, current_screenshot_id, note, settings)
           VALUES ($1,$2,$3,$4,'incomparable',$5,$6,$7,$8,$9)`,
          [job.id, baselineScanId, shot.url, shot.viewport, cfg.visualThresholdPct, cfg.pixelTolerance, shot.screenshotId, 'The baseline has no screenshot for this page and viewport.', settings],
        );
        continue;
      }
      try {
        const cmp = compareScreenshots(await readStored(base.path), await readStored(shot.path), cfg.pixelTolerance);
        const diffFile = relScanPath(job.workspaceId, job.id, `${shot.pageId}-${shot.viewport}-diff.png`);
        await writeStored(diffFile, cmp.diffPng);
        const pct = cmp.ratio * 100;
        const changed = pct > cfg.visualThresholdPct;
        const heightNote = cmp.baselineHeight !== cmp.currentHeight ? `Page height changed from ${cmp.baselineHeight}px to ${cmp.currentHeight}px.` : null;
        await query(
          `INSERT INTO visual_comparisons (scan_id, baseline_scan_id, page_url, viewport, status, diff_ratio, threshold_pct, pixel_tolerance,
                                           baseline_screenshot_id, current_screenshot_id, diff_path, note, settings)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [job.id, baselineScanId, shot.url, shot.viewport, changed ? 'changed' : 'match', cmp.ratio, cfg.visualThresholdPct, cfg.pixelTolerance, base.id, shot.screenshotId, diffFile, heightNote, settings],
        );
        coverage.add(coverageKey('visual', shot.viewport, shot.url));
        tv.ran++;
        if (changed)
          findings.push({
            rule: R.visualChange,
            target: shot.url,
            pageUrl: shot.url,
            viewport: shot.viewport,
            evidence: [
              { label: 'Changed pixels', value: `${pct.toFixed(2)}% of the page (${cmp.diffPixels.toLocaleString('en')} of ${cmp.totalPixels.toLocaleString('en')} pixels)` },
              { label: 'Threshold', value: `${cfg.visualThresholdPct}% (per-pixel tolerance ${cfg.pixelTolerance})` },
              ...(heightNote ? [{ label: 'Page height', value: heightNote }] : []),
              { label: 'Viewport', value: VIEWPORTS[shot.viewport].label },
            ],
          });
      } catch (e) {
        tv.failed++;
        await query(
          `INSERT INTO visual_comparisons (scan_id, baseline_scan_id, page_url, viewport, status, threshold_pct, pixel_tolerance, current_screenshot_id, note, settings)
           VALUES ($1,$2,$3,$4,'failed',$5,$6,$7,$8,$9)`,
          [job.id, baselineScanId, shot.url, shot.viewport, cfg.visualThresholdPct, cfg.pixelTolerance, shot.screenshotId, `Comparison failed: ${(e as Error).message}`, settings],
        );
      }
      ctl.progress('visual', i, screenshots.length, `Compared ${i} of ${screenshots.length} screenshot(s)`);
    }
  }

  // ---------------------------------------------------------------- performance
  checkpoint();
  let perfAvailable = false;
  let perfTargets = 0;
  if (selected.has('performance') && !timedOut) {
    perfAvailable = await lighthouseAvailable();
    if (!perfAvailable) t('performance').notes.push('Lighthouse is not installed in this deployment.');
    else {
      const tp = t('performance');
      // Like PageSpeed Insights: one full Lighthouse report for the home (start) page, mobile and desktop.
      const home = htmlPages.find((p) => p.url === startUrl) ?? htmlPages[0];
      const targets = home ? [home] : [];
      perfTargets = targets.length;
      if (home) tp.notes.push(`Lighthouse report for the home page (${home.url}), mobile and desktop — the same scope as PageSpeed Insights${config.LIGHTHOUSE_RUNS > 1 ? `; each is the median of ${config.LIGHTHOUSE_RUNS} runs` : ''}.`);
      let k = 0;
      for (const p of targets) {
        for (const vp of viewports) {
          if (ctl.signal.aborted) break;
          ctl.progress('performance', k++, targets.length * viewports.length, `Lighthouse: ${p.url} (${vp.name})`);
          const r = await runLighthouse(p.url, vp, ctl.signal);
          if (r.error) {
            tp.failed++;
            tp.notes.push(`Lighthouse failed on ${p.url} (${vp.name}): ${r.error}`);
            continue;
          }
          findings.push(...r.findings);
          if (r.metrics)
            await query('UPDATE scan_pages SET lab_metrics = lab_metrics || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1', [p.pageId, vp.name, JSON.stringify(r.metrics)]);
          if (r.report) {
            // Full PageSpeed-style report (categories, groups, audits, screenshots) for the results page.
            const scores = Object.fromEntries(r.report.categories.map((c) => [c.id, c.score]));
            await query(
              `INSERT INTO lighthouse_reports (scan_id, page_url, viewport, scores, report) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (scan_id, page_url, viewport) DO UPDATE SET scores = EXCLUDED.scores, report = EXCLUDED.report`,
              [job.id, p.url, vp.name, JSON.stringify(scores), JSON.stringify(r.report)],
            );
          }
          coverage.add(coverageKey('performance', vp.name, p.url));
          tp.ran++;
        }
      }
    }
  }

  // ---------------------------------------------------------------- verification before reporting
  // Single-observation detections (images that did not render, links that failed) are re-requested;
  // then page findings caused by the same element are grouped into one issue across pages.
  checkpoint();
  ctl.progress('verify', 0, 1, 'Re-checking findings before reporting');
  const verified = await verifyFindings(findings, ctl.signal);
  const reported = consolidateFindings(verified.findings);

  // ---------------------------------------------------------------- WordPress and plugin information
  checkpoint();
  let wordpress: WordPressReportDTO | null = null;
  if (htmlPages.length && timedOut) notes.push('WordPress and plugin information was not collected because the scan reached its time limit.');
  else if (htmlPages.length) {
    ctl.progress('wordpress', 0, 1, 'Identifying WordPress version and plugins');
    try {
      wordpress = await inspectWordPress(
        htmlPages.map((p) => ({ url: p.res.finalUrl || p.url, html: p.res.body?.toString('utf8') ?? '', headers: p.res.headers })),
        origin,
        ctl.signal,
      );
    } catch (e) {
      notes.push(`WordPress and plugin information could not be collected: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  // ---------------------------------------------------------------- check runs + persistence
  const testable = htmlPages.length;
  const runs: { category: Category; status: CheckRunStatus; pages: number; detail: string; started: number; ended: number }[] = [];
  for (const c of CATEGORIES) {
    const v = tally.get(c);
    const now = Date.now();
    if (!selected.has(c)) {
      runs.push({ category: c, status: 'skipped', pages: 0, detail: c === 'forms' ? 'Form tests are not available yet. Forms are inspected passively (labels, insecure actions) by the accessibility and security checks; nothing is ever submitted.' : 'Not selected for this scan.', started: now, ended: now });
      continue;
    }
    if (c === 'performance' && !perfAvailable) {
      runs.push({ category: c, status: 'unavailable', pages: 0, detail: v?.notes.join(' ') || 'Not available.', started: now, ended: now });
      continue;
    }
    if (c === 'visual' && !baselineScanId) {
      runs.push({ category: c, status: 'skipped', pages: 0, detail: v?.notes.join(' ') || 'No baseline selected.', started: now, ended: now });
      continue;
    }
    const pagesTested = v?.ran ?? 0;
    const expected = c === 'availability' ? pageResults.length : c === 'visual' ? screenshots.length : c === 'performance' ? perfTargets : testable;
    let status: CheckRunStatus;
    if (pagesTested === 0 && expected > 0) status = 'failed';
    else if (pagesTested === 0 && expected === 0) status = c === 'availability' ? 'completed' : 'failed';
    else if ((v?.failed ?? 0) > 0 || pagesTested < expected || timedOut) status = 'partial';
    else status = 'completed';
    const detailParts = [...(v?.notes ?? [])];
    if (status === 'failed' && expected === 0 && c !== 'availability') detailParts.unshift('No page could be loaded for this check.');
    if (c === 'accessibility' && pagesTested) detailParts.push(`axe-core ${axeVersion()} with WCAG 2.0/2.1/2.2 A and AA rules plus best practices. Content inside iframes (maps, video players, third-party widgets) is not tested. Automated testing cannot establish WCAG conformance.`);
    runs.push({ category: c, status, pages: pagesTested, detail: detailParts.join(' '), started: v?.started ?? now, ended: v?.ended ?? now });
  }

  checkpoint();
  const summary = await tx(async (client) => {
    // One scan of a website saves at a time: two scans inserting the same new issue at once would
    // otherwise collide on the (website, fingerprint) unique key and fail.
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`persist:${job.websiteId}`], client);
    const s = await persistFindings(
      client,
      { id: job.id, workspaceId: job.workspaceId, websiteId: job.websiteId, verifyIssueIds: cfg.verifyIssueIds },
      reported,
      coverage,
      { discovered: discovery.pages.length + discovery.skipped.overLimit, scanned: pageResults.length, failed: failedPages },
    );
    for (const r of runs)
      await query(
        `INSERT INTO check_runs (scan_id, category, status, pages_tested, detail, started_at, finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (scan_id, category) DO UPDATE SET status = EXCLUDED.status, pages_tested = EXCLUDED.pages_tested, detail = EXCLUDED.detail`,
        [job.id, r.category, r.status, r.pages, r.detail, new Date(r.started).toISOString(), new Date(r.ended).toISOString()],
        client,
      );
    const keys = [...coverage];
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      await query(
        `INSERT INTO scan_coverage (scan_id, key) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [job.id, chunk],
        client,
      );
    }
    return s;
  });
  return { ...summary, notes, verification: verified.record, wordpress } as ScanSummary & { notes: string[] };
}

function deadlineHit(signal: AbortSignal): boolean {
  return (signal.reason as Error | undefined)?.name === 'TimeoutError';
}

// ---------------------------------------------------------------- browser visit

interface VisitResult {
  error: string | null;
  extracted: Extracted | null;
  log: RuntimeLog;
  axe: Awaited<ReturnType<typeof runAxe>> | null;
  axeError: string | null;
  screenshot: { png: Buffer; width: number; height: number } | null;
}

async function visitInBrowser(
  url: string,
  vp: Viewport,
  opts: { primary: boolean; runAxe: boolean; screenshot: boolean; hide: string[]; signal: AbortSignal },
): Promise<VisitResult> {
  const log: RuntimeLog = { consoleErrors: [], pageErrors: [], failedRequests: [], failedImages: new Set() };
  const result: VisitResult = { error: null, extracted: null, log, axe: null, axeError: null, screenshot: null };
  let ctx;
  try {
    ctx = await newContext(vp);
  } catch (e) {
    result.error = `Browser could not start: ${(e as Error).message.split('\n')[0]}`;
    return result;
  }
  const abort = () => void ctx!.close().catch(() => {});
  opts.signal.addEventListener('abort', abort, { once: true });
  try {
    const page: Page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' && log.consoleErrors.length < 60) log.consoleErrors.push({ text: m.text().slice(0, 600), source: m.location()?.url ?? '' });
    });
    page.on('pageerror', (e) => {
      if (log.pageErrors.length < 30) log.pageErrors.push({ message: e.message.slice(0, 600), stack: (e.stack ?? '').slice(0, 2000) });
    });
    page.on('requestfailed', (req) => {
      const type = req.resourceType();
      const err = req.failure()?.errorText ?? 'failed';
      // Requests Chrome cancels itself (lazy loading, superseded srcset candidates) are not failures.
      if (type === 'image' && !/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/i.test(err)) log.failedImages.add(req.url().replace(/[?#].*$/, ''));
      if (log.failedRequests.length < 80) log.failedRequests.push({ url: req.url(), status: null, error: err, resourceType: type });
    });
    page.on('response', (res) => {
      const status = res.status();
      if (status < 400) return;
      const req = res.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) return; // availability check covers the document itself
      const type = req.resourceType();
      if (type === 'image') log.failedImages.add(res.url().replace(/[?#].*$/, ''));
      if (log.failedRequests.length < 80) log.failedRequests.push({ url: res.url(), status, error: null, resourceType: type });
    });

    try {
      await page.goto(url, { waitUntil: 'load', timeout: config.SCAN_PAGE_TIMEOUT_MS });
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      // A page that never fires "load" can still be inspected; anything else is a failure.
      if (!/Timeout/i.test(msg)) throw e;
    }
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    if (opts.screenshot || opts.primary) await page.evaluate(LAZY_SCROLL_SCRIPT).catch(() => {});
    await page.waitForTimeout(250);
    result.extracted = (await page.evaluate(EXTRACT_SCRIPT)) as Extracted;

    if (opts.runAxe) {
      try {
        result.axe = await runAxe(page);
      } catch (e) {
        result.axeError = (e as Error).message.split('\n')[0].slice(0, 200);
      }
    }
    if (opts.screenshot) {
      const docHeight = await page.evaluate('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)').catch(() => vp.height);
      const height = Math.min(Math.max(Number(docHeight) || vp.height, vp.height), MAX_SCREENSHOT_HEIGHT);
      const png = await page.screenshot({
        type: 'png',
        fullPage: true,
        clip: { x: 0, y: 0, width: vp.width, height },
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        style: stabiliseCss([]),
        mask: opts.hide.map((s) => page.locator(s)),
        maskColor: '#FF00FF',
        timeout: 30000,
      });
      result.screenshot = { png, width: vp.width, height };
    }
  } catch (e) {
    result.error = opts.signal.aborted ? 'Scan stopped' : (e as Error).message.split('\n')[0].slice(0, 300);
    if (e instanceof BlockedTargetError) result.error = e.message;
  } finally {
    opts.signal.removeEventListener('abort', abort);
    await ctx.close().catch(() => {});
  }
  return result;
}
