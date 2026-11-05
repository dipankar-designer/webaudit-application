// R3 HTTPS redirect and R3b canonical host (www and apex agree on one host).

import { detectChallenge, monitorFetch } from '../probe.js';
import type { CheckRunner } from '../types.js';

export const httpsCheck: CheckRunner = async ({ monitor, signal }) => {
  const u = new URL(monitor.url!);
  const host = u.hostname;
  const problems: { severity: 'p3'; text: string }[] = [];
  const detail: Record<string, unknown> = {};

  // R3: what does http:// do?
  const httpUrl = `http://${host}/`;
  const plain = await monitorFetch(httpUrl, { signal, maxRedirects: 5, readBody: () => false });
  detail.http = { requested: httpUrl, status: plain.status, finalUrl: plain.finalUrl, redirects: plain.redirects.map((h) => `${h.status} ${h.url} → ${h.location}`), failure: plain.failure?.message };
  if (plain.failure?.kind === 'blocked') return { status: 'not_assessed', summary: `Not assessed: ${plain.failure.message}`, detail };
  if (detectChallenge(plain).blocked) return { status: 'not_assessed', summary: `Not assessed: ${detectChallenge(plain).reason}`, detail };
  if (!plain.failure) {
    const finalProto = new URL(plain.finalUrl).protocol;
    if (!plain.redirects.length && plain.status !== null && plain.status < 400) problems.push({ severity: 'p3', text: `http:// serves pages (HTTP ${plain.status}) without redirecting to https://` });
    else if (finalProto !== 'https:') problems.push({ severity: 'p3', text: `http:// does not end on https:// (ends at ${plain.finalUrl})` });
  }

  // R3b: www and apex should end on the same host.
  const other = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  const main = await monitorFetch(`https://${host}/`, { signal, maxRedirects: 5, readBody: () => false });
  const alt = await monitorFetch(`https://${other}/`, { signal, maxRedirects: 5, readBody: () => false });
  const hostOfFinal = (r: typeof main) => (r.status !== null ? new URL(r.finalUrl).hostname : null);
  detail.canonical = { [host]: hostOfFinal(main) ?? main.failure?.message, [other]: hostOfFinal(alt) ?? alt.failure?.message };
  if (alt.failure?.kind === 'dns') detail.canonicalNote = `${other} does not exist in DNS, so there is nothing to split.`;
  else if (!main.failure && !alt.failure && !detectChallenge(main).blocked && !detectChallenge(alt).blocked) {
    const a = hostOfFinal(main);
    const b = hostOfFinal(alt);
    if (a && b && a !== b) problems.push({ severity: 'p3', text: `Split host: https://${host}/ ends on ${a} but https://${other}/ ends on ${b}` });
  }

  if (problems.length) return { status: 'warning', severity: 'p3', summary: problems.map((p) => p.text).join('; '), detail };
  return { status: 'up', summary: `http:// redirects to https://${detail.canonicalNote ? '' : '; www and apex agree'}`, detail };
};
