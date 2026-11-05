import { Activity, Globe, PlusCircle, Radar } from 'lucide-react';
import { Link } from 'react-router';
import type { OverviewDTO } from '@wpcg/shared';
import { useApi } from '../lib/useApi';
import { useSession } from '../lib/session';
import { fmtRelative, hostOf, plural } from '../lib/format';
import { Card, CardHeader, EmptyState, ErrorState, LinkButton, LoadingState, RefreshFailed, PageHeader, ScanStatusBadge, SeverityBar, Stat } from '../components/ui';
import { emptySeverityCounts, type MonitoringOverviewDTO } from '@wpcg/shared';
import { MonitoringHealth, MonitoringStats } from './Monitors';

export function OverviewPage() {
  const { session } = useSession();
  const { data, error, loading, reload } = useApi<OverviewDTO>('/overview', {
    pollMs: 5000,
    shouldPoll: (d) => d.recentScans.some((s) => s.status === 'queued' || s.status === 'running'),
  });

  const mon = useApi<MonitoringOverviewDTO>('/monitors/overview', { pollMs: 30_000, shouldPoll: () => true });

  return (
    <>
      <PageHeader
        title={`Hello, ${session?.user.name.split(' ')[0] ?? ''}`}
        description="Live monitoring and audit results for every website in your workspace, from stored check results only."
        actions={
          <>
            <LinkButton to="/monitors/new" variant="secondary" icon={<Activity className="size-4" aria-hidden />}>
              Add monitor
            </LinkButton>
            <LinkButton to="/scans/new" icon={<PlusCircle className="size-4" aria-hidden />}>
              New scan
            </LinkButton>
          </>
        }
      />
      <RefreshFailed error={data ? error : null} onRetry={reload} />
      {mon.data && (
        <section aria-labelledby="mon-h" className="mb-8">
          <MonitoringHealth overview={mon.data} />
          <div className="mb-3 flex items-center justify-between">
            <h2 id="mon-h" className="text-lg font-semibold text-slate-900">
              Monitoring
            </h2>
            <Link to="/monitors" className="text-sm font-medium text-brand-700 hover:underline">
              All monitors
            </Link>
          </div>
          {mon.data.monitors ? (
            <MonitoringStats o={mon.data} />
          ) : (
            <Card>
              <EmptyState
                icon={<Activity className="size-6" aria-hidden />}
                title="No monitors yet"
                action={
                  <LinkButton to="/monitors/new" icon={<PlusCircle className="size-4" aria-hidden />}>
                    Add monitor
                  </LinkButton>
                }
              >
                Get alerted when a site goes down, a certificate or domain is about to expire, or a page changes unexpectedly.
              </EmptyState>
            </Card>
          )}
        </section>
      )}
      <h2 className="mb-3 text-lg font-semibold text-slate-900">Audits</h2>
      {loading && !data ? (
        <LoadingState />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : data ? (
        data.scans === 0 ? (
          <Card>
            <EmptyState
              icon={<Radar className="size-6" aria-hidden />}
              title="Run your first scan"
              action={
                <LinkButton to="/scans/new" icon={<PlusCircle className="size-4" aria-hidden />}>
                  Scan a website
                </LinkButton>
              }
            >
              Enter a website address and WebAudit AI will load its pages in a real browser, check availability, HTML, SEO, accessibility, security headers and more, then explain each problem in plain language.
            </EmptyState>
          </Card>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
              <Stat label="Websites" value={data.websites} to="/websites" />
              <Stat label="Scans" value={data.scans} to="/scans" hint={`${data.usage.scansUsed} of ${data.usage.plan.scansPerMonth} this month`} />
              <Stat
                label="Critical issues"
                value={data.criticalIssues}
                tone={data.criticalIssues ? 'critical' : 'default'}
                to="/issues?severity=critical"
                help="Open issues where a website or its home page cannot be loaded."
              />
              <Stat
                label="High priority"
                value={data.highIssues}
                tone={data.highIssues ? 'high' : 'default'}
                to="/issues?severity=high"
                help="Open issues that block a core function or a group of users, such as broken pages, links or serious accessibility barriers."
              />
              <Stat
                label="Awaiting review"
                value={data.awaitingReview}
                tone={data.awaitingReview ? 'review' : 'default'}
                to="/issues?status=review"
                help="Issues marked Needs Manual Review, Pending Verification or Not Tested. They are not counted as confirmed defects; a person should check them."
              />
              <Stat label="Resolved" value={data.resolvedIssues} tone="good" to="/issues?status=resolved" help="Issues not found when the same check re-ran on the same pages and viewports." />
            </div>

            <Card>
              <CardHeader title="Latest scan activity" icon={<Activity className="size-5" aria-hidden />} actions={<Link to="/scans" className="text-sm font-medium text-brand-700 hover:underline">All scans</Link>} />
              <ul className="divide-y divide-slate-100">
                {data.recentScans.map((s) => {
                  const counts = s.summary?.bySeverity ?? emptySeverityCounts();
                  return (
                    <li key={s.id}>
                      <Link to={`/scans/${s.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 hover:bg-slate-50">
                        <Globe className="size-4 shrink-0 text-slate-400" aria-hidden />
                        <div className="min-w-0 flex-1 basis-48">
                          <div className="truncate text-sm font-medium text-slate-900">{s.websiteName}</div>
                          <div className="truncate text-xs text-slate-500">
                            {hostOf(s.websiteUrl)} · {s.kind === 'verification' ? 'Verification' : s.kind === 'full' ? 'Full scan' : 'Quick scan'} · {fmtRelative(s.createdAt)}
                          </div>
                        </div>
                        <div className="w-40 max-sm:order-last max-sm:w-full">
                          {s.status === 'completed' ? (
                            <>
                              <SeverityBar counts={counts} />
                              <div className="mt-1 text-xs text-slate-500">{plural(s.summary?.issuesDetected ?? 0, 'issue')}</div>
                            </>
                          ) : s.status === 'running' && s.progress ? (
                            <div className="text-xs text-slate-600">{s.progress.message}</div>
                          ) : null}
                        </div>
                        <ScanStatusBadge status={s.status} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
        )
      ) : null}
    </>
  );
}
