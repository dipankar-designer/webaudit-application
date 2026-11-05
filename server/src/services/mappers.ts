import type { IssueDTO, IssueStatus, ScanConfig, ScanDTO, ScanKind, ScanStatus, ScanSummary, Severity, Category } from '@wpcg/shared';

export const SCAN_SELECT = `
  SELECT s.id, s.website_id, w.name AS website_name, w.base_url AS website_url, s.status, s.kind, s.config,
         s.created_at, s.started_at, s.finished_at, s.error, s.progress, s.summary,
         EXISTS (SELECT 1 FROM baselines b WHERE b.scan_id = s.id) AS is_baseline
    FROM scans s JOIN websites w ON w.id = s.website_id`;

export interface ScanRow {
  id: string;
  website_id: string;
  website_name: string;
  website_url: string;
  status: ScanStatus;
  kind: ScanKind;
  config: ScanConfig;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  progress: ScanDTO['progress'];
  summary: ScanSummary | null;
  is_baseline: boolean;
}

export function scanDTO(r: ScanRow): ScanDTO {
  return {
    id: r.id,
    websiteId: r.website_id,
    websiteName: r.website_name,
    websiteUrl: r.website_url,
    status: r.status,
    kind: r.kind,
    config: r.config,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.started_at && r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null,
    error: r.error,
    progress: r.progress,
    summary: r.summary,
    isBaseline: r.is_baseline,
  };
}

export const ISSUE_SELECT = `
  SELECT i.id, i.rule_id, i.title, i.category, i.severity, i.status, i.website_id, w.name AS website_name,
         i.first_detected_at, i.last_detected_at, i.last_scan_id, i.wcag,
         COALESCE(a.urls, '{}') AS affected_urls, COALESCE(a.n, 0) AS affected_count
    FROM issues i
    JOIN websites w ON w.id = i.website_id
    LEFT JOIN LATERAL (
      SELECT (array_agg(DISTINCT f.page_url))[1:20] AS urls, count(DISTINCT f.page_url) AS n
        FROM findings f WHERE f.issue_id = i.id AND f.scan_id = i.last_scan_id
    ) a ON true`;

export interface IssueRow {
  id: string;
  rule_id: string;
  title: string;
  category: Category;
  severity: Severity;
  status: IssueStatus;
  website_id: string;
  website_name: string;
  first_detected_at: string;
  last_detected_at: string;
  last_scan_id: string | null;
  wcag: string[];
  affected_urls: string[];
  affected_count: number;
}

export function issueDTO(r: IssueRow): IssueDTO {
  return {
    id: r.id,
    ruleId: r.rule_id,
    title: r.title,
    category: r.category,
    severity: r.severity,
    status: r.status,
    websiteId: r.website_id,
    websiteName: r.website_name,
    affectedUrls: r.affected_urls,
    affectedCount: Number(r.affected_count),
    firstDetectedAt: r.first_detected_at,
    lastDetectedAt: r.last_detected_at,
    lastScanId: r.last_scan_id ?? '',
    wcag: r.wcag,
  };
}

export const SEVERITY_ORDER_SQL = `CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
