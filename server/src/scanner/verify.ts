// Verification before reporting. Detections that depend on one observation in the browser (an image
// that did not render, a link that failed once) are re-checked with a fresh request:
//
//   reproduced failure            → kept as a confirmed defect, with the re-check as evidence
//   works on re-check             → dismissed as a false positive (listed in the report, never as a defect)
//   blocked / rate-limited / timeout / intermittent → kept as "Pending verification" (status inconclusive)
//
// Nothing is guessed: an item is confirmed only when a second, independent request reproduces it.

import type { EvidenceItem } from '@wpcg/shared';
import { safeFetch, type SafeResponse } from '../security/safeFetch.js';
import { R } from './rules.js';
import type { FindingElement, RawFinding } from './types.js';

export interface VerificationRecord {
  /** Distinct items (image URLs, link targets) re-checked. */
  checked: number;
  confirmed: number;
  pending: number;
  /** Detections the re-check showed to be wrong; reported for transparency, not as defects. */
  dismissed: { rule: string; item: string; reason: string }[];
}

type Verdict = { kind: 'confirmed' | 'ok' | 'pending'; detail: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function looksLikeImage(body: Buffer | null, contentType: string): boolean {
  if (/^image\//i.test(contentType)) return true;
  if (!body || body.length < 4) return false;
  const b = body;
  const ascii = b.subarray(0, 64).toString('latin1');
  return (
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // JPEG
    (b[0] === 0x89 && ascii.slice(1, 4) === 'PNG') ||
    ascii.startsWith('GIF8') ||
    (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') ||
    ascii.slice(4, 8) === 'ftyp' || // AVIF/HEIC
    /^\s*(<\?xml|<svg)/i.test(ascii)
  );
}

const describe = (r: SafeResponse) => (r.failure ? `${r.failure.message}` : `HTTP ${r.status}${r.headers['content-type'] ? ` (${r.headers['content-type'].split(';')[0]})` : ''}`);

/** The scan has stopped (time limit): the item stays unverified, honestly, without waiting on requests. */
const STOPPED: Verdict = { kind: 'pending', detail: 'Not re-checked: the scan stopped (time limit) before verification.' };

async function verifyImage(url: string, signal?: AbortSignal): Promise<Verdict> {
  if (signal?.aborted) return STOPPED;
  const get = () => safeFetch(url, { method: 'GET', timeoutMs: 20000, maxBytes: 256 * 1024, signal, readBody: () => true, headers: { accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8' } });
  let r = await get();
  // One retry for transient answers before deciding.
  if (r.failure?.kind === 'timeout' || (r.status !== null && r.status >= 500)) {
    await sleep(2000);
    r = await get();
  }
  if (r.failure) return r.failure.kind === 'dns' ? { kind: 'confirmed', detail: `Re-request failed: ${describe(r)}` } : { kind: 'pending', detail: `Could not re-check: ${describe(r)}` };
  const s = r.status ?? 0;
  if ([401, 403, 407, 429].includes(s)) return { kind: 'pending', detail: `The server refused the re-check (${describe(r)}); the image may work for visitors.` };
  if (s >= 400) return { kind: 'confirmed', detail: `Re-request returned ${describe(r)}.` };
  if (s >= 200 && s < 300) {
    if (looksLikeImage(r.body ?? null, r.headers['content-type'] ?? '') && (r.body?.length ?? 0) > 0)
      return { kind: 'ok', detail: `Re-request returned ${describe(r)} with valid image data (${r.body!.length.toLocaleString('en')} bytes read). The browser failure was transient (for example a cancelled lazy-load request).` };
    return { kind: 'confirmed', detail: `Re-request returned ${describe(r)}, but the response is not an image.` };
  }
  return { kind: 'pending', detail: `Unexpected answer on re-check: ${describe(r)}.` };
}

async function verifyLink(url: string, signal?: AbortSignal): Promise<Verdict> {
  if (signal?.aborted) return STOPPED;
  await sleep(1500);
  const r = await safeFetch(url, { method: 'GET', timeoutMs: 20000, maxBytes: 256 * 1024, signal, readBody: () => false });
  if (r.failure) return r.failure.kind === 'dns' || r.failure.kind === 'too_many_redirects' ? { kind: 'confirmed', detail: `Re-checked: ${describe(r)}` } : { kind: 'pending', detail: `Re-check could not complete: ${describe(r)}` };
  const s = r.status ?? 0;
  if (s === 404 || s === 410 || (s >= 400 && s < 500 && ![401, 403, 407, 429].includes(s))) return { kind: 'confirmed', detail: `Re-checked with GET: ${describe(r)}.` };
  if (s >= 500) return { kind: 'confirmed', detail: `Re-checked with GET: still ${describe(r)}.` };
  if (s < 400) return { kind: 'pending', detail: `Failed during the scan but answered ${describe(r)} on re-check — intermittent. Check again before treating it as broken.` };
  return { kind: 'pending', detail: `Re-check was refused (${describe(r)}).` };
}

async function mapLimit<T, R2>(items: T[], n: number, fn: (t: T) => Promise<R2>): Promise<R2[]> {
  const out: R2[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

export async function verifyFindings(findings: RawFinding[], signal?: AbortSignal): Promise<{ findings: RawFinding[]; record: VerificationRecord }> {
  const record: VerificationRecord = { checked: 0, confirmed: 0, pending: 0, dismissed: [] };
  const out: RawFinding[] = [];

  // ---------------------------------------------------------------- images (verified once per URL)
  const imageFindings = findings.filter((f) => f.rule.id === R.brokenImage.id && f.elements?.length);
  const urls = [...new Set(imageFindings.flatMap((f) => f.elements!.map((e) => e.sig.replace(/^img:/, ''))))];
  const verdicts = new Map<string, Verdict>();
  await mapLimit(urls.slice(0, 300), 4, async (u) => verdicts.set(u, await verifyImage(u, signal)));
  for (const u of urls.slice(300)) verdicts.set(u, { kind: 'pending', detail: 'Not re-checked (more than 300 candidate images in this scan).' });
  record.checked += urls.length;
  for (const v of verdicts.values()) {
    if (v.kind === 'confirmed') record.confirmed++;
    if (v.kind === 'pending') record.pending++;
  }
  for (const [u, v] of verdicts) if (v.kind === 'ok') record.dismissed.push({ rule: R.brokenImage.id, item: u, reason: v.detail });

  const linkRules = new Set([R.brokenInternalLink.id, R.brokenExternalLink.id]);
  const linkTargets = [...new Set(findings.filter((f) => linkRules.has(f.rule.id) && !f.status).map((f) => f.target))];
  const linkVerdicts = new Map<string, Verdict>();
  await mapLimit(linkTargets.slice(0, 300), 3, async (u) => linkVerdicts.set(u, await verifyLink(u, signal)));
  // Beyond the cap: an explicit pending verdict, so checked = confirmed + pending in the report.
  for (const u of linkTargets.slice(300)) linkVerdicts.set(u, { kind: 'pending', detail: 'Not re-checked (more than 300 candidate links in this scan).' });
  record.checked += linkTargets.length;
  for (const v of linkVerdicts.values()) {
    if (v.kind === 'confirmed') record.confirmed++;
    else record.pending++;
  }

  for (const f of findings) {
    if (f.rule.id === R.brokenImage.id && f.elements?.length) {
      const split: Record<'confirmed' | 'pending', FindingElement[]> = { confirmed: [], pending: [] };
      for (const el of f.elements) {
        const v = verdicts.get(el.sig.replace(/^img:/, ''))!;
        if (v.kind === 'ok') continue;
        split[v.kind].push({ ...el, note: [el.note, v.detail].filter(Boolean).join(' — ') });
      }
      if (split.confirmed.length) out.push({ ...f, elements: split.confirmed });
      if (split.pending.length)
        out.push({
          ...f,
          status: 'inconclusive',
          elements: split.pending,
          headEvidence: [{ label: 'Verification', value: 'Pending verification: the image failed in the browser but the re-check could not confirm it. It is not counted as a defect.' }],
        });
      continue;
    }
    if (linkRules.has(f.rule.id) && !f.status) {
      const v = linkVerdicts.get(f.target);
      if (!v) {
        out.push({ ...f, status: 'inconclusive' });
        continue;
      }
      const ev: EvidenceItem = { label: 'Verification', value: v.detail };
      out.push(v.kind === 'confirmed' ? { ...f, evidence: [...f.evidence, ev] } : { ...f, status: 'inconclusive', evidence: [...f.evidence, ev] });
      continue;
    }
    out.push(f);
  }
  return { findings: out, record };
}
