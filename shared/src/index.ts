// Domain vocabulary and API shapes shared by the server and the web client.
// Anything a user sees as a label (severity, status, category) is defined once here.

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Informational',
};

export const ISSUE_STATUSES = ['open', 'reopened', 'needs_review', 'inconclusive', 'not_tested', 'resolved'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: 'Confirmed',
  reopened: 'Reopened',
  needs_review: 'Needs Manual Review',
  inconclusive: 'Pending Verification',
  not_tested: 'Not Tested',
  resolved: 'Resolved',
};

/** Statuses that count as "still needs attention" in summaries. */
export const ACTIVE_ISSUE_STATUSES: IssueStatus[] = ['open', 'reopened', 'needs_review', 'inconclusive', 'not_tested'];

export const CATEGORIES = [
  'availability',
  'html',
  'accessibility',
  'seo',
  'security',
  'links',
  'images',
  'javascript',
  'responsive',
  'visual',
  'performance',
  'forms',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_INFO: Record<Category, { label: string; description: string }> = {
  availability: { label: 'Availability', description: 'HTTP responses, redirects, timeouts and connection failures.' },
  html: { label: 'HTML structure', description: 'Document metadata, language, headings and semantic structure.' },
  accessibility: { label: 'Accessibility', description: 'Automated WCAG rules run with axe-core in a real browser.' },
  seo: { label: 'SEO', description: 'Titles, descriptions, canonicals, robots directives and structured data syntax.' },
  security: { label: 'Security & configuration', description: 'HTTPS, mixed content and publicly visible security headers.' },
  links: { label: 'Links', description: 'Broken internal and permitted external links (verified by re-request), plus working links that go through a redirect.' },
  images: { label: 'Images', description: 'Broken images, missing dimensions and oversized image delivery.' },
  javascript: { label: 'JavaScript', description: 'Console errors, uncaught exceptions and failed network requests.' },
  responsive: { label: 'Responsive layout', description: 'Horizontal overflow and off-screen elements at each viewport.' },
  visual: { label: 'Visual comparison', description: 'Screenshot differences against a saved baseline.' },
  performance: { label: 'Performance', description: 'Lighthouse lab metrics and opportunities.' },
  forms: { label: 'Forms', description: 'Configured, non-submitting checks of public forms.' },
};

export const SCAN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export type ScanKind = 'quick' | 'full' | 'verification';
export type ViewportName = 'desktop' | 'mobile';

export const VIEWPORTS: Record<ViewportName, { width: number; height: number; label: string; mobile: boolean }> = {
  desktop: { width: 1366, height: 900, label: 'Desktop 1366×900', mobile: false },
  mobile: { width: 390, height: 844, label: 'Mobile 390×844', mobile: true },
};

/** completed: ran on everything in scope. partial: ran on some pages. failed: could not run. skipped: not selected. unavailable: not supported in this deployment. */
export const CHECK_RUN_STATUSES = ['completed', 'partial', 'failed', 'skipped', 'unavailable'] as const;
export type CheckRunStatus = (typeof CHECK_RUN_STATUSES)[number];

export interface ScanConfig {
  kind: ScanKind;
  viewports: ViewportName[];
  maxPages: number;
  pageMode: 'discover' | 'selected';
  selectedUrls: string[];
  checks: Category[];
  baselineId: string | null;
  visualCompare: boolean;
  /** Percentage of pixels allowed to differ before a visual change is reported. */
  visualThresholdPct: number;
  /** Per-pixel colour tolerance passed to pixelmatch (0–1). */
  pixelTolerance: number;
  /** CSS selectors hidden before screenshots (dynamic content). */
  ignoreSelectors: string[];
  checkExternalLinks: boolean;
  /** Issues this scan was started to verify (verification scans only). */
  verifyIssueIds: string[];
}

export const QUICK_SCAN_CHECKS: Category[] = ['availability', 'html', 'seo', 'accessibility', 'security', 'javascript', 'images'];
export const FULL_SCAN_CHECKS: Category[] = [
  'availability',
  'html',
  'seo',
  'accessibility',
  'security',
  'javascript',
  'images',
  'links',
  'responsive',
  'visual',
  'performance',
];

// ---------------------------------------------------------------- monitoring (Web Watcher catalogue)

export const WATCHER_KEYS = [
  'uptime',
  'tls',
  'https',
  'headers',
  'indexing',
  'mixed_content',
  'dns',
  'domain',
  'defacement',
  'scripts',
  'browser',
  'exposure',
  'audit',
] as const;
export type WatcherKey = (typeof WATCHER_KEYS)[number];
/** Heartbeat monitors have a single watcher of their own. */
export type CheckKey = WatcherKey | 'heartbeat';

export interface WatcherInfo {
  label: string;
  description: string;
  /** Default cadence in seconds; null = the monitor's own interval. */
  defaultInterval: number | null;
  tier: 'free' | 'paid';
  /** Catalogue references (R-numbers) for traceability. */
  refs: string;
  /** Needs an explicit per-monitor authorisation before it runs. */
  optIn?: boolean;
}

export const WATCHERS: Record<CheckKey, WatcherInfo> = {
  uptime: { label: 'Uptime & response time', description: 'Status code, response and first-byte time with re-samples, redirect timing, keyword present/absent and fatal-error pages.', defaultInterval: null, tier: 'free', refs: 'R1, R1b, keyword' },
  tls: { label: 'SSL/TLS certificate', description: 'Certificate validity, chain, expiry warning at 14 days, TLS 1.2 or newer. Retries before alerting.', defaultInterval: 3600, tier: 'free', refs: 'R2' },
  https: { label: 'HTTPS redirect & canonical host', description: 'http:// redirects to https://, and www and apex agree on one host.', defaultInterval: 86400, tier: 'free', refs: 'R3, R3b' },
  headers: { label: 'Security headers', description: 'HSTS, X-Content-Type-Options, framing protection, Referrer-Policy, version disclosure and PHP end-of-life.', defaultInterval: 86400, tier: 'paid', refs: 'R4, R4b, R14' },
  indexing: { label: 'Search indexing', description: 'robots.txt by user-agent group, homepage noindex, sitemap presence and robots.txt changes.', defaultInterval: 86400, tier: 'paid', refs: 'R13, robots.txt diff' },
  mixed_content: { label: 'Mixed content', description: 'Insecure http:// subresources (src, srcset, CSS url()) on HTTPS pages.', defaultInterval: 86400, tier: 'paid', refs: 'R17' },
  dns: { label: 'DNS & mail records', description: 'MX, SPF, DMARC and CAA records, and alerts when A, AAAA, MX or NS records change.', defaultInterval: 86400, tier: 'paid', refs: 'R20, CAA, DNS change' },
  domain: { label: 'Domain expiry', description: 'Registration expiry from RDAP (WHOIS for .ie).', defaultInterval: 86400, tier: 'paid', refs: 'EXP' },
  defacement: { label: 'Defacement canary', description: 'Alerts when the homepage title or main heading changes from the accepted baseline.', defaultInterval: 3600, tier: 'paid', refs: 'R16' },
  scripts: { label: 'Third-party scripts', description: 'Alerts when a new external script domain appears (card skimmers, injected trackers).', defaultInterval: 86400, tier: 'paid', refs: 'Script inventory' },
  browser: { label: 'Real-browser render', description: 'Loads the page in Chrome: blank pages, JavaScript errors and failed CSS, JS, image or font requests.', defaultInterval: 86400, tier: 'paid', refs: 'Real-browser render, console errors, failed assets' },
  exposure: { label: 'Exposed files', description: 'Backups, .env, .git, phpinfo and directory listings, confirmed by content. These probes look like attacks, so this needs your explicit authorisation.', defaultInterval: 604800, tier: 'paid', refs: 'R6, R7, R8', optIn: true },
  audit: { label: 'Scheduled full audit', description: 'Weekly full audit: accessibility (WCAG), SEO, links, images, performance and visual changes against your baseline.', defaultInterval: 604800, tier: 'paid', refs: 'Accessibility, visual regression, R19, R21' },
  heartbeat: { label: 'Heartbeat', description: 'Your cron job or backup calls a private URL; we alert when it goes quiet.', defaultInterval: 60, tier: 'free', refs: 'Heartbeat monitor' },
};

export const FREE_WATCHERS: WatcherKey[] = ['uptime', 'tls', 'https'];

export const CHECK_STATUSES = ['up', 'warning', 'down', 'not_assessed', 'error'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  up: 'Up',
  warning: 'Warning',
  down: 'Down',
  not_assessed: 'Not assessed',
  error: 'Monitoring error',
};

export const PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { p1: 'P1 · Act now', p2: 'P2 · Urgent', p3: 'P3 · Fix soon', p4: 'P4 · Housekeeping' };

export interface WatcherStateDTO {
  key: CheckKey;
  enabled: boolean;
  entitled: boolean;
  intervalSeconds: number;
  lastStatus: CheckStatus | null;
  lastSeverity: Priority | null;
  lastSummary: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface MonitorDTO {
  id: string;
  kind: 'website' | 'heartbeat';
  name: string;
  url: string | null;
  enabled: boolean;
  intervalSeconds: number;
  keyword: string | null;
  keywordMode: 'present' | 'absent' | null;
  moneyPage: boolean;
  exposureAuthorised: boolean;
  heartbeatUrl: string | null;
  heartbeatGraceSeconds: number;
  lastHeartbeatAt: string | null;
  status: CheckStatus | 'paused' | 'pending';
  lastCheckedAt: string | null;
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
  avgResponseMs24h: number | null;
  openIncidents: number;
  watchers: WatcherStateDTO[];
  createdAt: string;
}

export interface CheckResultDTO {
  id: number;
  checkKey: CheckKey;
  status: CheckStatus;
  severity: Priority | null;
  summary: string;
  detail: Record<string, unknown>;
  responseMs: number | null;
  ttfbMs: number | null;
  httpStatus: number | null;
  attempts: number;
  startedAt: string;
}

export interface IncidentDTO {
  id: string;
  monitorId: string;
  monitorName: string;
  monitorUrl: string | null;
  checkKey: CheckKey;
  severity: Priority;
  title: string;
  status: 'open' | 'resolved';
  openedAt: string;
  resolvedAt: string | null;
  lastSeenAt: string;
  occurrences: number;
  acknowledgedAt: string | null;
  detail: Record<string, unknown>;
}

export interface AlertContactDTO {
  id: string;
  channel: 'email';
  target: string;
  enabled: boolean;
}

export interface AlertDeliveryDTO {
  id: string;
  incidentId: string | null;
  incidentTitle: string | null;
  target: string;
  event: 'opened' | 'resolved' | 'test';
  status: 'sent' | 'failed' | 'skipped';
  error: string | null;
  createdAt: string;
}

export interface MonitoringOverviewDTO {
  monitors: number;
  up: number;
  down: number;
  warning: number;
  notAssessed: number;
  paused: number;
  openIncidents: number;
  uptime30d: number | null;
  scheduler: { lastBeatAt: string | null; healthy: boolean };
  emailConfigured: boolean;
}

// ---------------------------------------------------------------- plans

export type PlanId = 'free' | 'pro' | 'agency';

export interface PlanLimits {
  id: PlanId;
  name: string;
  scansPerMonth: number;
  maxPagesPerScan: number;
  maxWebsites: number;
  visualComparison: boolean;
  pdfExport: boolean;
  aiRequestsPerMonth: number;
  /** Days of scan history visible; older history is still deleted by retention rules. */
  historyDays: number;
  maxMembers: number;
  brandedReports: boolean;
  /** Scheduled monitoring. */
  maxMonitors: number;
  minIntervalSeconds: number;
  watchers: WatcherKey[];
  monitorHistoryDays: number;
  maxAlertContacts: number;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: 'free',
    name: 'Free',
    scansPerMonth: 20,
    maxPagesPerScan: 100,
    maxWebsites: 3,
    visualComparison: false,
    pdfExport: true,
    aiRequestsPerMonth: 20,
    historyDays: 30,
    maxMembers: 1,
    brandedReports: false,
    maxMonitors: 3,
    minIntervalSeconds: 300,
    watchers: FREE_WATCHERS,
    monitorHistoryDays: 7,
    maxAlertContacts: 1,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    scansPerMonth: 300,
    maxPagesPerScan: 1000,
    maxWebsites: 15,
    visualComparison: true,
    pdfExport: true,
    aiRequestsPerMonth: 300,
    historyDays: 365,
    maxMembers: 3,
    brandedReports: false,
    maxMonitors: 25,
    minIntervalSeconds: 60,
    watchers: [...WATCHER_KEYS],
    monitorHistoryDays: 90,
    maxAlertContacts: 5,
  },
  agency: {
    id: 'agency',
    name: 'Agency',
    scansPerMonth: 2000,
    maxPagesPerScan: 1000,
    maxWebsites: 100,
    visualComparison: true,
    pdfExport: true,
    aiRequestsPerMonth: 2000,
    historyDays: 730,
    maxMembers: 25,
    brandedReports: true,
    maxMonitors: 150,
    minIntervalSeconds: 60,
    watchers: [...WATCHER_KEYS],
    monitorHistoryDays: 365,
    maxAlertContacts: 20,
  },
};

// ---------------------------------------------------------------- API shapes

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface WorkspaceDTO {
  id: string;
  name: string;
  plan: PlanId;
  role: 'owner' | 'admin' | 'member';
  retentionDays: number;
  aiEnabled: boolean;
  reportBrandName: string | null;
}

export interface SessionDTO {
  user: UserDTO;
  workspace: WorkspaceDTO;
  csrfToken: string;
}

export interface WebsiteDTO {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: string;
  lastScanAt: string | null;
  lastScanStatus: ScanStatus | null;
  activeIssues: number;
  scanCount: number;
}

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface ScanSummary {
  pagesDiscovered: number;
  pagesScanned: number;
  pagesFailed: number;
  findings: number;
  issuesDetected: number;
  newIssues: number;
  reopenedIssues: number;
  resolvedIssues: number;
  bySeverity: SeverityCounts;
  byCategory: Partial<Record<Category, number>>;
  /** Scope notes recorded during the scan (skipped pages, limits reached, …). */
  notes?: string[];
  /** Issues by verification state (scans from 2026-10-28 on). */
  confirmedIssues?: number;
  needsManualReview?: number;
  pendingVerification?: number;
  /** Detections that were re-checked before reporting. */
  verification?: {
    checked: number;
    confirmed: number;
    pending: number;
    /** Detections the re-check showed to be wrong — listed for transparency, never reported as defects. */
    dismissed: { rule: string; item: string; reason: string }[];
  };
  /** WordPress and plugin information (null when the scan found no WordPress markers or no page loaded). */
  wordpress?: WordPressReportDTO | null;
}

// ---------------------------------------------------------------- Lighthouse report (PageSpeed-style)

export type LhValue = string | number | boolean | null | { type: 'node'; snippet?: string; selector?: string; label?: string } | { type: 'url' | 'code' | 'source'; value: string };

export interface LhDetails {
  type: string;
  headings?: { key: string; label: string; valueType?: string }[];
  items?: Record<string, LhValue>[];
  /** Number of items before trimming. */
  totalItems?: number;
  /** Nested tables (Lighthouse "list" details used by insights). */
  lists?: LhDetails[];
}

export interface LhAuditDTO {
  id: string;
  title: string;
  /** Markdown with [links](https://…) and `code`. */
  description: string;
  score: number | null;
  scoreDisplayMode: 'numeric' | 'binary' | 'informative' | 'manual' | 'notApplicable' | 'error' | 'metricSavings' | string;
  displayValue?: string;
  numericValue?: number;
  metricSavings?: Record<string, number>;
  details?: LhDetails;
  warnings?: string[];
  errorMessage?: string;
}

export interface LhGroupDTO {
  id: string;
  title: string;
  description?: string;
  auditIds: string[];
}

export interface LhCategoryDTO {
  id: string;
  title: string;
  description?: string;
  score: number | null;
  /** Audit ids in this category, by group; audits without a group are under "". */
  groups: LhGroupDTO[];
  /** Performance only: metric audit id → audits that affect it (for the "Show audits relevant to" filter). */
  relevantAudits?: Record<string, string[]>;
}

export interface LighthouseReportDTO {
  pageUrl: string;
  viewport: ViewportName;
  lighthouseVersion: string;
  fetchTime: string;
  formFactor: 'mobile' | 'desktop';
  /** e.g. "Emulated Moto G Power with Lighthouse 13 · Slow 4G throttling". */
  environment: string[];
  categories: LhCategoryDTO[];
  audits: Record<string, LhAuditDTO>;
  finalScreenshot: string | null;
  filmstrip: { timingMs: number; data: string }[];
  // Resource-level data (scans from 30 October 2026 on; absent in older reports).
  /** Network requests Lighthouse recorded (up to 300, heaviest kept when there are more). */
  resources?: LhResourceDTO[];
  /** All requests Lighthouse recorded, before the cap above. */
  resourcesTotal?: number;
  resourceSummary?: LhResourceSummaryDTO[];
  thirdParties?: LhThirdPartyDTO[];
  /** Lighthouse's own per-file findings (unused bytes, render-blocking, cache lifetime …), keyed by URL. */
  findingsByUrl?: Record<string, LhResourceFindingDTO[]>;
  testConfig?: LhTestConfigDTO;
}

export interface LhResourceDTO {
  url: string;
  resourceType: string;
  mimeType: string | null;
  statusCode: number | null;
  /** Bytes over the network (compressed); null when Lighthouse did not record it. */
  transferSize: number | null;
  /** Decoded size of the body. */
  resourceSize: number | null;
  /** From request start to end under the test's throttling (observed, not simulated). */
  durationMs: number | null;
  startMs: number | null;
  priority: string | null;
  protocol: string | null;
  fromCache: boolean | null;
  /** Owner of the origin as Lighthouse identifies it (site name, "Google Tag Manager" …). */
  entity: string | null;
  thirdParty: boolean | null;
}

export interface LhResourceSummaryDTO {
  resourceType: string;
  label: string;
  requestCount: number;
  transferSize: number;
}

export interface LhThirdPartyDTO {
  entity: string;
  category: string | null;
  transferSize: number | null;
  mainThreadMs: number | null;
}

export interface LhResourceFindingDTO {
  auditId: string;
  label: string;
  wastedBytes: number | null;
  wastedMs: number | null;
  totalBytes: number | null;
  cacheLifetimeMs: number | null;
  durationMs: number | null;
}

/** How the lab test was run — every value as Lighthouse reports it. */
export interface LhTestConfigDTO {
  formFactor: 'mobile' | 'desktop';
  screen: { width: number | null; height: number | null; deviceScaleFactor: number | null; mobile: boolean } | null;
  /** "simulate" = Lighthouse's Lantern model applied to an unthrottled load; "devtools"/"provided" otherwise. */
  throttlingMethod: string | null;
  rttMs: number | null;
  throughputKbps: number | null;
  cpuSlowdownMultiplier: number | null;
  /** Lighthouse's measure of the test machine's CPU speed (higher is faster). */
  benchmarkIndex: number | null;
  networkUserAgent: string | null;
  hostUserAgent: string | null;
  /** Lighthouse runs behind this report (the median run is shown). */
  runs: number;
}

/** A Lighthouse report compared with the same page and device in an earlier scan of the website. */
export interface LhComparisonDTO {
  viewport: ViewportName;
  pageUrl: string;
  current: LhSnapshotDTO;
  previous: LhSnapshotDTO | null;
  /** Differences in how the two tests were run that can change results by themselves. */
  conditionNotes: string[];
  /** Lighthouse performance audits that fail now but passed before, and the reverse. */
  newlyFailing: { id: string; title: string; displayValue: string | null }[];
  nowPassing: { id: string; title: string; displayValue: string | null }[];
}

export interface LhSnapshotDTO {
  scanId: string;
  scanFinishedAt: string | null;
  fetchTime: string;
  lighthouseVersion: string;
  scores: Record<string, number | null>;
  /** Lab metric values (ms, CLS unitless) keyed by audit id. */
  metrics: Record<string, number | null>;
  totalTransferSize: number | null;
  totalRequests: number | null;
  byType: LhResourceSummaryDTO[];
  testConfig: LhTestConfigDTO | null;
}

/** One entry per page and viewport Lighthouse ran on. */
export interface LighthouseIndexDTO {
  pageUrl: string;
  viewport: ViewportName;
  scores: Record<string, number | null>;
}

// ---------------------------------------------------------------- real-user (field) data: Chrome UX Report

export type FieldMetricId = 'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb';

/** Core Web Vitals thresholds (good ≤ first, poor > second), as used by PageSpeed Insights. */
export const FIELD_THRESHOLDS: Record<FieldMetricId, [number, number]> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
};

