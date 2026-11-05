export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - Date.parse(iso);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return rtf.format(-Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(-Math.round(diff / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return rtf.format(-Math.round(diff / 86_400_000), 'day');
  return fmtDate(iso);
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search || '/';
  } catch {
    return url;
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Bytes in KiB/MiB, as Lighthouse and PageSpeed Insights show them. */
export function fmtBytes(b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return '—';
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
  return `${(b / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;
}
