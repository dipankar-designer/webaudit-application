// Real-user (field) Core Web Vitals from the Chrome UX Report API — the "Discover what your real
// users are experiencing" data at the top of PageSpeed Insights. Server-side only: the API key never
// reaches the browser. A 404 from Google is a real answer ("not enough traffic"), not an error.

import type { FieldDataDTO, FieldMetricDTO, FieldMetricId, FieldRecordDTO } from '@wpcg/shared';
import { config } from '../config.js';

const METRICS: Record<FieldMetricId, string> = {
  lcp: 'largest_contentful_paint',
  inp: 'interaction_to_next_paint',
  cls: 'cumulative_layout_shift',
  fcp: 'first_contentful_paint',
  ttfb: 'experimental_time_to_first_byte',
};

interface CruxDate {
  year: number;
  month: number;
  day: number;
}
interface CruxMetric {
  histogram?: { start: number | string; end?: number | string; density?: number }[];
  percentiles?: { p75?: number | string };
}
interface CruxResponse {
  record?: { metrics?: Record<string, CruxMetric>; collectionPeriod?: { firstDate: CruxDate; lastDate: CruxDate } };
  error?: { code?: number; message?: string; status?: string };
}

export class CruxError extends Error {}

const isoDate = (d: CruxDate | undefined) => (d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : '');

/** Converts one CrUX record into the report's shape; metrics Google has no data for are left out. */
export function toFieldRecord(record: NonNullable<CruxResponse['record']>): FieldRecordDTO {
  const metrics: Partial<Record<FieldMetricId, FieldMetricDTO>> = {};
  for (const [id, name] of Object.entries(METRICS) as [FieldMetricId, string][]) {
    const m = record.metrics?.[name];
    const p75 = Number(m?.percentiles?.p75);
    if (!m || !Number.isFinite(p75)) continue;
    // CrUX bins line up with the Core Web Vitals thresholds: good, needs improvement, poor.
    const d = [0, 1, 2].map((i) => Number(m.histogram?.[i]?.density ?? 0)) as [number, number, number];
    const sum = d[0] + d[1] + d[2];
    metrics[id] = { p75, distribution: sum > 0 ? (d.map((x) => x / sum) as [number, number, number]) : d };
  }
  return { metrics, firstDate: isoDate(record.collectionPeriod?.firstDate), lastDate: isoDate(record.collectionPeriod?.lastDate) };
}

async function queryRecord(key: { url: string } | { origin: string }, formFactor: 'PHONE' | 'DESKTOP', signal?: AbortSignal): Promise<FieldRecordDTO | null> {
  const res = await fetch(`${config.CRUX_API_BASE}/records:queryRecord?key=${encodeURIComponent(config.CRUX_API_KEY ?? '')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...key, formFactor, metrics: Object.values(METRICS) }),
    signal: signal ?? AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null; // not enough real-user traffic for this URL/origin and device
  const body = (await res.json().catch(() => ({}))) as CruxResponse;
  if (!res.ok || !body.record) {
    if (res.status === 400 || res.status === 403) throw new CruxError('Google rejected the Chrome UX Report API key. Check CRUX_API_KEY and that the "Chrome UX Report API" is enabled for it.');
    if (res.status === 429) throw new CruxError('The Chrome UX Report API quota is used up for now. Try again later.');
    throw new CruxError(`The Chrome UX Report API did not answer (${res.status}${body.error?.message ? `: ${body.error.message}` : ''}).`);
  }
  return toFieldRecord(body.record);
}

/** Field data for a page and its origin, on phones and desktops (four lookups, run together). */
export async function fetchFieldData(pageUrl: string): Promise<FieldDataDTO> {
  const origin = new URL(pageUrl).origin;
  const base = { pageUrl, origin, fetchedAt: null, phone: { url: null, origin: null }, desktop: { url: null, origin: null } };
  if (!config.CRUX_API_KEY)
    return { ...base, status: 'not_configured', message: 'Real-user data comes from the Chrome UX Report API, which needs a Google API key (CRUX_API_KEY) on the server.' };
  try {
    const [pu, po, du, dor] = await Promise.all([
      queryRecord({ url: pageUrl }, 'PHONE'),
      queryRecord({ origin }, 'PHONE'),
      queryRecord({ url: pageUrl }, 'DESKTOP'),
      queryRecord({ origin }, 'DESKTOP'),
    ]);
    return { ...base, status: 'ok', message: null, fetchedAt: new Date().toISOString(), phone: { url: pu, origin: po }, desktop: { url: du, origin: dor } };
  } catch (e) {
    const message = e instanceof CruxError ? e.message : `The Chrome UX Report could not be reached (${(e as Error).message}).`;
    return { ...base, status: 'unavailable', message };
  }
}
