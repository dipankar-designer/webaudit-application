// Turns a scan's raw findings into persistent issues and applies the status rules:
//
//  • detected, never seen before           → new issue (open / needs_review / inconclusive)
//  • detected, previously resolved          → reopened
//  • not detected, and this scan re-ran the same check on every page/viewport where the issue
//    was last seen                          → resolved
//  • not detected, but not re-tested under the same conditions → unchanged (never auto-resolved);
//    for verification scans that targeted the issue → not_tested, with an explanatory event.

import crypto from 'node:crypto';
import type pg from 'pg';
import { emptySeverityCounts, type Category, type IssueStatus, type ScanSummary, type Severity } from '@wpcg/shared';
import { query } from '../db/pool.js';
import { coverageKey, type RawFinding } from './types.js';
import { SHARED_PREFIX } from './consolidate.js';

export function fingerprintOf(f: RawFinding): string {
  const vp = f.rule.viewportDependent ? f.viewport ?? '' : '';
  return crypto.createHash('sha256').update(`${f.rule.id}|${vp}|${f.target}`).digest('hex').slice(0, 40);
}

export function coverageKeyOf(f: RawFinding): string {
  return coverageKey(f.check ?? f.rule.check, f.rule.viewportDependent ? f.viewport : null, f.pageUrl);
}

const ACTIVE: IssueStatus[] = ['open', 'reopened', 'needs_review', 'inconclusive', 'not_tested'];

interface ExistingIssue {
  id: string;
  fingerprint: string;
  status: IssueStatus;
  coverage_keys: string[];
  rule_id: string;
  target: string | null;
  /** Closed because the problem moved into a grouped issue — not fixed. */
  merged: boolean;
}

