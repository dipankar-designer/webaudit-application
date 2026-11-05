// "WordPress and Plugin Information" for a scan. Every value has a named, verifiable source; anything
// that cannot be verified is returned as null and shown as "Unknown" / "Unable to verify".
//
// Sources:
//   • WordPress detection, plugin and theme slugs — the site's own HTML (generator tag, REST API link,
//     files under /wp-content/plugins/<slug>/ and /wp-content/themes/<slug>/).
//   • WordPress version — generator tag (high), RSS feed <generator> (high), else the most common
//     ?ver= on /wp-includes/ files (medium).
//   • Plugin version — "Stable tag" in the plugin's own readme.txt (medium: it is the version the
//     installed files declare); else a single ?ver= on the plugin's files (low, "verification required").
//   • Latest versions, closed plugins — WordPress.org plugin/theme API; core status — WordPress.org
//     stable-check (latest / outdated / insecure).
//   • Vulnerabilities — WPVulnerability (wpvulnerability.net, CC0; aggregates CVE, Wordfence,
//     Patchstack, WPScan), matched against the installed version with WordPress version_compare rules.
//
// Risk levels (per plugin; documented in docs/WORDPRESS.md):
//   critical / high / medium / low — highest CVSS among known vulnerabilities that affect the installed
//     version (≥ 9 / ≥ 7 / ≥ 4 / > 0; no score → medium). Unfixed vulnerabilities are never "low".
//   high — closed on WordPress.org for a security reason.
//   medium — no known vulnerability, but an update is available and the plugin has not been updated
//     on WordPress.org for over two years (likely abandoned).
//   low — no known vulnerability affecting the installed version, but an update is available.
//   none — up to date and no known vulnerability (this is not proof of security).
//   unknown — installed version not verifiable, or the vulnerability lookup failed.

import type { WordPressReportDTO, WpConfidence, WpPluginDTO, WpRisk, WpVulnerabilityDTO } from '@wpcg/shared';
import { safeFetch } from '../../security/safeFetch.js';
import { collectMarkers, emptyMarkers, parseFeedGenerator, parsePluginReadme, parseThemeStylesheet, type ComponentMarks } from './detect.js';
import { compareVersions, isVersionLike, satisfies } from './versions.js';
import { deliveryIndicators } from './delivery.js';

const WPORG = 'https://api.wordpress.org';
const WPVULN = 'https://www.wpvulnerability.net';
const UA = 'WebAuditAI/0.1 (+site audit; WordPress component lookup)';
const MAX_PLUGINS = 60;

// ---------------------------------------------------------------- public API lookups (cached per process)

const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 6 * 3600_000;

async function json<T>(url: string): Promise<{ status: number; data: T | null }> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.value as { status: number; data: T | null };
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      let data: T | null = null;
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = null;
      }
      const value = { status: r.status, data };
      if (r.status < 500) {
        cache.set(url, { at: Date.now(), value });
        return value;
      }
      last = new Error(`HTTP ${r.status}`);
    } catch (e) {
      last = e;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw last instanceof Error ? last : new Error('lookup failed');
}

interface WporgInfo {
  found: true | false | 'closed';
  name: string | null;
  version: string | null;
  lastUpdated: string | null;
  closedReason: string | null;
}