export interface FieldMetricDTO {
  /** 75th percentile: milliseconds, or the unitless layout-shift score for CLS. */
  p75: number;
  /** Share of page loads that were good / needed improvement / poor (each 0–1). */
  distribution: [number, number, number];
}

export interface FieldRecordDTO {
  metrics: Partial<Record<FieldMetricId, FieldMetricDTO>>;
  /** The 28-day window the data covers (YYYY-MM-DD). */
  firstDate: string;
  lastDate: string;
}

export interface FieldDataDTO {
  /** ok: Google answered (a record can still be null = not enough traffic); not_configured: no API key; unavailable: the lookup failed. */
  status: 'ok' | 'not_configured' | 'unavailable';
  message: string | null;
  pageUrl: string;
  origin: string;
  fetchedAt: string | null;
  phone: { url: FieldRecordDTO | null; origin: FieldRecordDTO | null };
  desktop: { url: FieldRecordDTO | null; origin: FieldRecordDTO | null };
}

// ---------------------------------------------------------------- WordPress and plugin information

export type WpRisk = 'critical' | 'high' | 'medium' | 'low' | 'none' | 'unknown';
export type WpConfidence = 'high' | 'medium' | 'low';

export interface WpVulnerabilityDTO {
  title: string;
  cve: string | null;
  cvssScore: number | null;
  severity: string | null;
  /** Version range it affects, e.g. "< 5.3.2". */
  affects: string;
  fixedIn: string | null;
  unfixed: boolean;
  references: string[];
}

