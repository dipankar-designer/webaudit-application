import type { Category, EvidenceItem, Remediation, ScanConfig, Severity, ViewportName } from '@wpcg/shared';

/** How an issue is identified across scans. */
export type RuleScope =
  /** One issue per page (e.g. missing title on /about). */
  | 'page'
  /** One issue per site origin (e.g. missing HSTS header). */
  | 'site'
  /** One issue per external target (e.g. a broken link URL, grouped across all pages that link to it). */
  | 'target';

export interface RuleDef {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  description: string;
  detectionMethod: string;
  confidence: 'high' | 'medium' | 'low';
  limitations: string | null;
  /** Which documented severity rule applies (see docs/SEVERITY.md). */
  severityReason: string;
  scope: RuleScope;
  /** Coverage check key: an issue is only resolved when this check re-ran on the same target. */
  check: string;
  /** Whether results depend on the viewport (responsive rules). */
  viewportDependent: boolean;
  remediation: Remediation;
  wcag?: string[];
  /** Initial status for new detections (needs_review for heuristics, inconclusive for blocked checks). */
  initialStatus?: 'open' | 'needs_review' | 'inconclusive';
}

export interface RawFinding {
  rule: RuleDef;
  /** Page URL, origin or link target depending on rule.scope. */
  target: string;
  /** Page where the evidence was observed. */
  pageUrl: string;
  viewport: ViewportName | null;
  evidence: EvidenceItem[];
  /** Overrides the rule's initial status for this detection (e.g. a link that returned 429). */
  status?: 'open' | 'needs_review' | 'inconclusive';
  /** Overrides the rule's coverage check key (e.g. external vs internal link checks). */
  check?: string;
  technical?: { label: string; value: string }[];
  /**
   * The individual elements (or resources) behind a page-scoped finding. When present, findings are
   * grouped by element across pages: a header link that fails on 40 pages becomes one issue that
   * lists the 40 pages, not 40 issues. `sig` identifies the element (normalised HTML or URL).
   */
  elements?: FindingElement[];
  /** Evidence that describes the rule (shown once above the element list after grouping). */
  headEvidence?: EvidenceItem[];
}

export interface FindingElement {
  sig: string;
  /** What to show: a CSS selector, an image URL, a heading … */
  label: string;
  html?: string;
  note?: string;
}

export interface Viewport {
  name: ViewportName;
  width: number;
  height: number;
  mobile: boolean;
}

export interface ScanJob {
  id: string;
  workspaceId: string;
  websiteId: string;
  baseUrl: string;
  config: ScanConfig;
  plan: { visualComparison: boolean };
}

export function coverageKey(check: string, viewport: ViewportName | null, target: string): string {
  return `${check}|${viewport ?? '-'}|${target}`;
}
