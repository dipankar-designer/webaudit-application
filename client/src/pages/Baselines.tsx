import { useState } from 'react';
import { Link } from 'react-router';
import { Images, Trash2 } from 'lucide-react';
import type { BaselineDTO } from '@wpcg/shared';
import { del, errorMessage } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useSession } from '../lib/session';
import { fmtDateTime, plural } from '../lib/format';
import { Alert, Button, Card, EmptyState, ErrorState, LinkButton, LoadingState, PageHeader } from '../components/ui';
import { PLANS } from '@wpcg/shared';

export function BaselinesPage() {
  const { session } = useSession();
  const { data, error, loading, reload } = useApi<BaselineDTO[]>('/baselines');
  const [err, setErr] = useState<string | null>(null);
  const visualAllowed = session ? PLANS[session.workspace.plan].visualComparison : false;

  const remove = async (b: BaselineDTO) => {
    if (!window.confirm(`Remove the baseline “${b.name}”? The scan itself is kept.`)) return;
    try {
      await del(`/baselines/${b.id}`);
      reload();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Baselines"
        description="A baseline is a completed scan you trust. Later scans compare their screenshots with it to spot unexpected visual changes after updates."
      />
      {!visualAllowed && (
        <Alert tone="info" className="mb-4" title="Visual comparison is part of the Pro and Agency plans">
          You can still save baselines now; comparisons become available when your workspace moves to a plan that includes them.
        </Alert>
      )}
      {err && <Alert tone="error" className="mb-4">{err}</Alert>}
      <Card>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <div className="p-5">
            <ErrorState error={error} onRetry={reload} />
          </div>
        ) : !data?.length ? (
          <EmptyState icon={<Images className="size-6" aria-hidden />} title="No baselines yet" action={<LinkButton to="/scans">Open a scan</LinkButton>}>
            Run a Full scan (it captures desktop and mobile screenshots), open its results and choose “Save as baseline”.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1 basis-60">
                  <div className="font-medium text-slate-900">{b.name}</div>
                  <div className="text-xs text-slate-500">
                    {b.websiteName} · scan finished {fmtDateTime(b.scanFinishedAt)} · {b.viewports.join(' + ')} · {plural(b.screenshotCount, 'screenshot')}
                  </div>
                  {b.screenshotCount === 0 && <div className="mt-1 text-xs text-amber-700">No screenshots — this baseline cannot be used for visual comparison.</div>}
                </div>
                <Link to={`/scans/${b.scanId}`} className="text-sm font-medium text-brand-700 hover:underline">
                  View scan
                </Link>
                <Button variant="ghost" size="sm" onClick={() => remove(b)} icon={<Trash2 className="size-4" aria-hidden />} aria-label={`Remove baseline ${b.name}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