export interface WpPluginDTO {
  slug: string;
  name: string | null;
  installedVersion: string | null;
  versionSource: string | null;
  versionConfidence: WpConfidence | null;
  /** Latest version on WordPress.org; null when not listed there or the lookup failed. */
  latestVersion: string | null;
  /** true: listed on WordPress.org · false: not listed (premium/custom) · 'closed': closed by WordPress.org · null: lookup failed. */
  wordpressOrg: true | false | 'closed' | null;
  closedReason: string | null;
  lastUpdated: string | null;
  updateStatus: 'up_to_date' | 'update_available' | 'unknown';
  risk: WpRisk;
  riskReason: string;
  vulnLookup: 'ok' | 'failed';
  vulnerabilities: WpVulnerabilityDTO[];
  /** Files on the site that identified the plugin. */
  evidence: string[];
}

export interface WordPressReportDTO {
  detected: boolean;
  markers: string[];
  core: {
    version: string | null;
    versionSource: string | null;
    confidence: WpConfidence | null;
    latestVersion: string | null;
    /** From WordPress.org's release list: latest, outdated, insecure; unknown when not verifiable. */
    status: 'latest' | 'outdated' | 'insecure' | 'unknown';
    vulnLookup: 'ok' | 'failed' | 'skipped';
    vulnerabilities: WpVulnerabilityDTO[];
    risk: WpRisk;
  } | null;
  themes: { slug: string; name: string | null; version: string | null; latestVersion: string | null }[];
  /** The total number of installed plugins cannot be read from outside the site; always null. */
  totalInstalledPlugins: null;
  detectedPlugins: number;
  plugins: WpPluginDTO[];
  sources: string[];
  limitations: string[];
  checkedAt: string;
  /** Page-delivery indicators on the home page (scans from 30 October 2026 on). */
  delivery?: WpDeliveryDTO;
}

