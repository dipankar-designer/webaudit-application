import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Activity, Check, Copy, HeartPulse, Pause, Play, PlusCircle, RefreshCw, Settings2, ShieldAlert, Trash2 } from 'lucide-react';
import {
  PLANS,
  WATCHERS,
  WATCHER_KEYS,
  type CheckResultDTO,
  type IncidentDTO,
  type MonitorDTO,
  type MonitoringOverviewDTO,
  type WatcherKey,
} from '@wpcg/shared';
import { del, errorMessage, patch, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useSession } from '../lib/session';
import { fmtDateTime, fmtRelative, hostOf } from '../lib/format';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, LinkButton, LoadingState, RefreshFailed, Modal, PageHeader, Stat, cx } from '../components/ui';
import { MonitorStatusBadge, PriorityBadge, ResponseChart, Segmented, STATUS_META, UptimeBars, fmtInterval, fmtMs, fmtPct, type DayBar, type SeriesPoint } from '../components/monitoring';

// ---------------------------------------------------------------- shared banners

/** Honest health banners: no scheduler heartbeat means no checks are running. */
export function MonitoringHealth({ overview }: { overview: MonitoringOverviewDTO }) {
  return (
    <>
      {overview.monitors > 0 && !overview.scheduler.healthy && (
        <Alert tone="warning" className="mb-4" title="Checks are not running">
          The monitoring scheduler has not reported in{overview.scheduler.lastBeatAt ? ` since ${fmtDateTime(overview.scheduler.lastBeatAt)}` : ''}. Results below are the last ones recorded. Start the worker
          (<code className="font-mono">npm run worker</code>, or <code className="font-mono">RUN_WORKER_IN_PROCESS=true</code>) to resume monitoring.
        </Alert>
      )}
      {overview.monitors > 0 && !overview.emailConfigured && (
        <Alert tone="info" className="mb-4" title="E-mail alerts are not configured on this server">
          Incidents are recorded and shown here, but no e-mail is sent until an operator sets <code className="font-mono">SMTP_HOST</code>.
        </Alert>
      )}
    </>
  );
}

export function MonitoringStats({ o }: { o: MonitoringOverviewDTO }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
      <Stat label="Up" value={o.up} tone={o.up ? 'good' : 'default'} to="/monitors" />
      <Stat label="Down" value={o.down} tone={o.down ? 'critical' : 'default'} to="/monitors" />
      <Stat label="Warnings" value={o.warning} tone={o.warning ? 'high' : 'default'} to="/monitors" />
      <Stat label="Not assessed" value={o.notAssessed} to="/monitors" help="The site blocked or challenged our checks, so there is no verdict. This is never counted as downtime." />
      <Stat label="Open incidents" value={o.openIncidents} tone={o.openIncidents ? 'critical' : 'default'} to="/incidents" />
      <Stat label="Uptime (30 days)" value={fmtPct(o.uptime30d)} hint={`${o.monitors} monitor${o.monitors === 1 ? '' : 's'}${o.paused ? `, ${o.paused} paused` : ''}`} />
    </div>
  );
}

// ---------------------------------------------------------------- list

