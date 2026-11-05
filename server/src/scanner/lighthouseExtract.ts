// Resource-level data taken from a full Lighthouse result (LHR) before it is compacted: every network
// request Lighthouse recorded, the per-type totals, third parties, the per-file findings of Lighthouse's
// own audits, and the exact test settings. Only values Lighthouse measured are copied; nothing is
// estimated here. Pure functions so they can be tested without running Lighthouse.

import type { LhResourceDTO, LhResourceFindingDTO, LhResourceSummaryDTO, LhTestConfigDTO, LhThirdPartyDTO } from '@wpcg/shared';

/** Requests kept per report (largest first beyond this), so a heavy page stays a reasonable size. */
export const MAX_RESOURCES = 300;

type Obj = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const items = (lhr: Obj, id: string): Obj[] => {
  const d = (lhr.audits as Obj | undefined)?.[id] as Obj | undefined;
  const list = (d?.details as Obj | undefined)?.items;
  return Array.isArray(list) ? (list as Obj[]) : [];
};

/**
 * Lighthouse audits whose rows name a specific file, with the measured value each one reports.
 * Only failing/flagged rows are listed by Lighthouse, so a row here is itself the evidence.
 */
const PER_FILE_AUDITS: { id: string; label: string }[] = [
  { id: 'render-blocking-insight', label: 'Render-blocking' },
  { id: 'unused-javascript', label: 'Unused JavaScript' },
  { id: 'unused-css-rules', label: 'Unused CSS' },
  { id: 'unminified-javascript', label: 'JavaScript not minified' },
  { id: 'unminified-css', label: 'CSS not minified' },
  { id: 'cache-insight', label: 'Short cache lifetime' },
  { id: 'image-delivery-insight', label: 'Image could be smaller' },
  { id: 'font-display-insight', label: 'Font blocks text display' },
  { id: 'legacy-javascript-insight', label: 'Legacy JavaScript' },
  { id: 'duplicated-javascript-insight', label: 'Duplicated JavaScript' },
  { id: 'unsized-images', label: 'Image without width/height' },
  { id: 'long-tasks', label: 'Long main-thread task' },
];

export function extractResources(lhr: Obj): {
  resources: LhResourceDTO[];
  resourcesTotal: number;
  resourceSummary: LhResourceSummaryDTO[];
  thirdParties: LhThirdPartyDTO[];
  findingsByUrl: Record<string, LhResourceFindingDTO[]>;
} {
  // Which entities are first party (Lighthouse's own classification of origins).
  const entities = Array.isArray(lhr.entities) ? (lhr.entities as Obj[]) : [];
  const firstParty = new Set(entities.filter((e) => e.isFirstParty === true).map((e) => String(e.name)));
  const category = new Map(entities.map((e) => [String(e.name), str(e.category)]));

  const all = items(lhr, 'network-requests')
    .filter((r) => typeof r.url === 'string' && !String(r.url).startsWith('data:'))
    .map((r): LhResourceDTO => {
      const start = num(r.networkRequestTime);
      const end = num(r.networkEndTime);
      const entity = str(r.entity);
      return {
        url: String(r.url).slice(0, 1000),
        resourceType: str(r.resourceType) ?? 'Other',
        mimeType: str(r.mimeType),
        statusCode: num(r.statusCode),
        transferSize: num(r.transferSize),
        resourceSize: num(r.resourceSize),
        durationMs: start !== null && end !== null && end >= start ? Math.round(end - start) : null,
        startMs: start !== null ? Math.round(start) : null,
        priority: str(r.priority),
        protocol: str(r.protocol),
        fromCache: r.cache === 'disk' || r.cache === 'memory' ? true : r.cache === 'none' ? false : null,
        entity,
        thirdParty: entity ? !firstParty.has(entity) : null,
      };
    });
  // Keep the heaviest requests when a page makes more than MAX_RESOURCES.
  const resources = all.length > MAX_RESOURCES ? [...all].sort((a, b) => (b.transferSize ?? 0) - (a.transferSize ?? 0)).slice(0, MAX_RESOURCES) : all;

  const resourceSummary = items(lhr, 'resource-summary').map((s) => ({
    resourceType: String(s.resourceType ?? 'other'),
    label: String(s.label ?? s.resourceType ?? ''),
    requestCount: num(s.requestCount) ?? 0,
    transferSize: num(s.transferSize) ?? 0,
  }));

  const thirdParties = items(lhr, 'third-parties-insight').map((t) => {
    const name = String(typeof t.entity === 'object' && t.entity ? ((t.entity as Obj).text ?? '') : (t.entity ?? ''));
    return { entity: name, category: category.get(name) ?? null, transferSize: num(t.transferSize), mainThreadMs: num(t.mainThreadTime) };
  });

  const findingsByUrl: Record<string, LhResourceFindingDTO[]> = {};
  for (const a of PER_FILE_AUDITS) {
    for (const row of items(lhr, a.id)) {
      const url = typeof row.url === 'string' ? row.url : null;
      if (!url || url.startsWith('data:')) continue;
      const f: LhResourceFindingDTO = {
        auditId: a.id,
        label: a.label,
        wastedBytes: num(row.wastedBytes),
        wastedMs: num(row.wastedMs),
        totalBytes: num(row.totalBytes),
        cacheLifetimeMs: num(row.cacheLifetimeMs),
        durationMs: num(row.duration),
      };
      (findingsByUrl[url] ??= []).push(f);
    }
  }
  return { resources, resourcesTotal: all.length, resourceSummary, thirdParties, findingsByUrl };
}

export function extractTestConfig(lhr: Obj, runs = 1): LhTestConfigDTO {
  const cs = (lhr.configSettings ?? {}) as Obj;
  const t = (cs.throttling ?? {}) as Obj;
  const screen = (cs.screenEmulation ?? {}) as Obj;
  const env = (lhr.environment ?? {}) as Obj;
  const method = str(cs.throttlingMethod);
  return {
    formFactor: cs.formFactor === 'mobile' ? 'mobile' : 'desktop',
    screen: screen.disabled === true ? null : { width: num(screen.width), height: num(screen.height), deviceScaleFactor: num(screen.deviceScaleFactor), mobile: screen.mobile === true },
    throttlingMethod: method,
    rttMs: num(t.rttMs),
    throughputKbps: num(t.throughputKbps),
    cpuSlowdownMultiplier: num(t.cpuSlowdownMultiplier),
    benchmarkIndex: num(env.benchmarkIndex),
    networkUserAgent: str(env.networkUserAgent),
    hostUserAgent: str(env.hostUserAgent),
    runs,
  };
}