export interface WpDeliveryIndicatorDTO {
  kind: 'server-cache' | 'page-cache' | 'optimisation';
  label: string;
  /** hit/miss when the header says so; present = visible but not a hit/miss value. */
  state: 'hit' | 'miss' | 'present';
  /** The exact header or HTML text it came from. */
  evidence: string;
}

export interface WpDeliveryDTO {
  indicators: WpDeliveryIndicatorDTO[];
  /** Content-Encoding of the HTML (br, gzip, zstd); null = sent uncompressed. */
  htmlCompression: string | null;
  cacheControl: string | null;
  note: string;
}

export interface ScanDTO {
  id: string;
  websiteId: string;
  websiteName: string;
  websiteUrl: string;
  status: ScanStatus;
  kind: ScanKind;
  config: ScanConfig;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  progress: { phase: string; done: number; total: number; message: string } | null;
  summary: ScanSummary | null;
  isBaseline: boolean;
}

export interface CheckRunDTO {
  category: Category;
  status: CheckRunStatus;
  pagesTested: number;
  detail: string;
  durationMs: number | null;
}

export interface ScanPageDTO {
  id: string;
  url: string;
  finalUrl: string | null;
  statusCode: number | null;
  loadMs: number | null;
  title: string | null;
  error: string | null;
  source: string;
  findings: number;
  screenshots: ScreenshotDTO[];
}