export function MonitorsPage() {
  const list = useApi<MonitorDTO[]>('/monitors', { pollMs: 30_000, shouldPoll: () => true });
  const overview = useApi<MonitoringOverviewDTO>('/monitors/overview', { pollMs: 30_000, shouldPoll: () => true });

  return (
    <>
      <PageHeader
        title="Monitors"
        description="Round-the-clock checks of uptime, certificates, security and changes. Results come only from real checks; blocked checks are shown as Not assessed."
        actions={
          <LinkButton to="/monitors/new" icon={<PlusCircle className="size-4" aria-hidden />}>
            Add monitor
          </LinkButton>
        }
      />
      <RefreshFailed error={list.data ? list.error : null} onRetry={list.reload} />
      {overview.data && <MonitoringHealth overview={overview.data} />}
      {list.loading && !list.data ? (
        <LoadingState />
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : !list.data?.length ? (
        <Card>
          <EmptyState
            icon={<Activity className="size-6" aria-hidden />}
            title="Add your first monitor"
            action={
              <LinkButton to="/monitors/new" icon={<PlusCircle className="size-4" aria-hidden />}>
                Add monitor
              </LinkButton>
            }
          >
            Watch a website for downtime, certificate and domain expiry, security problems and unexpected changes, or add a heartbeat monitor for a cron job or backup.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          {overview.data && <MonitoringStats o={overview.data} />}
          <Card>
            <CardHeader title="All monitors" description="Uptime and average response time from the uptime watcher." />
            <ul className="divide-y divide-slate-100">
              {list.data.map((m) => (
                <MonitorRow key={m.id} m={m} />
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

function MonitorRow({ m }: { m: MonitorDTO }) {
  const s = STATUS_META[m.status];
  return (
    <li>
      <Link to={`/monitors/${m.id}`} className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4 hover:bg-slate-50">
        <span className={cx('size-3 shrink-0 rounded-full ring-4 ring-slate-100', s.dot)} aria-hidden />
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-slate-900">{m.name}</span>
            {m.kind === 'heartbeat' && <HeartPulse className="size-4 shrink-0 text-slate-500" aria-label="Heartbeat monitor" />}
          </div>
          <div className="truncate text-xs text-slate-500">
            {m.url ? hostOf(m.url) : 'Heartbeat'} · every {fmtInterval(m.intervalSeconds)} · {m.watchers.filter((w) => w.enabled).length} watcher{m.watchers.filter((w) => w.enabled).length === 1 ? '' : 's'}
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-x-6 text-right text-xs max-md:order-last max-md:w-full max-md:text-left">
          <div>
            <dt className="text-slate-500">24 h</dt>
            <dd className="font-semibold text-slate-900 tabular-nums">{fmtPct(m.uptime24h)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">30 days</dt>
            <dd className="font-semibold text-slate-900 tabular-nums">{fmtPct(m.uptime30d)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Response</dt>
            <dd className="font-semibold text-slate-900 tabular-nums">{fmtMs(m.avgResponseMs24h)}</dd>
          </div>
        </dl>
        <div className="flex w-44 items-center justify-end gap-2 max-md:w-auto">
          {m.openIncidents > 0 && <Badge className="border-red-200 bg-red-50 text-red-800">{m.openIncidents} open</Badge>}
          <MonitorStatusBadge status={m.status} />
        </div>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------- create / edit form

const INTERVALS = [30, 60, 120, 300, 600, 900, 1800, 3600];

interface FormValues {
  kind: 'website' | 'heartbeat';
  name: string;
  url: string;
  intervalSeconds: number;
  keyword: string;
  keywordMode: 'present' | 'absent';
  moneyPage: boolean;
  watchers: WatcherKey[];
  exposureAuthorised: boolean;
  heartbeatGraceSeconds: number;
}

function MonitorForm({ initial, editing, onSubmit, submitLabel }: { initial: FormValues; editing?: boolean; onSubmit: (v: FormValues, authorised: boolean) => Promise<void>; submitLabel: string }) {
  const { session } = useSession();
  const plan = PLANS[session?.workspace.plan ?? 'free'];
  // After a downgrade a monitor can hold settings the plan no longer allows; start from allowed values,
  // or every save (even a rename) would be refused.
  const [v, setV] = useState<FormValues>(() => ({
    ...initial,
    intervalSeconds: Math.max(initial.intervalSeconds, plan.minIntervalSeconds),
    watchers: initial.watchers.filter((w) => w === 'uptime' || plan.watchers.includes(w)),
  }));
  const [authorised, setAuthorised] = useState(!!editing);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormValues>(k: K, val: FormValues[K]) => setV((p) => ({ ...p, [k]: val }));
  const toggle = (w: WatcherKey) => set('watchers', v.watchers.includes(w) ? v.watchers.filter((x) => x !== w) : [...v.watchers, w]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!authorised) return setError('Confirm that you own this website or have permission to monitor it.');
    if (v.watchers.includes('exposure') && !v.exposureAuthorised) return setError('Tick the extra authorisation for the exposed-files watcher, or switch it off.');
    setBusy(true);
    setError(null);
    try {
      await onSubmit(v, authorised);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      {error && <Alert tone="error">{error}</Alert>}
      {!editing && (
        <fieldset>
          <legend className="label">What do you want to monitor?</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ['website', 'A website', 'Uptime, certificate, security and change watchers.'],
                ['heartbeat', 'A cron job or backup', 'Your job calls a private URL; we alert when it stops.'],
              ] as const
            ).map(([k, l, d]) => (
              <label key={k} className={cx('flex cursor-pointer gap-3 rounded-lg border p-3', v.kind === k ? 'border-brand-600 bg-brand-50' : 'border-slate-300 hover:bg-slate-100')}>
                <input type="radio" name="kind" className="mt-1 accent-brand-600" checked={v.kind === k} onChange={() => set('kind', k)} />
                <span>
                  <span className="block text-sm font-medium text-slate-900">{l}</span>
                  <span className="block text-xs text-slate-600">{d}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="m-name" className="label">
            Name
          </label>
          <input id="m-name" className="input" required maxLength={100} value={v.name} onChange={(e) => set('name', e.target.value)} placeholder={v.kind === 'heartbeat' ? 'Nightly backup' : 'Company website'} />
        </div>
        {v.kind === 'website' && !editing && (
          <div>
            <label htmlFor="m-url" className="label">
              Address
            </label>
            <input id="m-url" className="input" type="url" inputMode="url" autoComplete="url" required value={v.url} onChange={(e) => set('url', e.target.value)} placeholder="https://example.com" />
          </div>
        )}
        <div>
          <label htmlFor="m-int" className="label">
            {v.kind === 'heartbeat' ? 'Expected every' : 'Check uptime every'}
          </label>
          <select id="m-int" className="input" value={v.intervalSeconds} onChange={(e) => set('intervalSeconds', Number(e.target.value))}>
            {INTERVALS.map((s) => (
              <option key={s} value={s} disabled={s < plan.minIntervalSeconds}>
                {fmtInterval(s)}
                {s < plan.minIntervalSeconds ? ' (paid plans)' : ''}
              </option>
            ))}
            {v.kind === 'heartbeat' && <option value={86400}>1 day</option>}
          </select>
        </div>
        {v.kind === 'heartbeat' && (
          <div>
            <label htmlFor="m-grace" className="label">
              Grace period
            </label>
            <select id="m-grace" className="input" value={v.heartbeatGraceSeconds} onChange={(e) => set('heartbeatGraceSeconds', Number(e.target.value))}>
              {[60, 300, 900, 3600].map((s) => (
                <option key={s} value={s}>
                  {fmtInterval(s)}
                </option>
              ))}
            </select>
            <p className="help">How late a ping may be before we alert.</p>
          </div>
        )}
      </div>

      {v.kind === 'website' && (
        <>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div>
              <label htmlFor="m-kw" className="label">
                Keyword (optional)
              </label>
              <input id="m-kw" className="input" maxLength={200} value={v.keyword} onChange={(e) => set('keyword', e.target.value)} placeholder="e.g. Add to basket" aria-describedby="m-kw-help" />
              <p id="m-kw-help" className="help">
                Catches a page that loads but shows the wrong content.
              </p>
            </div>
            <div>
              <label htmlFor="m-kwm" className="label">
                Alert when the keyword is
              </label>
              <select id="m-kwm" className="input" value={v.keywordMode} onChange={(e) => set('keywordMode', e.target.value as 'present' | 'absent')} disabled={!v.keyword}>
                <option value="present">missing</option>
                <option value="absent">present</option>
              </select>
            </div>
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={v.moneyPage} onChange={(e) => set('moneyPage', e.target.checked)} />
            <span>
              <span className="font-medium text-slate-900">This is a money page</span>
              <span className="block text-xs text-slate-600">Checkout, booking or donation pages: outages are raised as P1 like the homepage.</span>
            </span>
          </label>

          <fieldset>
            <legend className="label">Watchers</legend>
            <p className="help mb-3 !mt-0">Each watcher runs on its own schedule and only alerts when its result changes.</p>
            <ul className="grid gap-2 md:grid-cols-2">
              {WATCHER_KEYS.map((k) => {
                const w = WATCHERS[k];
                const allowed = plan.watchers.includes(k);
                const required = k === 'uptime';
                return (
                  <li key={k}>
                    <label className={cx('flex h-full gap-3 rounded-lg border p-3', allowed ? 'cursor-pointer border-slate-300 hover:bg-slate-100' : 'border-slate-200 opacity-75')}>
                      <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-brand-600" checked={v.watchers.includes(k)} disabled={!allowed || required} onChange={() => toggle(k)} />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
                          {w.label}
                          {!allowed && <Badge className="border-brand-200 bg-brand-50 text-brand-800">Pro</Badge>}
                          {w.optIn && <Badge className="border-amber-200 bg-amber-50 text-amber-800">Opt-in</Badge>}
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-600">{w.description}</span>
                        <span className="mt-1 block text-xs text-slate-500">{w.defaultInterval ? `Every ${fmtInterval(w.defaultInterval)}` : 'On the uptime schedule'}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          {v.watchers.includes('exposure') && (
            <Alert tone="warning" title="Exposed-files watcher: extra authorisation">
              <p>Once a week this watcher requests about 45 well-known sensitive paths (backups, .env, .git). A firewall may log these as an attack. Only matching content is reported; file contents are never stored.</p>
              <label className="mt-2 flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={v.exposureAuthorised} onChange={(e) => set('exposureAuthorised', e.target.checked)} />
                <span>I am responsible for this website&rsquo;s security and authorise these probes.</span>
              </label>
            </Alert>
          )}
        </>
      )}

      {!editing && (
        <label className="flex items-start gap-3 rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={authorised} onChange={(e) => setAuthorised(e.target.checked)} />
          <span className="text-slate-800">I own this website or job, or I have the owner&rsquo;s permission to monitor it.</span>
        </label>
      )}
      <div className="flex justify-end">
        <Button type="submit" loading={busy} disabled={!authorised}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function NewMonitorPage() {
  const navigate = useNavigate();
  const { session } = useSession();
  const plan = PLANS[session?.workspace.plan ?? 'free'];
  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/monitors" className="hover:underline">
            Monitors
          </Link>
        }
        title="Add monitor"
        description={`${plan.name} plan: up to ${plan.maxMonitors} monitors, checks every ${fmtInterval(plan.minIntervalSeconds)} at most, ${plan.monitorHistoryDays} days of history.`}
      />
      <Card className="max-w-4xl">
        <div className="p-5 sm:p-6">
          <MonitorForm
            submitLabel="Start monitoring"
            initial={{ kind: 'website', name: '', url: '', intervalSeconds: Math.max(300, plan.minIntervalSeconds), keyword: '', keywordMode: 'present', moneyPage: false, watchers: ['uptime', 'tls', 'https'], exposureAuthorised: false, heartbeatGraceSeconds: 300 }}
            onSubmit={async (v) => {
              const m = await post<MonitorDTO>('/monitors', {
                kind: v.kind,
                name: v.name,
                url: v.kind === 'website' ? v.url : undefined,
                intervalSeconds: v.intervalSeconds,
                keyword: v.keyword || null,
                keywordMode: v.keyword ? v.keywordMode : null,
                moneyPage: v.moneyPage,
                watchers: v.kind === 'website' ? v.watchers : [],
                exposureAuthorised: v.exposureAuthorised,
                heartbeatGraceSeconds: v.heartbeatGraceSeconds,
                authorised: true,
              });
              navigate(`/monitors/${m.id}`);
            }}
          />
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- detail

type Range = '24h' | '7d' | '30d';

export function MonitorDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const m = useApi<MonitorDTO>(`/monitors/${id}`, { pollMs: 20_000, shouldPoll: () => true });
  const [range, setRange] = useState<Range>('24h');
  const series = useApi<{ points: SeriesPoint[]; days: DayBar[] }>(`/monitors/${id}/series?range=${range}`, { pollMs: 60_000, shouldPoll: () => true });
  const incidents = useApi<IncidentDTO[]>(`/incidents?monitorId=${id}&limit=20`);
  const [resultKey, setResultKey] = useState<string>('');
  const results = useApi<CheckResultDTO[]>(`/monitors/${id}/results?limit=30${resultKey ? `&checkKey=${resultKey}` : ''}`);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (m.loading && !m.data) return <LoadingState />;
  if (m.error && !m.data) return <ErrorState error={m.error} onRetry={m.reload} />;
  const mon = m.data!;

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      setNotice({ tone: 'success', text: ok });
      m.reload();
      results.reload();
    } catch (e) {
      setNotice({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const enabledWatchers = mon.watchers.filter((w) => w.enabled);

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/monitors" className="hover:underline">
            Monitors
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {mon.name}
            <MonitorStatusBadge status={mon.status} />
          </span>
        }
        description={
          mon.url ? (
            <a href={mon.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
              {mon.url}
            </a>
          ) : (
            'Heartbeat monitor'
          )
        }
        actions={
          <>
            <Button variant="secondary" loading={busy === 'run'} disabled={!mon.enabled} onClick={() => act('run', () => post(`/monitors/${mon.id}/run`), 'Checks scheduled. Results appear here within a minute.')} icon={<RefreshCw className="size-4" aria-hidden />}>
              Check now
            </Button>
            <Button
              variant="secondary"
              loading={busy === 'pause'}
              onClick={() => act('pause', () => patch(`/monitors/${mon.id}`, { enabled: !mon.enabled }), mon.enabled ? 'Monitoring paused. Open incidents were closed.' : 'Monitoring resumed.')}
              icon={mon.enabled ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
            >
              {mon.enabled ? 'Pause' : 'Resume'}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(true)} icon={<Settings2 className="size-4" aria-hidden />}>
              Settings
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete monitor" icon={<Trash2 className="size-4" aria-hidden />} />
          </>
        }
      />
      <RefreshFailed error={m.data ? m.error : null} onRetry={m.reload} />
      {notice && (
        <Alert tone={notice.tone} className="mb-4" onDismiss={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          <Stat label="Uptime (24 h)" value={fmtPct(mon.uptime24h)} tone={mon.uptime24h !== null && mon.uptime24h < 99 ? 'critical' : 'default'} />
          <Stat label="Uptime (7 days)" value={fmtPct(mon.uptime7d)} />
          <Stat label="Uptime (30 days)" value={fmtPct(mon.uptime30d)} />
          <Stat label="Avg response (24 h)" value={fmtMs(mon.avgResponseMs24h)} help="Average total response time of successful uptime checks. First-byte time is in the chart tooltip." />
          <Stat label="Last checked" value={<span className="text-xl">{fmtRelative(mon.lastCheckedAt)}</span>} hint={`Every ${fmtInterval(mon.intervalSeconds)}`} />
        </div>

        {mon.kind === 'heartbeat' && mon.heartbeatUrl && <HeartbeatHelp url={mon.heartbeatUrl} last={mon.lastHeartbeatAt} />}

        <Card>
          <CardHeader
            title="Response time"
            description={mon.kind === 'heartbeat' ? 'Heartbeat checks' : 'Total time to load the page, from our server'}
            actions={
              <Segmented<Range>
                label="Time range"
                value={range}
                onChange={setRange}
                options={[
                  { value: '24h', label: '24 h' },
                  { value: '7d', label: '7 days' },
                  { value: '30d', label: '30 days' },
                ]}
              />
            }
          />
          <div className="p-5">{series.data ? <ResponseChart points={series.data.points} range={range} /> : series.error ? <ErrorState error={series.error} onRetry={series.reload} /> : <LoadingState />}</div>
        </Card>

        <Card>
          <CardHeader title="Daily uptime" description="Not-assessed checks (blocked or challenged) are excluded from the percentage." />
          <div className="p-5">{series.data ? <UptimeBars days={series.data.days} /> : <LoadingState />}</div>
        </Card>

        <div className="grid gap-6 xl:grid-cols-5 [&>*]:min-w-0">
          <Card className="xl:col-span-3">
            <CardHeader title="Watchers" description={`${enabledWatchers.length} active. Each keeps its own schedule and history.`} />
            <ul className="divide-y divide-slate-100">
              {enabledWatchers.map((w) => (
                <li key={w.key} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">{WATCHERS[w.key].label}</h3>
                    <MonitorStatusBadge status={w.entitled ? w.lastStatus : 'paused'} />
                    {w.lastSeverity && w.lastStatus !== 'up' && <PriorityBadge priority={w.lastSeverity} short />}
                    <span className="ml-auto text-xs text-slate-500">
                      every {fmtInterval(w.intervalSeconds)} · {w.lastRunAt ? `ran ${fmtRelative(w.lastRunAt)}` : 'not run yet'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-slate-700">{!w.entitled ? 'Not included in your current plan, so this watcher is paused.' : (w.lastSummary ?? WATCHERS[w.key].description)}</p>
                  {(w.key === 'defacement' || w.key === 'scripts') && w.lastStatus === 'warning' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-2"
                      loading={busy === `accept-${w.key}`}
                      onClick={() => act(`accept-${w.key}`, () => post(`/monitors/${mon.id}/checks/${w.key}/accept`), 'Accepted. The next run records the current page as the new baseline.')}
                      icon={<Check className="size-3.5" aria-hidden />}
                    >
                      This change was expected
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card className="xl:col-span-2">
            <CardHeader title="Incidents" actions={<Link to="/incidents" className="text-sm font-medium text-brand-700 hover:underline">All incidents</Link>} />
            {incidents.data?.length ? (
              <ul className="divide-y divide-slate-100">
                {incidents.data.map((i) => (
                  <li key={i.id} className="px-5 py-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <PriorityBadge priority={i.severity} short />
                      <Badge className={i.status === 'open' ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}>{i.status === 'open' ? 'Open' : 'Resolved'}</Badge>
                      <span className="text-xs text-slate-500">{fmtRelative(i.openedAt)}</span>
                    </div>
                    <p className="mt-1 text-sm text-slate-800">{i.title}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-slate-500">{incidents.loading ? 'Loading…' : 'No incidents in the history period.'}</p>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Check history"
            description="Every run is stored with its time, outcome and the number of attempts."
            actions={
              <>
                <label htmlFor="res-key" className="sr-only">
                  Watcher
                </label>
                <select id="res-key" className="input !w-auto !py-1.5" value={resultKey} onChange={(e) => setResultKey(e.target.value)}>
                  <option value="">All watchers</option>
                  {mon.watchers.map((w) => (
                    <option key={w.key} value={w.key}>
                      {WATCHERS[w.key].label}
                    </option>
                  ))}
                </select>
              </>
            }
          />
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Check history (scrolls sideways)">
            <table className="table-base min-w-[52rem]">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Watcher</th>
                  <th scope="col">Result</th>
                  <th scope="col">Details</th>
                  <th scope="col" className="text-right">
                    Response
                  </th>
                </tr>
              </thead>
              <tbody>
                {results.data?.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-slate-600">{fmtDateTime(r.startedAt)}</td>
                    <td className="whitespace-nowrap">{WATCHERS[r.checkKey]?.label ?? r.checkKey}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        <MonitorStatusBadge status={r.status} />
                        {r.severity && r.status !== 'up' && <PriorityBadge priority={r.severity} short />}
                      </div>
                    </td>
                    <td className="min-w-72 text-slate-700">
                      {r.summary}
                      {r.attempts > 1 && <span className="ml-1 text-xs text-slate-500">({r.attempts} attempts)</span>}
                    </td>
                    <td className="text-right whitespace-nowrap tabular-nums">{fmtMs(r.responseMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {results.data && !results.data.length && <p className="px-5 py-8 text-center text-sm text-slate-500">No results yet.</p>}
          </div>
        </Card>
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} title="Monitor settings">
        {editing && (
          <MonitorForm
            editing
            submitLabel="Save changes"
            initial={{
              kind: mon.kind,
              name: mon.name,
              url: mon.url ?? '',
              intervalSeconds: mon.intervalSeconds,
              keyword: mon.keyword ?? '',
              keywordMode: mon.keywordMode ?? 'present',
              moneyPage: mon.moneyPage,
              watchers: mon.watchers.filter((w) => w.enabled && w.key !== 'heartbeat').map((w) => w.key as WatcherKey),
              exposureAuthorised: mon.exposureAuthorised,
              heartbeatGraceSeconds: mon.heartbeatGraceSeconds,
            }}
            onSubmit={async (v) => {
              await patch(`/monitors/${mon.id}`, {
                name: v.name,
                intervalSeconds: v.intervalSeconds,
                keyword: v.keyword || null,
                keywordMode: v.keyword ? v.keywordMode : null,
                moneyPage: v.moneyPage,
                ...(mon.kind === 'website' ? { watchers: v.watchers, exposureAuthorised: v.exposureAuthorised } : { heartbeatGraceSeconds: v.heartbeatGraceSeconds }),
              });
              setEditing(false);
              setNotice({ tone: 'success', text: 'Settings saved.' });
              m.reload();
            }}
          />
        )}
      </Modal>
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this monitor?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy === 'delete'}
              onClick={async () => {
                setBusy('delete');
                try {
                  await del(`/monitors/${mon.id}`);
                  navigate('/monitors');
                } catch (e) {
                  setNotice({ tone: 'error', text: errorMessage(e) });
                  setConfirmDelete(false);
                } finally {
                  setBusy(null);
                }
              }}
            >
              Delete monitor
            </Button>
          </>
        }
      >
        Its check history and incidents are deleted too. This cannot be undone.
      </Modal>
    </>
  );
}

function HeartbeatHelp({ url, last }: { url: string; last: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <Card>
      <CardHeader title="Ping URL" description={last ? `Last ping ${fmtRelative(last)} (${fmtDateTime(last)})` : 'No ping received yet.'} icon={<ShieldAlert className="size-5" aria-hidden />} />
      <div className="space-y-3 p-5">
        <div className="flex gap-2">
          <code className="code-block flex-1 !whitespace-nowrap">{url}</code>
          <Button
            variant="secondary"
            aria-label="Copy ping URL"
            onClick={async () => {
              await navigator.clipboard.writeText(url).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            icon={copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-sm text-slate-600">Call it at the end of your job, for example:</p>
        <pre className="code-block">{`# crontab
0 2 * * * /usr/local/bin/backup.sh && curl -fsS --retry 3 ${url} > /dev/null`}</pre>
        <p className="text-xs text-slate-500">Keep this URL private: anyone with it can report the job as healthy.</p>
      </div>
    </Card>
  );
}
