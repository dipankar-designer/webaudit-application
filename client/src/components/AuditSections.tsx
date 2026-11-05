import { CheckCircle2, CircleHelp, SearchCheck, ShieldAlert, XCircle } from 'lucide-react';
import type { ScanSummary, WordPressReportDTO, WpPluginDTO, WpRisk } from '@wpcg/shared';
import { fmtDateTime } from '../lib/format';
import { Badge, Card, CardHeader, cx } from './ui';

// ---------------------------------------------------------------- verification

/** Confirmed vs needs-manual-review vs pending, plus detections the re-check proved wrong. */
export function VerificationPanel({ counts, summary }: { counts: { confirmed: number; needsManualReview: number; pendingVerification: number }; summary: ScanSummary }) {
  const v = summary.verification;
  const tiles = [
    { label: 'Confirmed issues', value: counts.confirmed, help: 'Reproduced by a deterministic check; single observations were re-requested before reporting.', icon: <CheckCircle2 className="size-4 text-emerald-600" aria-hidden /> },
    { label: 'Needs manual review', value: counts.needsManualReview, help: 'The tool could not decide (for example contrast over an image). Not counted as defects.', icon: <SearchCheck className="size-4 text-violet-500" aria-hidden /> },
    { label: 'Pending verification', value: counts.pendingVerification, help: 'Seen once but not reproduced (blocked, rate-limited, timed out or intermittent). Not counted as defects.', icon: <CircleHelp className="size-4 text-slate-400" aria-hidden /> },
  ];
  return (
    <Card>
      <CardHeader title="Verification" description="Only confirmed issues count as defects and appear in the priority totals." />
      <div className="grid gap-3 p-5 sm:grid-cols-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-slate-200 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
              {t.icon}
              {t.label}
            </div>
            <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{t.value}</div>
            <p className="mt-1 text-xs text-slate-500">{t.help}</p>
          </div>
        ))}
      </div>
      {v && (
        <div className="border-t border-slate-100 px-5 py-4 text-sm text-slate-700">
          <p>
            {v.checked} single-observation detection{v.checked === 1 ? '' : 's'} (images that did not render, links that failed) {v.checked === 1 ? 'was' : 'were'} re-requested before reporting: {v.confirmed} confirmed, {v.pending} pending, {v.dismissed.length} dismissed as false positive{v.dismissed.length === 1 ? '' : 's'}.
          </p>
          {v.dismissed.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer rounded font-medium text-slate-800">Dismissed false positives ({v.dismissed.length})</summary>
              <ul className="mt-2 space-y-2">
                {v.dismissed.slice(0, 50).map((d) => (
                  <li key={d.rule + d.item} className="rounded-lg border border-slate-200 p-3">
                    <code className="font-mono text-xs break-all text-slate-800">{d.item}</code>
                    <p className="mt-1 text-xs text-slate-600">{d.reason}</p>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- WordPress and plugins

const RISK: Record<WpRisk, { label: string; cls: string }> = {
  critical: { label: 'Critical', cls: 'border-red-200 bg-red-50 text-red-800' },
  high: { label: 'High', cls: 'border-orange-200 bg-orange-50 text-orange-800' },
  medium: { label: 'Medium', cls: 'border-amber-200 bg-amber-50 text-amber-800' },
  low: { label: 'Low', cls: 'border-sky-200 bg-sky-50 text-sky-800' },
  none: { label: 'No known risk', cls: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
  unknown: { label: 'Unknown', cls: 'border-slate-300 bg-slate-100 text-slate-700' },
};

const RiskBadge = ({ risk }: { risk: WpRisk }) => <Badge className={RISK[risk].cls}>{RISK[risk].label}</Badge>;
const unknown = <span className="text-slate-500">Unable to verify</span>;

function UpdateStatus({ p }: { p: WpPluginDTO }) {
  if (p.updateStatus === 'up_to_date') return <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800"><CheckCircle2 className="size-3.5" aria-hidden />Up to date</Badge>;
  if (p.updateStatus === 'update_available') return <Badge className="border-amber-200 bg-amber-50 text-amber-800"><XCircle className="size-3.5" aria-hidden />Update available</Badge>;
  return <Badge className="border-slate-300 bg-slate-100 text-slate-700">Unknown</Badge>;
}

function latestText(p: WpPluginDTO) {
  if (p.latestVersion) return p.latestVersion;
  if (p.wordpressOrg === false) return <span className="text-slate-500">Not on WordPress.org</span>;
  if (p.wordpressOrg === 'closed') return <span className="text-orange-700">Closed on WordPress.org</span>;
  return unknown;
}

export function WordPressSection({ wp }: { wp: WordPressReportDTO | null | undefined }) {
  if (wp === undefined) return null; // scans from before this feature
  if (!wp || !wp.detected)
    return (
      <Card>
        <CardHeader title="WordPress and plugin information" icon={<ShieldAlert className="size-5" aria-hidden />} />
        <p className="p-5 text-sm text-slate-600">{wp ? 'No WordPress markers were found on the scanned pages, so this website does not appear to run WordPress (or hides it completely).' : 'Not available for this scan.'}</p>
      </Card>
    );
  const c = wp.core;
  return (
    <Card>
      <CardHeader
        title="WordPress and plugin information"
        description={`Checked ${fmtDateTime(wp.checkedAt)}. Every value comes from a named public source; anything that cannot be verified says so.`}
        icon={<ShieldAlert className="size-5" aria-hidden />}
      />
      <dl className="grid gap-x-6 gap-y-4 p-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs font-medium text-slate-500">WordPress version</dt>
          <dd className="mt-0.5 text-lg font-semibold text-slate-900">{c?.version ?? 'Unknown'}</dd>
          <dd className="text-xs text-slate-500">{c?.versionSource ? `${c.versionSource} (${c.confidence} confidence)` : 'The version is hidden on this site.'}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-slate-500">Core status (WordPress.org)</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2">
            {c?.status === 'latest' ? (
              <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800">Latest release</Badge>
            ) : c?.status === 'outdated' ? (
              <Badge className="border-amber-200 bg-amber-50 text-amber-800">Outdated</Badge>
            ) : c?.status === 'insecure' ? (
              <Badge className="border-red-200 bg-red-50 text-red-800">Insecure — update now</Badge>
            ) : (
              <Badge className="border-slate-300 bg-slate-100 text-slate-700">Unable to verify</Badge>
            )}
            {c && <RiskBadge risk={c.risk} />}
          </dd>
          <dd className="mt-1 text-xs text-slate-500">
            {c?.latestVersion ? `Latest: ${c.latestVersion}` : ''}
            {c?.vulnLookup === 'ok' ? ` · ${c.vulnerabilities.length} known vulnerabilit${c.vulnerabilities.length === 1 ? 'y' : 'ies'} for this version` : c?.vulnLookup === 'failed' ? ' · vulnerability lookup failed' : ''}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-slate-500">Total installed plugins</dt>
          <dd className="mt-0.5 text-lg font-semibold text-slate-900">Unable to verify</dd>
          <dd className="text-xs text-slate-500">Not readable from outside the site. {wp.detectedPlugins} detected on the public pages.</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-slate-500">Theme</dt>
          <dd className="mt-0.5 text-slate-900">
            {wp.themes.length
              ? wp.themes.map((t) => (
                  <span key={t.slug} className="block">
                    {t.name ?? t.slug} {t.version ? `· ${t.version}` : '· version unknown'}
                    {t.latestVersion && t.version ? (t.latestVersion === t.version ? ' (up to date)' : ` (latest ${t.latestVersion})`) : ''}
                  </span>
                ))
              : 'Unknown'}
          </dd>
        </div>
      </dl>

      {c && c.vulnerabilities.length > 0 && (
        <div className="px-5 pb-4">
          <VulnList vulns={c.vulnerabilities} />
        </div>
      )}

      <div className="overflow-x-auto border-t border-slate-100" tabIndex={0} role="region" aria-label="Detected plugins (scrolls sideways)">
        <table className="table-base min-w-[56rem]">
          <caption className="sr-only">Detected plugins with installed and latest versions, update status and risk</caption>
          <thead>
            <tr>
              <th scope="col">Plugin</th>
              <th scope="col">Installed</th>
              <th scope="col">Latest</th>
              <th scope="col">Update status</th>
              <th scope="col">Risk</th>
            </tr>
          </thead>
          <tbody>
            {wp.plugins.map((p) => (
              <tr key={p.slug}>
                <td>
                  <div className="font-medium text-slate-900">{p.name ?? p.slug}</div>
                  {p.name && <div className="font-mono text-xs text-slate-500">{p.slug}</div>}
                </td>
                <td>
                  <div className="text-slate-900">{p.installedVersion ?? unknown}</div>
                  {p.versionSource && <div className={cx('text-xs', p.versionConfidence === 'low' ? 'text-amber-700' : 'text-slate-500')}>{p.versionSource}</div>}
                </td>
                <td>{latestText(p)}</td>
                <td>
                  <UpdateStatus p={p} />
                </td>
                <td className="max-w-md">
                  <RiskBadge risk={p.risk} />
                  <p className="mt-1 text-xs text-slate-600">{p.riskReason}</p>
                  {p.vulnerabilities.length > 0 && <VulnList vulns={p.vulnerabilities} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!wp.plugins.length && <p className="px-5 py-6 text-sm text-slate-600">No plugins were identified from the public pages. That does not mean none are installed.</p>}
      </div>

      <details className="border-t border-slate-100 px-5 py-4 text-sm">
        <summary className="cursor-pointer rounded font-medium text-slate-800">Sources and limitations</summary>
        <p className="mt-2 text-xs font-medium text-slate-500">Detected from</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">
          {wp.markers.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs font-medium text-slate-500">Data sources</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">
          {wp.sources.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs font-medium text-slate-500">Limitations</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">
          {wp.limitations.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

function VulnList({ vulns }: { vulns: WordPressReportDTO['plugins'][number]['vulnerabilities'] }) {
  return (
    <ul className="mt-2 space-y-1.5">
      {vulns.slice(0, 8).map((v) => (
        <li key={v.title + v.affects} className="rounded-lg border border-slate-200 p-2 text-xs">
          <div className="font-medium text-slate-900">{v.title}</div>
          <div className="text-slate-600">
            {v.cve ?? 'No CVE'} · {v.severity ?? 'severity not published'}
            {v.cvssScore !== null ? ` (CVSS ${v.cvssScore})` : ''} · affects {v.affects} · {v.unfixed ? 'no fix available yet' : v.fixedIn ? `fixed in ${v.fixedIn}` : 'fix version not stated'}
          </div>
          {v.references[0] && (
            <a href={v.references[0]} target="_blank" rel="noreferrer noopener" className="text-brand-700 hover:underline">
              Source
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