export interface ScreenshotDTO {
  id: string;
  viewport: ViewportName;
  width: number;
  height: number;
  url: string;
}

export interface EvidenceItem {
  label: string;
  value: string;
  /** Rendered monospace when true (selectors, HTML, headers). */
  code?: boolean;
}

export interface FindingDTO {
  id: string;
  scanId: string;
  pageUrl: string;
  viewport: ViewportName | null;
  evidence: EvidenceItem[];
  detectedAt: string;
}

export interface Remediation {
  whyItMatters: string;
  steps: string[];
  codeExample: { language: string; before?: string; after: string } | null;
  verify: string[];
  manualReview: string | null;
  references: { label: string; url: string }[];
}

export interface IssueDTO {
  id: string;
  ruleId: string;
  title: string;
  category: Category;
  severity: Severity;
  status: IssueStatus;
  websiteId: string;
  websiteName: string;
  affectedUrls: string[];
  affectedCount: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  lastScanId: string;
  wcag: string[];
}

export interface IssueEventDTO {
  id: string;
  scanId: string | null;
  fromStatus: IssueStatus | null;
  toStatus: IssueStatus;
  reason: string;
  createdAt: string;
}

export interface IssueDetailDTO extends IssueDTO {
  description: string;
  detectionMethod: string;
  confidence: 'high' | 'medium' | 'low';
  limitations: string | null;
  severityReason: string;
  remediation: Remediation;
  technical: { label: string; value: string }[];
  findings: FindingDTO[];
  events: IssueEventDTO[];
  aiAvailable: boolean;
}

