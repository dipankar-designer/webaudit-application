// Advanced performance analysis around the Lighthouse report: exact test conditions, resource-level
// analysis (requests, page weight, third parties, WordPress front-end assets, delivery indicators),
// comparison with the previous scan, and the AI Performance Fix Assistant. Everything shown is measured
// by Lighthouse or read from the page's own response; unavailable values are shown as unavailable.

import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowDownRight, ArrowUpRight, ChevronDown, FileStack, Minus, Sparkles } from 'lucide-react';
import {
  findDuplicateAssets,
  groupWordPressAssets,
  type LhComparisonDTO,
  type LhResourceDTO,
  type LhTestConfigDTO,
  type LighthouseReportDTO,
  type WordPressReportDTO,
} from '@wpcg/shared';
import { errorMessage, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { fmtBytes, fmtDateTime } from '../lib/format';
import { Alert, Button, ErrorState, LoadingState, cx } from './ui';

const RECORDED_FROM = 'Recorded for scans run from 30 October 2026 on — run a new Full scan to see it.';
const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

/** A collapsible panel in the same style as "Diagnose performance issues". */
export function Panel({ id, icon, title, badge, children, defaultOpen = false }: { id: string; icon: ReactNode; title: string; badge?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group/panel rounded-xl border border-slate-200 bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 hover:bg-slate-100 [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 text-brand-700">{icon}</span>
        <h4 id={id} className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
          {title}
          {badge}
        </h4>
        <ChevronDown className="size-4 shrink-0 text-slate-500 transition-transform group-open/panel:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-slate-100 p-4 sm:p-6">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------- test conditions

export function TestConditions({ config, environment, viewport }: { config: LhTestConfigDTO | undefined; environment: string[]; viewport: 'mobile' | 'desktop' }) {
  if (!config)
    return (
      <div className="text-sm text-slate-700">
        <ul className="list-disc space-y-1 pl-5">
          {environment.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500">Detailed settings (screen size, round-trip time, throughput, CPU slowdown) are {RECORDED_FROM.toLowerCase()}</p>
      </div>
    );
  const simulated = config.throttlingMethod === 'simulate';
  const rows: [string, ReactNode][] = [
    ['Device', `${config.formFactor === 'mobile' ? 'Emulated mobile device (Moto G Power class)' : 'Emulated desktop'}${config.screen ? ` · ${config.screen.width}×${config.screen.height} px at ${config.screen.deviceScaleFactor}× pixel ratio` : ''}`],
    ['Network', config.rttMs !== null && config.throughputKbps !== null ? `${config.rttMs} ms round trip · ${(config.throughputKbps / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} Mbps download${simulated ? ' (simulated)' : ''}` : 'Not throttled'],
    ['CPU', config.cpuSlowdownMultiplier ? `${config.cpuSlowdownMultiplier}× slowdown${simulated ? ' (simulated)' : ''}` : '—'],
    ['Method', simulated ? 'Simulated throttling (Lighthouse’s Lantern model)' : (config.throttlingMethod ?? '—')],
    ['Runs', config.runs > 1 ? `Median of ${config.runs} runs` : 'Single run'],
    ['Test machine', `${config.benchmarkIndex ? `CPU benchmark ${Math.round(config.benchmarkIndex)}` : 'CPU benchmark not recorded'}${environment.find((e) => /Chrome\//.test(e)) ? ` · ${environment.find((e) => /Chrome\//.test(e))}` : ''}`],
  ];
  return (
    <div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">{k}</dt>
            <dd className="mt-0.5 text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
        {simulated
          ? `The page was loaded at full speed in Chrome on our test machine, and Lighthouse modelled how it would load on the ${viewport === 'mobile' ? 'slower phone and network' : 'desktop connection'} above. This is not a measurement on a real ${viewport === 'mobile' ? 'phone' : 'computer'} or network.`
          : 'Lab test on our test machine; not a measurement on a real visitor’s device.'}{' '}
        Results also depend on the test machine’s location and speed.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- resource analysis

const TYPE_FILTERS = ['All', 'Document', 'Script', 'Stylesheet', 'Image', 'Font', 'Media', 'Fetch/XHR', 'Other'] as const;
const typeOf = (r: LhResourceDTO): (typeof TYPE_FILTERS)[number] =>
  r.resourceType === 'Fetch' || r.resourceType === 'XHR' ? 'Fetch/XHR' : (TYPE_FILTERS as readonly string[]).includes(r.resourceType) ? (r.resourceType as (typeof TYPE_FILTERS)[number]) : 'Other';

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    const path = x.pathname.length > 48 ? `…${x.pathname.slice(-46)}` : x.pathname;
    return `${x.host}${path}`;
  } catch {
    return u.slice(0, 60);
  }
}

function findingText(f: NonNullable<LighthouseReportDTO['findingsByUrl']>[string][number]): string {
  if (f.wastedBytes) return `${f.label}: ${fmtBytes(f.wastedBytes)} could be saved`;
  if (f.wastedMs) return `${f.label}: ${ms(f.wastedMs)}`;
  if (f.cacheLifetimeMs !== null) return `${f.label}: cached ${f.cacheLifetimeMs ? ms(f.cacheLifetimeMs) : 'not at all'}`;
  if (f.durationMs) return `${f.label}: ${ms(f.durationMs)}`;
  return f.label;
}

function RequestsTable({ resources, findingsByUrl, total }: { resources: LhResourceDTO[]; findingsByUrl: NonNullable<LighthouseReportDTO['findingsByUrl']>; total: number }) {
  const [type, setType] = useState<(typeof TYPE_FILTERS)[number]>('All');
  const [party, setParty] = useState<'all' | 'first' | 'third'>('all');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [sort, setSort] = useState<'transfer' | 'duration' | 'start'>('transfer');
  const [showAll, setShowAll] = useState(false);
  const uid = useId();
  const rows = useMemo(() => {
    const list = resources.filter(
      (r) => (type === 'All' || typeOf(r) === type) && (party === 'all' || (party === 'third' ? r.thirdParty === true : r.thirdParty === false)) && (!flaggedOnly || !!findingsByUrl[r.url]?.length),
    );
    const key = (r: LhResourceDTO) => (sort === 'transfer' ? -(r.transferSize ?? -1) : sort === 'duration' ? -(r.durationMs ?? -1) : (r.startMs ?? Infinity));
    return list.sort((a, b) => key(a) - key(b));
  }, [resources, findingsByUrl, type, party, flaggedOnly, sort]);
  const shown = showAll ? rows : rows.slice(0, 25);
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Filter requests">
        <div>
          <label htmlFor={uid + '-type'} className="block text-xs text-slate-600">
            Type
          </label>
          <select id={uid + '-type'} className="input mt-1 w-auto py-1.5 text-sm" value={type} onChange={(e) => setType(e.target.value as (typeof TYPE_FILTERS)[number])}>
            {TYPE_FILTERS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={uid + '-party'} className="block text-xs text-slate-600">
            Source
          </label>
          <select id={uid + '-party'} className="input mt-1 w-auto py-1.5 text-sm" value={party} onChange={(e) => setParty(e.target.value as 'all' | 'first' | 'third')}>
            <option value="all">All</option>
            <option value="first">This site</option>
            <option value="third">Third parties</option>
          </select>
        </div>
        <div>
          <label htmlFor={uid + '-sort'} className="block text-xs text-slate-600">
            Sort by
          </label>
          <select id={uid + '-sort'} className="input mt-1 w-auto py-1.5 text-sm" value={sort} onChange={(e) => setSort(e.target.value as 'transfer' | 'duration' | 'start')}>
            <option value="transfer">Largest transfer</option>
            <option value="duration">Longest load</option>
            <option value="start">Load order</option>
          </select>
        </div>
        <label className="inline-flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" className="size-4 rounded accent-brand-600" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} />
          Only files with Lighthouse findings
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500" aria-live="polite">
        {rows.length} of {resources.length} request{resources.length === 1 ? '' : 's'}
        {total > resources.length ? ` (the page made ${total}; the ${resources.length} largest are kept)` : ''}. Load time is under the test’s conditions.
      </p>
      <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200" tabIndex={0} role="region" aria-label="Network requests">
        <table className="w-full min-w-[54rem] text-left text-sm">
          <thead className="bg-slate-100 text-xs text-slate-600">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Resource</th>
              <th scope="col" className="px-3 py-2 font-medium">Type</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Transfer</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Size</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Load time</th>
              <th scope="col" className="px-3 py-2 font-medium">Lighthouse findings</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((r) => (
              <tr key={r.url} className="align-top">
                <td className="w-[16rem] min-w-[14rem] px-3 py-2">
                  <a href={r.url} target="_blank" rel="noreferrer noopener" title={r.url} className="break-all text-slate-900 hover:underline">
                    {shortUrl(r.url)}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {r.thirdParty ? `Third party · ${r.entity ?? 'unknown'}` : r.thirdParty === false ? 'This site' : (r.entity ?? '')}
                    {r.priority ? ` · ${r.priority} priority` : ''}
                    {r.protocol ? ` · ${r.protocol}` : ''}
                  </div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-slate-700">{r.resourceType}</td>
                <td className={cx('px-3 py-2 tabular-nums', (r.statusCode ?? 0) >= 400 ? 'font-medium text-[#ff4e42]' : 'text-slate-700')}>{r.statusCode ?? '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums text-slate-800">{r.fromCache ? 'cache' : fmtBytes(r.transferSize)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums text-slate-600">{fmtBytes(r.resourceSize)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums text-slate-700">{ms(r.durationMs)}</td>
                <td className="px-3 py-2">
                  {findingsByUrl[r.url]?.length ? (
                    <ul className="flex flex-wrap gap-1">
                      {findingsByUrl[r.url].map((f, i) => (
                        <li key={i} className="rounded border border-[#ffa400]/40 bg-[#ffa400]/10 px-1.5 py-0.5 text-xs text-slate-800">
                          {findingText(f)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-xs text-slate-500">None</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 25 && (
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => setShowAll((s) => !s)}>
          {showAll ? 'Show the first 25' : `Show all ${rows.length}`}
        </Button>
      )}
    </div>
  );
}

function Bar({ label, value, max, detail }: { label: string; value: number; max: number; detail: string }) {
  return (
    <li className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm">
      <span className="truncate text-slate-700">{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-slate-200" aria-hidden>
        <span className="block h-full rounded-full bg-brand-500" style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} />
      </span>
      <span className="text-right whitespace-nowrap text-slate-600 tabular-nums">{detail}</span>
    </li>
  );
}

export function ResourceAnalysis({ report, wordpress }: { report: LighthouseReportDTO; wordpress: WordPressReportDTO | null | undefined }) {
  if (!report.resources) return <p className="text-sm text-slate-600">Resource-level analysis (every request, page weight by type, third parties) is {RECORDED_FROM.toLowerCase()}</p>;
  const findingsByUrl = report.findingsByUrl ?? {};
  const summary = report.resourceSummary ?? [];
  const total = summary.find((s) => s.resourceType === 'total');
  const third = summary.find((s) => s.resourceType === 'third-party');
  const types = summary.filter((s) => s.resourceType !== 'total' && s.resourceType !== 'third-party' && s.requestCount > 0);
  const maxType = Math.max(0, ...types.map((t) => t.transferSize));
  const flagged = report.resources.filter((r) => findingsByUrl[r.url]?.length).length;
  const wpGroups = groupWordPressAssets(report.resources);
  const duplicates = findDuplicateAssets(report.resources);
  const pluginName = (slug: string) => wordpress?.plugins.find((p) => p.slug === slug)?.name ?? null;
  const themeName = (slug: string) => wordpress?.themes.find((t) => t.slug === slug)?.name ?? null;
  const delivery = wordpress?.detected ? wordpress.delivery : undefined;

  return (
    <div className="space-y-8">
      <section aria-labelledby="ra-weight">
        <h5 id="ra-weight" className="text-sm font-semibold text-slate-900">
          Page weight
        </h5>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Transferred', fmtBytes(total?.transferSize)],
            ['Requests', total ? String(total.requestCount) : '—'],
            ['Third-party transfer', third ? `${fmtBytes(third.transferSize)} (${third.requestCount} req.)` : '—'],
            ['Files with findings', String(flagged)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-slate-200 px-3 py-2">
              <dt className="text-xs text-slate-500">{k}</dt>
              <dd className="mt-0.5 text-base font-semibold text-slate-900 tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {types.length > 0 && (
          <ul className="mt-4 space-y-2" aria-label="Transfer size by resource type">
            {types.map((t) => (
              <Bar key={t.resourceType} label={t.label} value={t.transferSize} max={maxType} detail={`${fmtBytes(t.transferSize)} · ${t.requestCount} req.`} />
            ))}
          </ul>
        )}
      </section>

      {(report.thirdParties?.length ?? 0) > 0 && (
        <section aria-labelledby="ra-third">
          <h5 id="ra-third" className="text-sm font-semibold text-slate-900">
            Third parties
          </h5>
          <p className="mt-1 text-xs text-slate-600">Code and files from other companies’ servers. Main-thread time is CPU work in the test; it delays interactivity.</p>
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200" tabIndex={0} role="region" aria-label="Third parties">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <thead className="bg-slate-100 text-xs text-slate-600">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Third party</th>
                  <th scope="col" className="px-3 py-2 font-medium">Category</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Transfer</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Main-thread time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.thirdParties!.map((t) => (
                  <tr key={t.entity}>
                    <td className="px-3 py-2 text-slate-900">{t.entity}</td>
                    <td className="px-3 py-2 text-slate-600">{t.category ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtBytes(t.transferSize)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ms(t.mainThreadMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(wordpress?.detected || wpGroups.length > 0) && (
        <section aria-labelledby="ra-wp" className="space-y-4">
          <div>
            <h5 id="ra-wp" className="text-sm font-semibold text-slate-900">
              WordPress front-end assets
            </h5>
            <p className="mt-1 text-xs text-slate-600">
              Files this page loaded, grouped by the plugin or theme folder they came from. Loading files does not prove a plugin slows the page; the last column shows which of its files
              Lighthouse actually flagged.
            </p>
          </div>
          {wpGroups.length ? (
            <div className="overflow-x-auto rounded-lg border border-slate-200" tabIndex={0} role="region" aria-label="WordPress assets by plugin and theme">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <thead className="bg-slate-100 text-xs text-slate-600">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Plugin / theme</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Files</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Transfer</th>
                    <th scope="col" className="px-3 py-2 font-medium">Files with Lighthouse findings</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {wpGroups.map((g) => {
                    const flaggedFiles = g.urls.filter((u) => findingsByUrl[u]?.length);
                    const name = g.kind === 'plugin' ? pluginName(g.slug) : g.kind === 'theme' ? themeName(g.slug) : 'WordPress core';
                    return (
                      <tr key={`${g.kind}:${g.slug}`} className="align-top">
                        <td className="px-3 py-2">
                          <span className="text-slate-900">{name ?? g.slug}</span>
                          <span className="block text-xs text-slate-500">
                            {g.kind === 'plugin' ? 'Plugin' : g.kind === 'theme' ? 'Theme' : 'Core'} · {g.slug}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{g.requests}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtBytes(g.transferSize)}</td>
                        <td className="px-3 py-2 text-xs text-slate-700">
                          {flaggedFiles.length
                            ? flaggedFiles.slice(0, 4).map((u) => (
                                <div key={u}>
                                  {shortUrl(u)} — {findingsByUrl[u].map((f) => f.label).join(', ')}
                                </div>
                              ))
                            : 'None'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-slate-600">No files from wp-content or wp-includes were loaded by this page.</p>
          )}
          {duplicates.length > 0 && (
            <div>
              <h6 className="text-sm font-medium text-slate-900">Possible duplicate assets</h6>
              <p className="text-xs text-slate-600">The same file name loaded from more than one address — often the same library twice. Same name is a strong hint, not proof; compare the files before removing one.</p>
              <ul className="mt-2 space-y-2 text-sm">
                {duplicates.map((d) => (
                  <li key={d.name} className="rounded-lg border border-slate-200 px-3 py-2">
                    <span className="font-medium text-slate-900">{d.name}</span> <span className="text-slate-600">· {fmtBytes(d.transferSize)} in total</span>
                    <ul className="mt-1 list-disc pl-5 text-xs break-all text-slate-600">
                      {d.urls.map((u) => (
                        <li key={u}>{u}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {delivery && (
            <div>
              <h6 className="text-sm font-medium text-slate-900">Caching and compression indicators</h6>
              <ul className="mt-2 space-y-1.5 text-sm">
                <li className="flex flex-wrap gap-x-2">
                  <span className={cx('font-medium', delivery.htmlCompression ? 'text-[#0cce6b]' : 'text-[#ff4e42]')}>{delivery.htmlCompression ? `HTML compressed (${delivery.htmlCompression})` : 'HTML sent uncompressed'}</span>
                  <span className="text-xs text-slate-500">{delivery.htmlCompression ? `Header content-encoding: ${delivery.htmlCompression}` : 'No content-encoding header on the home page: enable gzip or Brotli on the server or CDN.'}</span>
                </li>
                {delivery.cacheControl && (
                  <li className="text-xs text-slate-600">
                    Cache-Control on the HTML: <code className="rounded bg-slate-100 px-1">{delivery.cacheControl}</code>
                  </li>
                )}
                {delivery.indicators.length ? (
                  delivery.indicators.map((i) => (
                    <li key={i.evidence} className="flex flex-wrap gap-x-2">
                      <span className="text-slate-900">
                        {i.label}
                        {i.state !== 'present' ? ` — ${i.state}` : ''}
                      </span>
                      <span className="text-xs text-slate-500">{i.evidence}</span>
                    </li>
                  ))
                ) : (
                  <li className="text-slate-600">No cache headers or caching-plugin signatures were visible on the home page response.</li>
                )}
              </ul>
              <p className="mt-2 text-xs text-slate-500">{delivery.note}</p>
            </div>
          )}
          <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
            Server-side time (PHP, database queries, which plugin’s code runs slowly) cannot be measured from outside the site. Finding it needs an authorised tool on the WordPress site itself —
            for example the Query Monitor plugin or your host’s application monitoring — used with the owner’s permission.
          </p>
        </section>
      )}

      <section aria-labelledby="ra-requests">
        <h5 id="ra-requests" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <FileStack className="size-4 text-slate-500" aria-hidden />
          Every request
        </h5>
        <div className="mt-3">
          <RequestsTable resources={report.resources} findingsByUrl={findingsByUrl} total={report.resourcesTotal ?? report.resources.length} />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- comparison with the previous scan

const COMPARE_ROWS: { key: string; label: string; kind: 'score' | 'ms' | 'cls' | 'bytes' | 'count' }[] = [
  { key: 'score:performance', label: 'Performance score', kind: 'score' },
  { key: 'score:accessibility', label: 'Accessibility score', kind: 'score' },
  { key: 'score:best-practices', label: 'Best Practices score', kind: 'score' },
  { key: 'score:seo', label: 'SEO score', kind: 'score' },
  { key: 'first-contentful-paint', label: 'First Contentful Paint', kind: 'ms' },
  { key: 'largest-contentful-paint', label: 'Largest Contentful Paint', kind: 'ms' },
  { key: 'total-blocking-time', label: 'Total Blocking Time', kind: 'ms' },
  { key: 'cumulative-layout-shift', label: 'Cumulative Layout Shift', kind: 'cls' },
  { key: 'speed-index', label: 'Speed Index', kind: 'ms' },
  { key: 'bytes', label: 'Page weight', kind: 'bytes' },
  { key: 'requests', label: 'Requests', kind: 'count' },
];

function valueOf(s: LhComparisonDTO['current'], key: string): number | null {
  if (key.startsWith('score:')) {
    const v = s.scores[key.slice(6)];
    return v === null || v === undefined ? null : Math.round(v * 100);
  }
  if (key === 'bytes') return s.totalTransferSize;
  if (key === 'requests') return s.totalRequests;
  return s.metrics[key] ?? null;
}

/**
 * Differences smaller than normal lab run-to-run variation are reported as "about the same", not as
 * better/worse: under 3 score points, under 5% (and 50 ms) for timings, under 0.01 CLS, under 2% weight.
 */
export function withinNoise(kind: (typeof COMPARE_ROWS)[number]['kind'], diff: number, before: number): boolean {
  const d = Math.abs(diff);
  if (kind === 'score') return d < 3;
  if (kind === 'ms') return d < Math.max(50, Math.abs(before) * 0.05);
  if (kind === 'cls') return d < 0.01;
  if (kind === 'bytes') return d < Math.max(2048, Math.abs(before) * 0.02);
  return d === 0; // request counts are exact
}

const fmtCompare = (v: number | null, kind: (typeof COMPARE_ROWS)[number]['kind']) =>
  v === null ? '—' : kind === 'score' || kind === 'count' ? String(v) : kind === 'cls' ? String(Number(v.toFixed(3))) : kind === 'bytes' ? fmtBytes(v) : ms(v);

export function ScanComparison({ scanId, page, viewport }: { scanId: string; page: string; viewport: 'mobile' | 'desktop' }) {
  const c = useApi<LhComparisonDTO>(`/scans/${scanId}/lighthouse/compare?page=${encodeURIComponent(page)}&viewport=${viewport}`);
  if (c.loading && !c.data) return <LoadingState label="Comparing with the previous scan…" />;
  if (c.error) return <ErrorState error={c.error} onRetry={c.reload} />;
  const d = c.data!;
  if (!d.previous) return <p className="text-sm text-slate-600">This is the first scan of this page on {viewport} with a Lighthouse report. The next scan will be compared with it.</p>;
  const p = d.previous;
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-700">
        Compared with the scan of {fmtDateTime(p.scanFinishedAt ?? p.fetchTime)} (
        <Link to={`/scans/${p.scanId}`} className="font-medium text-brand-700 underline underline-offset-2">
          open it
        </Link>
        ), same page and device.
      </p>
      <div className="overflow-x-auto rounded-lg border border-slate-200" tabIndex={0} role="region" aria-label="Previous and current results">
        <table className="w-full min-w-[30rem] text-left text-sm">
          <thead className="bg-slate-100 text-xs text-slate-600">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Measurement</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Previous</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">This scan</th>
              <th scope="col" className="px-3 py-2 font-medium">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {COMPARE_ROWS.map((row) => {
              const before = valueOf(p, row.key);
              const now = valueOf(d.current, row.key);
              const diff = before !== null && now !== null ? now - before : null;
              // Within normal lab run-to-run variation: not shown as better or worse.
              const noise = diff !== null && before !== null && withinNoise(row.kind, diff, before);
              // Scores: higher is better. Everything else here: lower is better.
              const better = diff === null || diff === 0 || noise ? null : row.kind === 'score' ? diff > 0 : diff < 0;
              return (
                <tr key={row.key}>
                  <th scope="row" className="px-3 py-2 font-normal text-slate-800">
                    {row.label}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtCompare(before, row.kind)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-900">{fmtCompare(now, row.kind)}</td>
                  <td className="px-3 py-2">
                    {diff === null ? (
                      <span className="text-xs text-slate-500">Not available</span>
                    ) : better === null ? (
                      <span className="inline-flex items-center gap-1 text-xs text-slate-600">
                        <Minus className="size-3.5" aria-hidden /> {diff === 0 ? 'No change' : `About the same (${diff > 0 ? '+' : '−'}${fmtCompare(Math.abs(diff), row.kind)})`}
                      </span>
                    ) : (
                      <span className={cx('inline-flex items-center gap-1 text-xs font-medium', better ? 'text-[#0cce6b]' : 'text-[#ff4e42]')}>
                        {better ? <ArrowDownRight className="size-3.5" aria-hidden /> : <ArrowUpRight className="size-3.5" aria-hidden />}
                        {better ? 'Better' : 'Worse'} by {fmtCompare(Math.abs(diff), row.kind)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h5 className="text-sm font-semibold text-slate-900">Newly failing ({d.newlyFailing.length})</h5>
          {d.newlyFailing.length ? (
            <ul className="mt-2 space-y-1 text-sm">
              {d.newlyFailing.map((a) => (
                <li key={a.id} className="text-slate-800">
                  <span className="text-[#ff4e42]">▲</span> {a.title}
                  {a.displayValue ? <span className="text-slate-500"> — {a.displayValue}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-600">None.</p>
          )}
        </div>
        <div>
          <h5 className="text-sm font-semibold text-slate-900">Now passing ({d.nowPassing.length})</h5>
          {d.nowPassing.length ? (
            <ul className="mt-2 space-y-1 text-sm">
              {d.nowPassing.map((a) => (
                <li key={a.id} className="text-slate-800">
                  <span className="text-[#0cce6b]">●</span> {a.title}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-600">None.</p>
          )}
        </div>
      </div>
      {d.conditionNotes.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-[#ffa400]/40 bg-[#ffa400]/10 px-3 py-2 text-xs text-slate-800">
          {d.conditionNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">These are measured differences between two lab tests. They do not show what caused a change.</p>
    </div>
  );
}

// ---------------------------------------------------------------- AI Performance Fix Assistant

interface AiPlan {
  content: string;
  provider: string;
  model: string;
  createdAt: string;
}

interface AiPlanState {
  plan: AiPlan | null;
  /** A plan is being written in the background (the page polls until it is saved). */
  pending: boolean;
  startedAt: string | null;
  error: string | null;
}

export function AiFixAssistant({ scanId, viewport }: { scanId: string; viewport: 'mobile' | 'desktop' }) {
  const status = useApi<{ configured: boolean; enabledForWorkspace: boolean }>('/ai/status');
  const state = useApi<AiPlanState>(`/ai/scans/${scanId}/performance?viewport=${viewport}`, { pollMs: 5000, shouldPoll: (s) => s.pending });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = state.data;
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/ai/scans/${scanId}/performance`, { viewport });
      state.reload(); // picks up "pending" and polls until the plan is saved
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (status.loading && !status.data) return <LoadingState />;
  if (status.data && !status.data.configured) return <p className="text-sm text-slate-600">AI is not configured on this server. Every finding above already includes step-by-step fixes.</p>;
  if (status.data && !status.data.enabledForWorkspace) return <p className="text-sm text-slate-600">AI is turned off for this workspace (Settings).</p>;
  const minutes = s?.startedAt ? Math.max(0, Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000)) : 0;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-700">
        A prioritised fix plan for this page on {viewport}, written by AI from this scan’s measured results only (metrics, failing audits, requests, third parties and WordPress findings). It is
        told not to invent causes, scores or savings — check its advice against the findings above before acting on it.
      </p>
      {(err || s?.error) && <Alert tone="error">{err ?? s?.error}</Alert>}
      {s?.pending ? (
        <div className="flex items-start gap-3 rounded-lg border border-slate-200 p-4 text-sm text-slate-700" role="status">
          <Sparkles className="mt-0.5 size-4 shrink-0 animate-pulse text-brand-700" aria-hidden />
          <span>
            Writing the plan{minutes ? ` — started ${minutes} min ago` : ''}. A local AI model can take several minutes; you can leave this page and come back.
          </span>
        </div>
      ) : s?.plan ? (
        <div>
          <div className="rounded-lg border border-slate-200 p-4 text-sm leading-relaxed whitespace-pre-wrap text-slate-800">{s.plan.content}</div>
          <p className="mt-2 text-xs text-slate-500">
            {s.plan.provider} · {s.plan.model} · {fmtDateTime(s.plan.createdAt)}
          </p>
        </div>
      ) : null}
      {!s?.pending && (
        <Button onClick={start} loading={busy} variant={s?.plan ? 'secondary' : 'primary'} icon={<Sparkles className="size-4" aria-hidden />}>
          {s?.plan ? 'Write a new plan' : 'Create AI fix plan'}
        </Button>
      )}
    </div>
  );
}