async function wporgComponent(type: 'plugin' | 'theme', slug: string): Promise<WporgInfo | null> {
  const s = encodeURIComponent(slug);
  const url =
    type === 'plugin'
      ? `${WPORG}/plugins/info/1.2/?action=plugin_information&request[slug]=${s}&request[fields][sections]=0&request[fields][versions]=0&request[fields][reviews]=0&request[fields][screenshots]=0&request[fields][banners]=0&request[fields][icons]=0&request[fields][contributors]=0&request[fields][ratings]=0&request[fields][tags]=0&request[fields][description]=0`
      : `${WPORG}/themes/info/1.2/?action=theme_information&request[slug]=${s}&request[fields][sections]=0`;
  try {
    const r = await json<{ name?: string; version?: string; last_updated?: string; error?: string; reason?: string; reason_text?: string }>(url);
    const d = r.data;
    if (d?.error === 'closed') return { found: 'closed', name: d.name ?? null, version: null, lastUpdated: null, closedReason: d.reason_text ?? d.reason ?? 'closed' };
    if (r.status === 404 || d?.error) return { found: false, name: null, version: null, lastUpdated: null, closedReason: null };
    if (typeof d?.version !== 'string') return null;
    return { found: true, name: d.name?.replace(/&#0?38;|&amp;/g, '&') ?? null, version: d.version, lastUpdated: d.last_updated ?? null, closedReason: null };
  } catch {
    return null;
  }
}

async function coreStable(): Promise<Record<string, string> | null> {
  try {
    const r = await json<Record<string, string>>(`${WPORG}/core/stable-check/1.0/`);
    return r.data && Object.values(r.data).includes('latest') ? r.data : null;
  } catch {
    return null;
  }
}

interface RawVuln {
  name?: string | null;
  operator?: { min_version?: string | null; min_operator?: string | null; max_version?: string | null; max_operator?: string | null; unfixed?: string | number | null } | null;
  source?: { id?: string | number | null; name?: string | null; link?: string | null }[] | null;
  impact?: { cvss?: { score?: unknown; severity?: unknown }; cvss3?: { score?: unknown; severity?: unknown } } | unknown[] | null;
}

async function wpvulnList(kind: 'plugin' | 'theme' | 'core', key: string): Promise<RawVuln[] | null> {
  try {
    const r = await json<{ error: number | string; data: { vulnerability?: RawVuln[] | null } | null }>(`${WPVULN}/${kind}/${encodeURIComponent(key)}/`);
    if (!r.data || String(r.data.error) !== '0') return null;
    return r.data.data?.vulnerability ?? [];
  } catch {
    return null;
  }
}

const RATING: Record<string, string> = { c: 'Critical', h: 'High', m: 'Medium', l: 'Low', n: 'None' };

function toDto(v: RawVuln): WpVulnerabilityDTO {
  const src = (v.source ?? []).filter(Boolean);
  const cve = src.map((s) => String(s.id ?? '')).find((id) => /^CVE-\d{4}-\d{4,}$/i.test(id))?.toUpperCase() ?? null;
  const named = src.find((s) => s.name && !/^CVE-\d{4}-\d+$/i.test(s.name));
  const impact = v.impact && !Array.isArray(v.impact) ? (v.impact as { cvss?: { score?: unknown; severity?: unknown }; cvss3?: { score?: unknown; severity?: unknown } }) : {};
  const cvss = impact.cvss3 ?? impact.cvss;
  const score = cvss && cvss.score !== undefined && cvss.score !== null && Number.isFinite(Number(cvss.score)) ? Number(cvss.score) : null;
  const sev = cvss && typeof cvss.severity === 'string' ? (RATING[cvss.severity.toLowerCase()[0]] ?? null) : null;
  const op = v.operator ?? {};
  const unfixed = String(op.unfixed ?? '0') === '1';
  const parts = [op.min_operator && op.min_version ? `${{ ge: '≥', gt: '>', eq: '=' }[op.min_operator] ?? op.min_operator} ${op.min_version}` : '', op.max_operator && op.max_version ? `${{ le: '≤', lt: '<', eq: '=' }[op.max_operator] ?? op.max_operator} ${op.max_version}` : ''].filter(Boolean);
  return {
    title: (named?.name ?? v.name ?? cve ?? 'Known vulnerability').replace(/&amp;/g, '&').slice(0, 300),
    cve,
    cvssScore: score,
    severity: sev ?? (score === null ? null : score >= 9 ? 'Critical' : score >= 7 ? 'High' : score >= 4 ? 'Medium' : score > 0 ? 'Low' : 'None'),
    affects: parts.join(' and ') || 'all versions',
    fixedIn: !unfixed && op.max_operator === 'lt' && op.max_version ? op.max_version : null,
    unfixed,
    references: [...new Set(src.map((s) => s.link).filter((l): l is string => !!l && /^https:\/\//.test(l)))].slice(0, 5),
  };
}

/** Vulnerabilities whose version range contains the installed version. */
function affecting(list: RawVuln[], version: string): RawVuln[] {
  return list.filter((v) => {
    const op = v.operator;
    if (!op || (!op.min_operator && !op.max_operator)) return false;
    return satisfies(version, op.min_operator, op.min_version) && satisfies(version, op.max_operator, op.max_version);
  });
}

function riskFromVulns(v: WpVulnerabilityDTO[]): WpRisk {
  let best: WpRisk = 'none';
  const order: WpRisk[] = ['none', 'low', 'medium', 'high', 'critical'];
  for (const x of v) {
    const s = x.cvssScore;
    let r: WpRisk = s === null ? 'medium' : s >= 9 ? 'critical' : s >= 7 ? 'high' : s >= 4 ? 'medium' : s > 0 ? 'low' : 'low';
    if (x.unfixed && r === 'low') r = 'medium';
    if (order.indexOf(r) > order.indexOf(best)) best = r;
  }
  return best;
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
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

function componentDir(origin: string, installPath: string, kind: 'plugins' | 'themes', slug: string, marks: ComponentMarks): URL {
  const sample = [...marks.urls][0];
  const marker = `/${kind}/${slug}/`;
  if (sample) {
    const i = sample.toLowerCase().indexOf(marker);
    if (i >= 0) return new URL(sample.slice(0, i + marker.length), origin);
  }
  return new URL(`${installPath.replace(/\/?$/, '/')}wp-content/${kind}/${slug}/`, origin);
}

const LIMITATIONS = [
  'The total number of installed plugins cannot be determined from outside the website. Plugins are identified from files the public pages load; admin-only and security plugins are usually invisible.',
  'Plugin versions are read from each plugin’s public readme.txt (the version its installed files declare). A version from a ?ver= parameter is weak evidence and is marked “verification required”. A hidden version is shown as Unknown, never guessed.',
  '“No known vulnerabilities” means the WPVulnerability database has no record affecting the detected version. It does not prove the plugin is secure.',
  'Premium or custom plugins that are not listed on WordPress.org have no public latest version, so their update status is Unknown.',
  'For exact, complete data (all plugins, exact versions), connect the site with an administrator account or run `wp plugin list` with WP-CLI on the server.',
];

export async function inspectWordPress(pages: { url: string; html: string; headers: Record<string, string> }[], origin: string, signal?: AbortSignal): Promise<WordPressReportDTO> {
  const acc = emptyMarkers();
  for (const p of pages) {
    try {
      collectMarkers(acc, p.html, new URL(p.url), p.headers);
    } catch {
      /* unparsable page */
    }
  }
  const checkedAt = new Date().toISOString();
  const detected = acc.strong || (acc.plugins.size > 0 && acc.coreAssetVersions.size > 0);
  const sources = [
    'The website’s own pages (generator tag, REST API link, /wp-content/ and /wp-includes/ files)',
    'Each detected plugin’s public readme.txt and each theme’s style.css',
    'WordPress.org plugin, theme and release APIs (latest versions, closed plugins, core security status)',
    'WPVulnerability (wpvulnerability.net) — vulnerability records from CVE, Wordfence, Patchstack and WPScan, public domain (CC0)',
  ];
  if (!detected)
    return { detected: false, markers: acc.markers, core: null, themes: [], totalInstalledPlugins: null, detectedPlugins: 0, plugins: [], sources, limitations: ['No WordPress markers were found on the scanned pages, so no WordPress information is shown.'], checkedAt };

  const installPath = acc.installPath ?? '/';
  const get = (u: URL) => safeFetch(u, { maxBytes: 64 * 1024, timeoutMs: 15000, signal, readBody: () => true });

  // ---------------------------------------------------------------- core
  let coreVersion: string | null = acc.generatorVersion;
  let coreSource: string | null = coreVersion ? 'Generator tag in the page HTML' : null;
  let coreConf: WpConfidence | null = coreVersion ? 'high' : null;
  if (!coreVersion) {
    const feed = await get(new URL(`${installPath.replace(/\/?$/, '/')}feed/`, origin));
    const v = feed.status === 200 && feed.body ? parseFeedGenerator(feed.body.toString('utf8')) : null;
    if (v) {
      coreVersion = v;
      coreSource = 'RSS feed <generator> element';
      coreConf = 'high';
    }
  }
  if (!coreVersion && acc.coreAssetVersions.size) {
    const [v] = [...acc.coreAssetVersions.entries()].sort((a, b) => b[1] - a[1])[0];
    coreVersion = v;
    coreSource = 'Most common ?ver= on /wp-includes/ files';
    coreConf = 'medium';
  }
  const stable = await coreStable();
  const latestCore = stable ? (Object.entries(stable).find(([, s]) => s === 'latest')?.[0] ?? null) : null;
  let coreStatus = 'unknown' as 'latest' | 'outdated' | 'insecure' | 'unknown';
  if (coreVersion && stable) {
    coreStatus = (stable[coreVersion] as typeof coreStatus | undefined) ?? (latestCore && compareVersions(coreVersion, latestCore) >= 0 ? 'latest' : 'unknown');
  }
  const coreVulnRaw = coreVersion ? await wpvulnList('core', coreVersion) : null;
  const coreVulns = (coreVulnRaw ?? []).map(toDto);
  let coreRisk: WpRisk = !coreVersion || coreVulnRaw === null ? 'unknown' : coreVulns.length ? riskFromVulns(coreVulns) : coreStatus === 'latest' ? 'none' : 'low';
  if (coreStatus === 'insecure' && (coreRisk === 'none' || coreRisk === 'low')) coreRisk = 'high';

  // ---------------------------------------------------------------- themes
  const themes = await mapLimit([...acc.themes.entries()].slice(0, 5), 2, async ([slug, marks]) => {
    const r = await get(new URL('style.css', componentDir(origin, installPath, 'themes', slug, marks)));
    const parsed = r.status === 200 && r.body ? parseThemeStylesheet(r.body.toString('utf8')) : null;
    const info = await wporgComponent('theme', slug);
    return { slug, name: parsed?.name ?? null, version: isVersionLike(parsed?.version) ? parsed!.version : null, latestVersion: info?.found === true ? info.version : null };
  });

  // ---------------------------------------------------------------- plugins
  const pluginEntries = [...acc.plugins.entries()].slice(0, MAX_PLUGINS);
  const plugins = await mapLimit(pluginEntries, 3, async ([slug, marks]): Promise<WpPluginDTO> => {
    let version: string | null = null;
    let source: string | null = null;
    let conf: WpConfidence | null = null;
    let name: string | null = null;
    const r = await get(new URL('readme.txt', componentDir(origin, installPath, 'plugins', slug, marks)));
    if (r.status === 200 && r.body) {
      const parsed = parsePluginReadme(r.body.toString('utf8'));
      if (parsed) {
        name = parsed.name;
        if (isVersionLike(parsed.stableTag)) {
          version = parsed.stableTag;
          source = 'Stable tag in the plugin’s readme.txt';
          conf = 'medium';
        }
      }
    }
    if (!version) {
      const assetVersions = [...marks.assetVersions].filter((v) => v !== coreVersion);
      if (assetVersions.length === 1 && isVersionLike(assetVersions[0])) {
        version = assetVersions[0];
        source = '?ver= on the plugin’s files (weak evidence — verification required)';
        conf = 'low';
      }
    }
    const [info, vulnRaw] = await Promise.all([wporgComponent('plugin', slug), wpvulnList('plugin', slug)]);
    name ??= info?.name ?? null;
    const latest = info?.found === true ? info.version : null;
    const updateStatus: WpPluginDTO['updateStatus'] = version && latest ? (compareVersions(version, latest) >= 0 ? 'up_to_date' : 'update_available') : 'unknown';
    const vulns = version && vulnRaw ? affecting(vulnRaw, version).map(toDto) : [];

    let risk: WpRisk;
    let riskReason: string;
    if (info?.found === 'closed' && /secur/i.test(info.closedReason ?? '')) {
      risk = 'high';
      riskReason = `Closed on WordPress.org (${info.closedReason}). Closed plugins receive no updates; replace it.`;
    } else if (!version) {
      risk = 'unknown';
      riskReason = vulnRaw?.length
        ? `Installed version could not be verified, so ${vulnRaw.length} published vulnerabilit${vulnRaw.length === 1 ? 'y' : 'ies'} for this plugin cannot be matched. Check the version in WordPress admin.`
        : 'Installed version could not be verified.';
    } else if (vulnRaw === null) {
      risk = 'unknown';
      riskReason = 'The vulnerability database could not be reached; risk not assessed.';
    } else if (vulns.length) {
      risk = riskFromVulns(vulns);
      const fix = vulns.map((v) => v.fixedIn).filter((v): v is string => !!v).sort(compareVersions).pop();
      riskReason = `${vulns.length} known vulnerabilit${vulns.length === 1 ? 'y affects' : 'ies affect'} version ${version}.${fix ? ` Update to ${fix} or later.` : vulns.some((v) => v.unfixed) ? ' No fixed version is available yet.' : ''}${conf === 'low' ? ' The version came from weak evidence — verify it in WordPress admin.' : ''}`;
    } else if (updateStatus === 'update_available') {
      const stale = info?.found === true && info.lastUpdated && Date.now() - Date.parse(`${info.lastUpdated.slice(0, 10)}T00:00:00Z`) > 2 * 365 * 86400_000; // "2025-11-20 3:15pm GMT"
      risk = stale ? 'medium' : 'low';
      riskReason = `No known vulnerability affects ${version}, but version ${latest} is available.${stale ? ' The plugin has not been updated on WordPress.org for over two years.' : ''}`;
    } else if (updateStatus === 'up_to_date') {
      risk = 'none';
      riskReason = 'Up to date, and no known vulnerability affects this version.';
    } else {
      risk = info?.found === false ? 'unknown' : 'low';
      riskReason = info?.found === false ? 'Not listed on WordPress.org (premium or custom), so the latest version cannot be verified. No known vulnerability matches this version.' : 'Latest version could not be verified. No known vulnerability matches this version.';
    }

    return {
      slug,
      name,
      installedVersion: version,
      versionSource: source,
      versionConfidence: conf,
      latestVersion: latest,
      wordpressOrg: info ? info.found : null,
      closedReason: info?.closedReason ?? null,
      lastUpdated: info?.lastUpdated ?? null,
      updateStatus,
      risk,
      riskReason,
      vulnLookup: vulnRaw === null ? 'failed' : 'ok',
      vulnerabilities: vulns,
      evidence: [...marks.urls].slice(0, 3),
    };
  });
  const order: WpRisk[] = ['critical', 'high', 'medium', 'low', 'unknown', 'none'];
  plugins.sort((a, b) => order.indexOf(a.risk) - order.indexOf(b.risk) || a.slug.localeCompare(b.slug));

  return {
    detected: true,
    markers: acc.markers,
    core: {
      version: coreVersion,
      versionSource: coreSource,
      confidence: coreConf,
      latestVersion: latestCore,
      status: coreStatus,
      vulnLookup: !coreVersion ? 'skipped' : coreVulnRaw === null ? 'failed' : 'ok',
      vulnerabilities: coreVulns,
      risk: coreRisk,
    },
    themes,
    totalInstalledPlugins: null,
    detectedPlugins: acc.plugins.size,
    plugins,
    sources,
    limitations: acc.plugins.size > MAX_PLUGINS ? [...LIMITATIONS, `Only the first ${MAX_PLUGINS} of ${acc.plugins.size} detected plugins were looked up.`] : LIMITATIONS,
    checkedAt,
    // Cache headers, compression and plugin signatures on the home page (pages[0] is the start page).
    delivery: pages[0] ? deliveryIndicators(pages[0].html, pages[0].headers) : undefined,
  };
}