export interface OverviewDTO {
  websites: number;
  scans: number;
  criticalIssues: number;
  highIssues: number;
  awaitingReview: number;
  resolvedIssues: number;
  activeIssues: number;
  recentScans: ScanDTO[];
  usage: UsageDTO;
}

export interface UsageDTO {
  plan: PlanLimits;
  periodStart: string;
  scansUsed: number;
  aiRequestsUsed: number;
  websitesUsed: number;
  monitorsUsed: number;
}

export interface BaselineDTO {
  id: string;
  name: string;
  websiteId: string;
  websiteName: string;
  scanId: string;
  createdAt: string;
  scanFinishedAt: string | null;
  viewports: ViewportName[];
  screenshotCount: number;
}

export interface VisualComparisonDTO {
  id: string;
  pageUrl: string;
  viewport: ViewportName;
  status: 'match' | 'changed' | 'incomparable' | 'failed';
  diffRatio: number | null;
  thresholdPct: number;
  pixelTolerance: number;
  baselineImage: string | null;
  currentImage: string | null;
  diffImage: string | null;
  note: string | null;
}

export interface LabMetricsDTO {
  tool: string;
  formFactor: 'desktop' | 'mobile';
  performanceScore: number | null;
  lcpMs: number | null;
  fcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  speedIndexMs: number | null;
  measuredAt: string;
}

