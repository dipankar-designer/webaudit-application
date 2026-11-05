import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { BellRing, CheckCircle2, Mail, Send, Trash2 } from 'lucide-react';
import { PRIORITIES, PRIORITY_LABELS, WATCHERS, type AlertContactDTO, type AlertDeliveryDTO, type IncidentDTO, type Priority } from '@wpcg/shared';
import { del, errorMessage, patch, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useSession } from '../lib/session';
import { fmtDateTime, fmtRelative, hostOf } from '../lib/format';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, RefreshFailed, PageHeader } from '../components/ui';
import { PriorityBadge, Segmented } from '../components/monitoring';

function duration(from: string, to: string | null): string {
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

// ---------------------------------------------------------------- incidents

export function IncidentsPage() {
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const { data, error, loading, reload } = useApi<IncidentDTO[]>(`/incidents?status=${status}`, { pollMs: 30_000, shouldPoll: () => true });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Incidents"
        description="One incident per problem, opened when a watcher fails after retries and resolved automatically when it passes again. Blocked checks never open or close an incident."
        actions={
          <Segmented
            label="Show"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'resolved', label: 'Resolved' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      />
      <RefreshFailed error={data ? error : null} onRetry={reload} />
      {err && (
        <Alert tone="error" className="mb-4" onDismiss={() => setErr(null)}>
          {err}
        </Alert>
      )}
      {loading && !data ? (
        <LoadingState />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={<CheckCircle2 className="size-6" aria-hidden />} title={status === 'open' ? 'No open incidents' : 'No incidents in this period'}>
            {status === 'open' ? 'Every watcher passed its last check, or was not assessed.' : 'History is kept for your plan’s history period.'}
          </EmptyState>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {data.map((i) => (
              <li key={i.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-4">
                <div className="flex shrink-0 flex-col gap-1.5">
                  <PriorityBadge priority={i.severity} short />
                </div>
                <div className="min-w-0 flex-1 basis-64">
                  <p className="font-medium text-slate-900">{i.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    <Link to={`/monitors/${i.monitorId}`} className="font-medium text-brand-700 hover:underline">
                      {i.monitorName}
                    </Link>
                    {i.monitorUrl && ` · ${hostOf(i.monitorUrl)}`} · {WATCHERS[i.checkKey]?.label ?? i.checkKey}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    Opened {fmtDateTime(i.openedAt)} · {i.status === 'open' ? `ongoing for ${duration(i.openedAt, null)}` : `resolved after ${duration(i.openedAt, i.resolvedAt)}`} · seen {i.occurrences} time
                    {i.occurrences === 1 ? '' : 's'}, last {fmtRelative(i.lastSeenAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {i.status === 'open' ? <Badge className="border-red-200 bg-red-50 text-red-800">Open</Badge> : <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800">Resolved</Badge>}
                  {i.status === 'open' &&
                    (i.acknowledgedAt ? (
                      <Badge className="border-slate-300 bg-slate-100 text-slate-700" title={`Acknowledged ${fmtDateTime(i.acknowledgedAt)}`}>
                        Acknowledged
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === i.id}
                        onClick={async () => {
                          setBusy(i.id);
                          try {
                            await post(`/incidents/${i.id}/ack`);
                            reload();
                          } catch (e) {
                            setErr(errorMessage(e));
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Acknowledge
                      </Button>
                    ))}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- alerts

interface AlertsData {
  emailConfigured: boolean;
  /** Set when mail goes to the local development inbox instead of real mailboxes. */
  devInboxUrl?: string | null;
  minSeverity: Priority;
  maxContacts: number;
  contacts: AlertContactDTO[];
  deliveries: AlertDeliveryDTO[];
}

const DELIVERY_STYLE: Record<AlertDeliveryDTO['status'], string> = {
  sent: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  failed: 'border-red-200 bg-red-50 text-red-800',
  skipped: 'border-slate-300 bg-slate-100 text-slate-700',
};

export function AlertsPage() {
  const { session } = useSession();
  const canEdit = session?.workspace.role === 'owner' || session?.workspace.role === 'admin';
  const { data, error, loading, reload } = useApi<AlertsData>('/alerts');
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string | ((r: unknown) => string)) => {
    setBusy(key);
    setNotice(null);
    try {
      const r = await fn();
      if (ok) setNotice({ tone: 'success', text: typeof ok === 'function' ? ok(r) : ok });
      reload();
    } catch (e) {
      setNotice({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = String(new FormData(form).get('email') ?? '');
    void run('add', async () => {
      await post('/alerts/contacts', { email });
      form.reset();
    }, `${email} will receive alerts.`);
  };

  if (loading && !data) return <LoadingState />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const a = data!;

  return (
    <>
      <PageHeader title="Alerts" description="Who is e-mailed when an incident opens or resolves. Each incident alerts each contact once per event, never repeatedly." />
      {!a.emailConfigured && (
        <Alert tone="warning" className="mb-4" title="E-mail delivery is not configured on this server">
          Contacts are saved, but messages are recorded as skipped until an operator sets <code className="font-mono">SMTP_HOST</code> (see the deployment guide).
        </Alert>
      )}
      {a.emailConfigured && a.devInboxUrl && (
        <Alert tone="info" className="mb-4" title="Alerts go to the local test inbox">
          E-mails are delivered to the development inbox, not to real mailboxes.{' '}
          <a href={a.devInboxUrl} target="_blank" rel="noreferrer noopener" className="font-semibold underline">
            Open the test inbox
          </a>
          . Set a real SMTP provider in <code className="font-mono">.env</code> to e-mail the contacts below.
        </Alert>
      )}
      {notice && (
        <Alert tone={notice.tone} className="mb-4" onDismiss={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader title="E-mail contacts" description={`${a.contacts.length} of ${a.maxContacts} on your plan`} icon={<Mail className="size-5" aria-hidden />} />
          {a.contacts.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {a.contacts.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-900">{c.target}</span>
                  <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                    <input type="checkbox" className="size-4 accent-brand-600" checked={c.enabled} disabled={!canEdit || busy === c.id} onChange={(e) => run(c.id, () => patch(`/alerts/contacts/${c.id}`, { enabled: e.target.checked }))} />
                    Enabled
                  </label>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === `t${c.id}`}
                    disabled={!c.enabled}
                    onClick={() => run(`t${c.id}`, () => post<{ status: string; error?: string | null }>(`/alerts/contacts/${c.id}/test`), (r) => {
                      const res = r as { status: string; error?: string | null };
                      return res.status === 'sent' ? `Test e-mail sent to ${c.target}.` : res.status === 'skipped' ? 'Not sent: e-mail delivery is not configured on this server.' : `Delivery failed: ${res.error ?? 'unknown error'}`;
                    })}
                    icon={<Send className="size-3.5" aria-hidden />}
                  >
                    Send test
                  </Button>
                  {canEdit && <Button size="sm" variant="ghost" aria-label={`Remove ${c.target}`} loading={busy === `d${c.id}`} onClick={() => run(`d${c.id}`, () => del(`/alerts/contacts/${c.id}`))} icon={<Trash2 className="size-3.5" aria-hidden />} />}
                </li>
              ))}
            </ul>
          )}
          {canEdit ? (
            <form onSubmit={add} className="flex flex-wrap items-end gap-2 border-t border-slate-100 p-5">
              <div className="min-w-0 flex-1 basis-56">
                <label htmlFor="alert-email" className="label">
                  Add an e-mail address
                </label>
                <input id="alert-email" name="email" type="email" autoComplete="email" required className="input" placeholder="ops@example.com" />
              </div>
              <Button type="submit" loading={busy === 'add'} disabled={a.contacts.length >= a.maxContacts}>
                Add contact
              </Button>
            </form>
          ) : (
            <p className="p-5 text-sm text-slate-600">Only workspace owners and admins can change alert contacts.</p>
          )}
        </Card>

        <Card>
          <CardHeader title="When to alert" icon={<BellRing className="size-5" aria-hidden />} />
          <div className="space-y-3 p-5">
            <label htmlFor="min-sev" className="label">
              Send e-mail for incidents of priority
            </label>
            <select id="min-sev" className="input" value={a.minSeverity} disabled={!canEdit || busy === 'sev'} onChange={(e) => run('sev', () => patch('/alerts/settings', { minSeverity: e.target.value }), 'Alert threshold saved.')}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]} {p === 'p1' ? 'only' : 'and higher'}
                </option>
              ))}
            </select>
            <ul className="space-y-1.5 text-sm text-slate-700">
              <li>
                <strong className="text-slate-900">P1</strong> — site down, certificate expired or untrusted, exposed secrets, domain about to lapse.
              </li>
              <li>
                <strong className="text-slate-900">P2</strong> — a page down, de-indexing, defacement, a new third-party script, a certificate expiring within 14 days.
              </li>
              <li>
                <strong className="text-slate-900">P3</strong> — slow responses, missing security headers, mixed content, mail records, monitoring failures.
              </li>
              <li>
                <strong className="text-slate-900">P4</strong> — housekeeping such as version disclosure or a missing CAA record.
              </li>
            </ul>
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Delivery log" description="The last 50 messages, including failures and skipped sends." />
        {a.deliveries.length ? (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Delivery log (scrolls sideways)">
            <table className="table-base min-w-[40rem]">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">To</th>
                  <th scope="col">Event</th>
                  <th scope="col">Incident</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {a.deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap text-slate-600">{fmtDateTime(d.createdAt)}</td>
                    <td>{d.target}</td>
                    <td className="capitalize">{d.event}</td>
                    <td className="text-slate-700">{d.incidentTitle ?? (d.event === 'test' ? 'Test message' : '—')}</td>
                    <td>
                      <Badge className={DELIVERY_STYLE[d.status]} title={d.error ?? undefined}>
                        {d.status === 'sent' ? 'Sent' : d.status === 'failed' ? 'Failed' : 'Skipped'}
                      </Badge>
                      {d.error && <div className="mt-1 text-xs text-slate-500">{d.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-5 py-8 text-center text-sm text-slate-500">No alerts sent yet.</p>
        )}
      </Card>
    </>
  );
}
