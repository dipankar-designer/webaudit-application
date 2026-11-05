import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Check, CreditCard, ExternalLink, Minus } from 'lucide-react';
import { WATCHERS, type PlanId, type PlanLimits, type UsageDTO } from '@wpcg/shared';
import { errorMessage, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useSession } from '../lib/session';
import { fmtDate } from '../lib/format';
import { Alert, Button, Card, CardHeader, ErrorState, LoadingState, PageHeader, cx } from '../components/ui';
import { fmtInterval } from '../components/monitoring';

interface Billing {
  currentPlan: PlanId;
  plans: PlanLimits[];
  usage: UsageDTO;
  paymentsConfigured: boolean;
  purchasable: Record<'pro' | 'agency', boolean>;
  subscription: { status: string | null; periodEnd: string | null; planSource: 'default' | 'stripe' | 'operator'; hasCustomer: boolean };
  message: string;
}

const SUB_STATUS: Record<string, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment overdue — Stripe is retrying the card; access continues for now',
  unpaid: 'Unpaid — the plan has returned to Free',
  canceled: 'Cancelled — the plan has returned to Free',
  incomplete: 'Waiting for the first payment',
  incomplete_expired: 'First payment failed',
  paused: 'Paused',
};

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-700">{label}</span>
        <span className="tabular-nums text-slate-900">
          {used} / {limit}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-200" role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label={label}>
        <div className={cx('h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-400' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function BillingPage() {
  const [params, setParams] = useSearchParams();
  const checkout = params.get('checkout');
  const { refresh } = useSession();
  // After Stripe Checkout the plan changes only when Stripe's signed webhook arrives, so keep polling briefly.
  const [polls, setPolls] = useState(0);
  const { data, error, loading, reload } = useApi<Billing>('/billing', { pollMs: 3000, shouldPoll: (d) => checkout === 'success' && d.currentPlan === 'free' && polls < 20 });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (checkout === 'success' && data) {
      setPolls((n) => n + 1);
      if (data.currentPlan !== 'free') void refresh();
    }
  }, [data, checkout, refresh]);

  if (loading && !data) return <LoadingState />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const b = data!;

  const go = async (key: string, path: string, body?: unknown) => {
    setBusy(key);
    setErr(null);
    try {
      const r = await post<{ url: string }>(path, body);
      window.location.assign(r.url);
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(null);
    }
  };

  const rows: [string, (p: PlanLimits) => string | boolean][] = [
    ['Monitors', (p) => String(p.maxMonitors)],
    ['Fastest uptime check', (p) => `every ${fmtInterval(p.minIntervalSeconds)}`],
    ['Uptime, SSL/TLS and HTTPS watchers', () => true],
    ['Security headers, DNS, domain expiry', (p) => p.watchers.includes('headers')],
    ['Defacement, script and exposed-file watchers', (p) => p.watchers.includes('defacement')],
    ['Real-browser render and scheduled audits', (p) => p.watchers.includes('browser')],
    ['Monitoring history', (p) => `${p.monitorHistoryDays} days`],
    ['Alert contacts', (p) => String(p.maxAlertContacts)],
    ['Audit scans per month', (p) => p.scansPerMonth.toLocaleString()],
    ['Pages per scan', (p) => String(p.maxPagesPerScan)],
    ['Websites', (p) => String(p.maxWebsites)],
    ['Team members', (p) => String(p.maxMembers)],
    ['Visual comparison', (p) => p.visualComparison],
    ['PDF and CSV reports', (p) => p.pdfExport],
    ['AI explanations per month', (p) => String(p.aiRequestsPerMonth)],
    ['Branded client reports', (p) => p.brandedReports],
  ];
  const sub = b.subscription;
  const hasActiveSub = !!sub.status && ['active', 'trialing', 'past_due'].includes(sub.status);

  return (
    <>
      <PageHeader
        title="Billing"
        description="Your plan and usage. Every limit is enforced on the server."
        actions={
          sub.hasCustomer && b.paymentsConfigured ? (
            <Button variant="secondary" loading={busy === 'portal'} onClick={() => go('portal', '/billing/portal')} icon={<ExternalLink className="size-4" aria-hidden />}>
              Manage billing
            </Button>
          ) : undefined
        }
      />
      {checkout === 'success' && (
        <Alert tone={b.currentPlan === 'free' ? 'info' : 'success'} className="mb-4" onDismiss={() => setParams({})} title={b.currentPlan === 'free' ? 'Waiting for Stripe to confirm the payment' : 'Your plan is active'}>
          {b.currentPlan === 'free'
            ? polls >= 20
              ? 'Stripe has not confirmed the payment yet. Your plan will change as soon as it does; you can leave this page.'
              : 'Your plan changes as soon as Stripe confirms the payment, usually within a few seconds.'
            : 'Thank you. The new limits apply now.'}
        </Alert>
      )}
      {checkout === 'cancelled' && (
        <Alert tone="info" className="mb-4" onDismiss={() => setParams({})}>
          Checkout was cancelled. Nothing was charged.
        </Alert>
      )}
      {err && (
        <Alert tone="error" className="mb-4" onDismiss={() => setErr(null)}>
          {err}
        </Alert>
      )}
      {!b.paymentsConfigured && (
        <Alert tone="info" className="mb-6" title="Online payments are not enabled">
          {b.message}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Subscription" icon={<CreditCard className="size-5" aria-hidden />} />
            <dl className="space-y-3 p-5 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600">Plan</dt>
                <dd className="font-semibold text-slate-900">{b.plans.find((p) => p.id === b.currentPlan)?.name}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600">Status</dt>
                <dd className="text-right text-slate-900">{sub.status ? (SUB_STATUS[sub.status] ?? sub.status) : sub.planSource === 'operator' ? 'Assigned by an operator' : 'Free plan'}</dd>
              </div>
              {sub.periodEnd && (
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600">{sub.status === 'canceled' ? 'Ended' : 'Renews'}</dt>
                  <dd className="text-slate-900">{fmtDate(sub.periodEnd)}</dd>
                </div>
              )}
            </dl>
          </Card>
          <Card>
            <CardHeader title="Usage" description={`Monthly counters since ${fmtDate(b.usage.periodStart)}`} />
            <div className="space-y-5 p-5">
              <Meter label="Monitors" used={b.usage.monitorsUsed} limit={b.usage.plan.maxMonitors} />
              <Meter label="Audit scans this month" used={b.usage.scansUsed} limit={b.usage.plan.scansPerMonth} />
              <Meter label="AI explanations this month" used={b.usage.aiRequestsUsed} limit={b.usage.plan.aiRequestsPerMonth} />
              <Meter label="Websites" used={b.usage.websitesUsed} limit={b.usage.plan.maxWebsites} />
            </div>
          </Card>
        </div>

        <Card className="lg:col-span-2">
          <CardHeader title="Plans" description={`Premium watchers: ${Object.values(WATCHERS).filter((w) => w.tier === 'paid').length} more than Free.`} />
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Plan comparison (scrolls sideways)">
            <table className="table-base min-w-[36rem]">
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  {b.plans.map((p) => (
                    <th key={p.id} scope="col" className={cx(p.id === b.currentPlan && '!text-brand-700')}>
                      {p.name}
                      {p.id === b.currentPlan && <span className="ml-1.5 rounded bg-brand-100 px-1.5 py-0.5 text-[10px] text-brand-800 normal-case">Current</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, fn]) => (
                  <tr key={label}>
                    <th scope="row" className="!bg-surface !text-sm !font-normal !text-slate-700 !normal-case !tracking-normal">
                      {label}
                    </th>
                    {b.plans.map((p) => {
                      const v = fn(p);
                      return (
                        <td key={p.id} className="tabular-nums">
                          {typeof v === 'boolean' ? (
                            v ? <Check className="size-4 text-emerald-600" aria-label="Included" /> : <Minus className="size-4 text-slate-400" aria-label="Not included" />
                          ) : (
                            v
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr>
                  <td />
                  {b.plans.map((p) => (
                    <td key={p.id}>
                      {p.id === b.currentPlan ? (
                        <span className="text-xs font-medium text-slate-500">Your plan</span>
                      ) : p.id === 'free' ? null : hasActiveSub ? (
                        <Button size="sm" variant="secondary" loading={busy === 'portal'} onClick={() => go('portal', '/billing/portal')}>
                          Switch
                        </Button>
                      ) : b.purchasable[p.id as 'pro' | 'agency'] ? (
                        <Button size="sm" loading={busy === p.id} onClick={() => go(p.id, '/billing/checkout', { plan: p.id })}>
                          Upgrade
                        </Button>
                      ) : (
                        <span className="text-xs text-slate-500">Contact us</span>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