export interface ReportPageDTO extends ScanPageDTO {
  labMetrics: Partial<Record<ViewportName, LabMetricsDTO>>;
}

export interface ReportIssueDTO extends IssueDTO {
  description: string;
  detectionMethod: string;
  confidence: 'high' | 'medium' | 'low';
  limitations: string | null;
  severityReason: string;
  remediation: Remediation;
  evidence: FindingDTO[];
  changeInScan: 'new' | 'reopened' | 'existing';
}

export interface ReportDTO {
  generatedAt: string;
  brandName: string | null;
  workspaceName: string;
  scan: ScanDTO;
  checkRuns: CheckRunDTO[];
  pages: ReportPageDTO[];
  /** Confirmed defects only. */
  severity: SeverityCounts;
  verification: { confirmed: number; needsManualReview: number; pendingVerification: number };
  byCategory: { category: Category; total: number; bySeverity: SeverityCounts }[];
  topPriorities: ReportIssueDTO[];
  issues: ReportIssueDTO[];
  resolved: IssueDTO[];
  reopened: IssueDTO[];
  previous: { scanId: string; finishedAt: string | null; summary: ScanSummary | null } | null;
  visual: VisualComparisonDTO[];
  limitations: string[];
  notCompleted: CheckRunDTO[];
  aiSummary: { content: string; provider: string; model: string; createdAt: string } | null;
  /** Home-page Lighthouse summary per device (absent when no Lighthouse report was stored). */
  performance?: PerformanceSummaryDTO[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function emptySeverityCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

// ---------------------------------------------------------------- WordPress front-end assets (from measured requests)

export interface WpAssetGroupDTO {
  kind: 'plugin' | 'theme' | 'core';
  /** Folder name under wp-content/plugins or wp-content/themes; "wp-includes" for core. */
  slug: string;
  requests: number;
  transferSize: number;
  resourceSize: number;
  urls: string[];
}

/**
 * Groups measured requests by the WordPress folder they were served from. This attributes files by
 * location only: it says which plugin's files the page loaded, not that the plugin made the page slow.
 */
export function groupWordPressAssets(resources: LhResourceDTO[]): WpAssetGroupDTO[] {
  const groups = new Map<string, WpAssetGroupDTO>();
  for (const r of resources) {
    let path: string;
    try {
      path = new URL(r.url).pathname;
    } catch {
      continue;
    }
    const m = /\/wp-content\/(plugins|themes)\/([^/]+)\//i.exec(path);
    const kind = m ? (m[1].toLowerCase() === 'plugins' ? 'plugin' : 'theme') : /\/wp-includes\//i.test(path) ? 'core' : null;
    if (!kind) continue;
    const slug = m ? decodeURIComponent(m[2]).toLowerCase() : 'wp-includes';
    const key = `${kind}:${slug}`;
    const g = groups.get(key) ?? { kind, slug, requests: 0, transferSize: 0, resourceSize: 0, urls: [] };
    g.requests++;
    g.transferSize += r.transferSize ?? 0;
    g.resourceSize += r.resourceSize ?? 0;
    if (g.urls.length < 20) g.urls.push(r.url);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.transferSize - a.transferSize);
}

export interface DuplicateAssetDTO {
  /** File name compared (lower case, without query string and ".min"). */
  name: string;
  urls: string[];
  transferSize: number;
}

/**
 * Scripts or stylesheets with the same file name loaded from more than one address (for example jQuery
 * from both WordPress and a CDN). Same name is a strong hint, not proof, that the content is duplicated.
 */
export function findDuplicateAssets(resources: LhResourceDTO[]): DuplicateAssetDTO[] {
  const byName = new Map<string, LhResourceDTO[]>();
  for (const r of resources) {
    if (r.resourceType !== 'Script' && r.resourceType !== 'Stylesheet') continue;
    let file: string;
    try {
      file = new URL(r.url).pathname.split('/').pop() ?? '';
    } catch {
      continue;
    }
    const name = file.toLowerCase().replace(/\.min(?=\.(js|css)$)/, '');
    // Generic names (index.js, main.css, style.css …) say nothing about duplication.
    if (!/\.(js|css)$/.test(name) || /^(index|main|style|script|app|bundle|common|custom|frontend|scripts|styles)\.(js|css)$/.test(name)) continue;
    byName.set(name, [...(byName.get(name) ?? []), r]);
  }
  return [...byName.entries()]
    .map(([name, list]) => ({ name, urls: [...new Set(list.map((r) => r.url))], transferSize: list.reduce((s, r) => s + (r.transferSize ?? 0), 0) }))
    .filter((d) => d.urls.length > 1)
    .sort((a, b) => b.transferSize - a.transferSize);
}

/** The report's performance section: one entry per device for the home page's Lighthouse run. */
export interface PerformanceSummaryDTO {
  viewport: ViewportName;
  pageUrl: string;
  scores: Record<string, number | null>;
  metrics: { id: string; title: string; displayValue: string | null; score: number | null }[];
  /** Highest-impact failing performance audits, with Lighthouse's own savings estimates. */
  topIssues: { title: string; displayValue: string | null; lighthouseSavings: string | null }[];
  totalTransferSize: number | null;
  totalRequests: number | null;
  /** One line describing how the lab test was run. */
  conditions: string;
  comparison: {
    previousScanId: string;
    previousFinishedAt: string | null;
    previousPerformance: number | null;
    previousLcpMs: number | null;
    currentLcpMs: number | null;
    previousTransferSize: number | null;
    newlyFailing: string[];
    nowPassing: string[];
    notes: string[];
  } | null;
}