export async function persistFindings(
  client: pg.PoolClient,
  scan: { id: string; workspaceId: string; websiteId: string; verifyIssueIds: string[] },
  findings: RawFinding[],
  coverage: Set<string>,
  pagesMeta: { discovered: number; scanned: number; failed: number },
): Promise<ScanSummary> {
  const now = new Date().toISOString();
  const groups = new Map<string, RawFinding[]>();
  for (const f of findings) {
    const fp = fingerprintOf(f);
    groups.set(fp, [...(groups.get(fp) ?? []), f]);
  }

  const existingRows = await query<ExistingIssue>(
    "SELECT id, fingerprint, status, coverage_keys, rule_id, details->>'target' AS target, coalesce((details->>'merged')::boolean, false) AS merged FROM issues WHERE website_id = $1 FOR UPDATE",
    [scan.websiteId],
    client,
  );
  const existing = new Map(existingRows.map((r) => [r.fingerprint, r]));

  const bySeverity = emptySeverityCounts();
  const byCategory: Partial<Record<Category, number>> = {};
  let newIssues = 0;
  let confirmedIssues = 0;
  let needsManualReview = 0;
  let pendingVerification = 0;
  // Rule + page pairs now reported through element-grouped issues (see consolidate.ts).
  const groupedRulePages = new Set(findings.filter((f) => f.target.startsWith(SHARED_PREFIX)).map((f) => `${f.rule.id}|${f.pageUrl}`));
  const detectedRules = new Set(findings.map((f) => f.rule.id));
  /** An earlier issue whose problem is now reported under a different grouping (not fixed). */
  const merged = (prev: ExistingIssue) =>
    !!prev.target &&
    !prev.target.startsWith(SHARED_PREFIX) &&
    (prev.target.startsWith('elements:') ? detectedRules.has(prev.rule_id) : groupedRulePages.has(`${prev.rule_id}|${prev.target}`));
  let reopened = 0;
  let resolved = 0;

  const event = (issueId: string, from: IssueStatus | null, to: IssueStatus, reason: string) =>
    query('INSERT INTO issue_events (issue_id, scan_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [issueId, scan.id, from, to, reason], client);

  for (const [fp, list] of groups) {
    const first = list[0];
    const rule = first.rule;
    const hint: IssueStatus = list.some((f) => (f.status ?? rule.initialStatus ?? 'open') === 'open')
      ? 'open'
      : (first.status ?? rule.initialStatus ?? 'open');
    const details = {
      description: rule.description,
      detectionMethod: rule.detectionMethod,
      confidence: rule.confidence,
      limitations: rule.limitations,
      severityReason: rule.severityReason,
      remediation: rule.remediation,
      technical: first.technical ?? [],
      scope: rule.scope,
      target: first.target,
    };
    const keys = [...new Set(list.map(coverageKeyOf))];
    const prev = existing.get(fp);
    let issueId: string;
    let finalStatus: IssueStatus = hint;
    if (!prev) {
      const row = await query<{ id: string }>(
        `INSERT INTO issues (workspace_id, website_id, fingerprint, rule_id, category, severity, title, status, wcag, details, coverage_keys,
                             first_detected_at, last_detected_at, first_scan_id, last_scan_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$13) RETURNING id`,
        [scan.workspaceId, scan.websiteId, fp, rule.id, rule.category, rule.severity, rule.title, hint, rule.wcag ?? [], details, keys, now, scan.id],
        client,
      );
      issueId = row[0].id;
      newIssues++;
      await event(issueId, null, hint, 'First detected in this scan.');
      finalStatus = hint;
    } else {
      issueId = prev.id;
      let next: IssueStatus = prev.status;
      let reason: string | null = null;
      if (prev.status === 'resolved' && prev.merged) {
        // It was only regrouped, never fixed: continue it rather than calling it reopened.
        next = hint;
        reason = 'Reported for this page again (it had been grouped with other pages; it was not fixed in between).';
      } else if (prev.status === 'resolved') {
        next = 'reopened';
        reason = 'Detected again after it had been resolved.';
        reopened++;
      } else if ((prev.status === 'inconclusive' || prev.status === 'not_tested') && hint === 'open') {
        next = 'open';
        reason = 'Confirmed by a definitive result in this scan.';
      } else if (prev.status === 'not_tested') {
        next = hint;
        reason = 'Re-tested and still detected.';
      } else if (hint === 'needs_review' && rule.initialStatus === 'needs_review' && (prev.status === 'open' || prev.status === 'reopened')) {
        // A rule that always needs human judgement can never be a confirmed defect.
        next = 'needs_review';
        reason = 'This check cannot decide automatically, so it needs manual review.';
      }
      await query(
        `UPDATE issues SET status = $2, severity = $3, title = $4, wcag = $5, details = $6, coverage_keys = $7,
                last_detected_at = $8, last_scan_id = $9, resolved_at = NULL, updated_at = now() WHERE id = $1`,
        [issueId, next, rule.severity, rule.title, rule.wcag ?? [], details, keys, now, scan.id],
        client,
      );
      if (reason) await event(issueId, prev.status, next, reason);
      existing.delete(fp);
      finalStatus = next;
    }
    // Only confirmed defects count towards severity totals; review and pending items are counted separately.
    if (finalStatus === 'needs_review') needsManualReview++;
    else if (finalStatus === 'inconclusive' || finalStatus === 'not_tested') pendingVerification++;
    else {
      confirmedIssues++;
      bySeverity[rule.severity as Severity]++;
    }
    byCategory[rule.category] = (byCategory[rule.category] ?? 0) + 1;
    for (const f of list) {
      await query('INSERT INTO findings (issue_id, scan_id, page_url, viewport, evidence) VALUES ($1,$2,$3,$4,$5)', [
        issueId,
        scan.id,
        f.pageUrl,
        f.viewport,
        JSON.stringify(f.evidence),
      ], client);
    }
  }

  // Issues not detected in this scan.
  const targeted = new Set(scan.verifyIssueIds);
  for (const prev of existing.values()) {
    if (!ACTIVE.includes(prev.status)) continue;
    const covered = prev.coverage_keys.length > 0 && prev.coverage_keys.every((k) => coverage.has(k));
    if (covered && merged(prev)) {
      // Same problem, now reported once across pages: close the old per-page record without calling it fixed.
      await query("UPDATE issues SET status = 'resolved', resolved_at = now(), updated_at = now(), details = details || '{\"merged\": true}'::jsonb WHERE id = $1", [prev.id], client);
      await event(prev.id, prev.status, 'resolved', 'Merged: this problem is now reported once for every page it appears on (grouped by element). It was not fixed — see the grouped issue.');
    } else if (covered) {
      await query("UPDATE issues SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1", [prev.id], client);
      await event(prev.id, prev.status, 'resolved', 'Not found when the same check re-ran on the same page(s) and viewport(s).');
      resolved++;
    } else if (targeted.has(prev.id)) {
      const missing = prev.coverage_keys.filter((k) => !coverage.has(k)).map((k) => k.split('|').slice(0, 3).join(' · '));
      await query("UPDATE issues SET status = 'not_tested', updated_at = now() WHERE id = $1", [prev.id], client);
      await event(prev.id, prev.status, 'not_tested', `The verification scan could not re-run the check everywhere the issue was seen (${missing.slice(0, 3).join('; ')}). The issue was not marked resolved.`);
    }
  }

  return {
    pagesDiscovered: pagesMeta.discovered,
    pagesScanned: pagesMeta.scanned,
    pagesFailed: pagesMeta.failed,
    findings: findings.length,
    issuesDetected: groups.size,
    newIssues,
    reopenedIssues: reopened,
    resolvedIssues: resolved,
    bySeverity,
    byCategory,
    confirmedIssues,
    needsManualReview,
    pendingVerification,
  };
}
