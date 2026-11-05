import type { CheckKey, CheckStatus, Priority } from '@wpcg/shared';

export interface MonitorRow {
  id: string;
  workspace_id: string;
  website_id: string | null;
  kind: 'website' | 'heartbeat';
  name: string;
  url: string | null;
  enabled: boolean;
  interval_seconds: number;
  keyword: string | null;
  keyword_mode: 'present' | 'absent' | null;
  money_page: boolean;
  exposure_authorised_at: string | null;
  heartbeat_token: string | null;
  heartbeat_grace_seconds: number;
  last_heartbeat_at: string | null;
}

/** What one watcher run concluded. */
export interface CheckOutcome {
  status: CheckStatus;
  /** Required for warning/down; ignored for up/not_assessed. */
  severity?: Priority;
  summary: string;
  detail?: Record<string, unknown>;
  responseMs?: number | null;
  ttfbMs?: number | null;
  httpStatus?: number | null;
  attempts?: number;
  /** New change-detection baseline to store (dns records, script domains, title hash, …). */
  baseline?: unknown;
  /**
   * The finding is an event (e.g. "DNS records changed"), not a lasting condition: its
   * incident closes on the next passing run without a separate recovery alert.
   */
  event?: boolean;
  /**
   * Work is still in progress elsewhere (e.g. a scheduled audit scan): store no result and
   * look again after this many seconds.
   */
  deferSeconds?: number;
}

export interface CheckContext {
  monitor: MonitorRow;
  baseline: unknown;
  signal: AbortSignal;
}

export type CheckRunner = (ctx: CheckContext) => Promise<CheckOutcome>;

export type { CheckKey };
