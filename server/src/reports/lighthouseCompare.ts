// Compares two stored Lighthouse reports of the same page and device. Reports only measured values and
// how the tests differed; it never says *why* a value changed — lab results move with network and CPU
// conditions as well as with changes to the site.

import type { LhComparisonDTO, LhSnapshotDTO, LhTestConfigDTO, LighthouseReportDTO, ViewportName } from '@wpcg/shared';

export const COMPARED_METRICS = ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index'] as const;

type StoredReport = Omit<LighthouseReportDTO, 'pageUrl' | 'viewport'>;

export function snapshotOf(r: StoredReport, scanId: string, scanFinishedAt: string | null): LhSnapshotDTO {
  const total = r.resourceSummary?.find((s) => s.resourceType === 'total');
  return {
    scanId,
    scanFinishedAt,
    fetchTime: r.fetchTime,
    lighthouseVersion: r.lighthouseVersion,
    scores: Object.fromEntries(r.categories.map((c) => [c.id, c.score])),
    metrics: Object.fromEntries(COMPARED_METRICS.map((id) => [id, typeof r.audits[id]?.numericValue === 'number' ? r.audits[id].numericValue! : null])),
    // Older reports have no resource summary; total-byte-weight is the same measurement.
    totalTransferSize: total?.transferSize ?? (typeof r.audits['total-byte-weight']?.numericValue === 'number' ? r.audits['total-byte-weight'].numericValue! : null),
    totalRequests: total?.requestCount ?? null,
    byType: (r.resourceSummary ?? []).filter((s) => s.resourceType !== 'total'),
    testConfig: r.testConfig ?? null,
  };
}

function conditionNotes(cur: StoredReport, prev: StoredReport): string[] {
  const notes: string[] = [];
  const a: LhTestConfigDTO | undefined = cur.testConfig;
  const b: LhTestConfigDTO | undefined = prev.testConfig;
  if (cur.lighthouseVersion !== prev.lighthouseVersion) notes.push(`Different Lighthouse versions (${prev.lighthouseVersion} → ${cur.lighthouseVersion}); scoring can change between versions.`);
  if (!a || !b) notes.push('The earlier report was made before test conditions were recorded, so they cannot be compared.');
  else {
    const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
    if (!same([a.throttlingMethod, a.rttMs, a.throughputKbps, a.cpuSlowdownMultiplier], [b.throttlingMethod, b.rttMs, b.throughputKbps, b.cpuSlowdownMultiplier]))
      notes.push('Network or CPU throttling settings differ between the two tests.');
    if (!same(a.screen, b.screen)) notes.push('The emulated screen differs between the two tests.');
    if (a.benchmarkIndex && b.benchmarkIndex && Math.abs(a.benchmarkIndex - b.benchmarkIndex) / Math.max(a.benchmarkIndex, b.benchmarkIndex) > 0.25)
      notes.push(`The test machine's measured CPU speed differed by more than 25% (benchmark ${Math.round(b.benchmarkIndex)} → ${Math.round(a.benchmarkIndex)}), which changes CPU-bound metrics.`);
    if (a.runs !== b.runs) notes.push(`Different number of runs behind the median (${b.runs} → ${a.runs}).`);
  }
  notes.push('Lab results vary from run to run with network conditions; changes of a few points or a few hundred milliseconds may not be meaningful.');
  return notes;
}

/** Performance audits that can pass or fail (not informative/manual ones). */
function ratedPerfAudits(r: StoredReport): Map<string, { title: string; failing: boolean; displayValue: string | null }> {
  const perf = r.categories.find((c) => c.id === 'performance');
  const out = new Map<string, { title: string; failing: boolean; displayValue: string | null }>();
  for (const id of perf?.groups.flatMap((g) => g.auditIds) ?? []) {
    const a = r.audits[id];
    if (!a || a.score === null || !['numeric', 'binary', 'metricSavings'].includes(a.scoreDisplayMode)) continue;
    out.set(id, { title: a.title, failing: a.score < 0.9, displayValue: a.displayValue ?? null });
  }
  return out;
}

export function compareReports(
  viewport: ViewportName,
  pageUrl: string,
  current: { report: StoredReport; scanId: string; finishedAt: string | null },
  previous: { report: StoredReport; scanId: string; finishedAt: string | null } | null,
): LhComparisonDTO {
  const cur = snapshotOf(current.report, current.scanId, current.finishedAt);
  if (!previous) return { viewport, pageUrl, current: cur, previous: null, conditionNotes: [], newlyFailing: [], nowPassing: [] };
  const now = ratedPerfAudits(current.report);
  const before = ratedPerfAudits(previous.report);
  const newlyFailing: LhComparisonDTO['newlyFailing'] = [];
  const nowPassing: LhComparisonDTO['nowPassing'] = [];
  for (const [id, a] of now) {
    const b = before.get(id);
    if (!b) continue; // not measured both times: no claim either way
    if (a.failing && !b.failing) newlyFailing.push({ id, title: a.title, displayValue: a.displayValue });
    if (!a.failing && b.failing) nowPassing.push({ id, title: a.title, displayValue: a.displayValue });
  }
  return {
    viewport,
    pageUrl,
    current: cur,
    previous: snapshotOf(previous.report, previous.scanId, previous.finishedAt),
    conditionNotes: conditionNotes(current.report, previous.report),
    newlyFailing,
    nowPassing,
  };
}
