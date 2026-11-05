import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Bot, ChevronDown, ExternalLink, History, RefreshCw, ShieldAlert, Sparkles } from 'lucide-react';
import { CATEGORY_INFO, ISSUE_STATUS_LABELS, VIEWPORTS, type IssueDetailDTO } from '@wpcg/shared';
import { errorMessage, patch, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { fmtDateTime, pathOf, plural } from '../lib/format';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  IssueStatusBadge,
  LoadingState,
  Modal,
  PageHeader,
  SeverityBadge,
  Spinner,
  cx,
  issueStatusHelp,
} from '../components/ui';

function Section({ n, title, children, id }: { n: number; title: string; children: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id ?? `s${n}`} className="border-t border-slate-100 px-5 py-5 first:border-t-0 sm:px-6">
      <h2 id={id ?? `s${n}`} className="flex items-center gap-2.5 text-sm font-semibold text-slate-900">
        <span className="flex size-6 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700" aria-hidden>
          {n}
        </span>
        {title}
      </h2>
      <div className="mt-3 pl-0 text-sm leading-relaxed text-slate-700 sm:pl-8">{children}</div>
    </section>
  );
}

interface AiOutput {
  content: string;
  provider: string;
  model: string;
  createdAt: string;
}

export function IssueDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi<IssueDetailDTO>(`/issues/${id}`);
  const ai = useApi<AiOutput | null>(data?.aiAvailable ? `/ai/issues/${id}` : null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [authorised, setAuthorised] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiOut, setAiOut] = useState<AiOutput | null>(null);
  const [showAllEvidence, setShowAllEvidence] = useState(false);

  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const i = data!;
  const r = i.remediation;
  const viewports = [...new Set(i.findings.map((f) => f.viewport).filter(Boolean))] as (keyof typeof VIEWPORTS)[];
  const evidence = showAllEvidence ? i.findings : i.findings.slice(0, 3);
  const aiShown = aiOut ?? ai.data ?? null;

  const verify = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await post<{ scanId: string }>(`/issues/${i.id}/verify`, { authorised: true });
      navigate(`/scans/${res.scanId}`);
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };

  const setStatus = async (status: 'open' | 'needs_review') => {
    setErr(null);
    try {
      await patch(`/issues/${i.id}`, { status });
      reload();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const explain = async () => {
    setAiBusy(true);
    setAiErr(null);
    try {
      setAiOut(await post<AiOutput>(`/ai/issues/${i.id}`, {}));
    } catch (e) {
      setAiErr(errorMessage(e));
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-1.5">
            <Link to="/issues" className="hover:underline">Issues</Link>
            <span aria-hidden>/</span>
            <Link to={`/websites/${i.websiteId}`} className="hover:underline">{i.websiteName}</Link>
          </span>
        }
        title={i.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={i.severity} />
            <IssueStatusBadge status={i.status} />
            <span className="text-slate-500">
              {CATEGORY_INFO[i.category].label}
              {i.wcag.length > 0 && ` · WCAG ${i.wcag.join(', ')}`} · first seen {fmtDateTime(i.firstDetectedAt)} · last seen {fmtDateTime(i.lastDetectedAt)}
            </span>
          </span>
        }
        actions={
          i.status !== 'resolved' ? (
            <Button onClick={() => setVerifyOpen(true)} icon={<RefreshCw className="size-4" aria-hidden />}>
              Run verification scan
            </Button>
          ) : undefined
        }
      />
      {err && <Alert tone="error" className="mb-4" onDismiss={() => setErr(null)}>{err}</Alert>}
      {i.status === 'resolved' && (
        <Alert tone="success" title="Resolved" className="mb-4">
          The same check re-ran on every page and viewport where this was seen and did not find it. If a later scan detects it again, it is reopened automatically.
        </Alert>
      )}
      {(i.status === 'not_tested' || i.status === 'inconclusive' || i.status === 'needs_review') && (
        <Alert tone="warning" title={ISSUE_STATUS_LABELS[i.status]} className="mb-4">
          {issueStatusHelp(i.status)}
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Card as="article">
          <Section n={1} title="What was detected?">
            <p>{i.description}</p>
          </Section>

          <Section n={2} title="Where was it detected?">
            <p className="mb-2">
              {plural(i.affectedCount, 'page')} in the latest scan
              {viewports.length > 0 && ` · ${viewports.map((v) => VIEWPORTS[v].label).join(', ')}`}:
            </p>
            <ul className="space-y-1">
              {i.affectedUrls.map((u) => (
                <li key={u}>
                  <a href={u} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all text-brand-700 hover:underline">
                    {u}
                    <ExternalLink className="size-3 shrink-0" aria-hidden />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                </li>
              ))}
              {i.affectedCount > i.affectedUrls.length && <li className="text-slate-500">…and {i.affectedCount - i.affectedUrls.length} more</li>}
            </ul>
          </Section>

          <Section n={3} title="Why does it matter?">
            <p>{r.whyItMatters}</p>
          </Section>

          <Section n={4} title="What evidence supports the finding?">
            <p className="mb-3 text-slate-600">Recorded by the scanner in the latest scan. Nothing here is generated or estimated.</p>
            <div className="space-y-4">
              {evidence.map((f) => (
                <div key={f.id} className="rounded-lg border border-slate-200">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs">
                    <span className="font-medium break-all text-slate-800">{pathOf(f.pageUrl)}</span>
                    <span className="text-slate-500">
                      {f.viewport ? `${VIEWPORTS[f.viewport].label} · ` : ''}
                      {fmtDateTime(f.detectedAt)}
                    </span>
                  </div>
                  <dl className="space-y-2.5 p-3">
                    {f.evidence.map((e, k) => (
                      <div key={k}>
                        <dt className="text-xs font-medium text-slate-500">{e.label}</dt>
                        <dd className={cx('mt-0.5 whitespace-pre-wrap break-words', e.code ? 'code-block' : 'text-slate-800')}>{e.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
            {i.findings.length > 3 && (
              <Button variant="ghost" size="sm" className="mt-3" onClick={() => setShowAllEvidence((s) => !s)}>
                {showAllEvidence ? 'Show less' : `Show evidence from all ${i.findings.length} pages`}
              </Button>
            )}
          </Section>

          <Section n={5} title="How serious is it?">
            <p className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={i.severity} />
            </p>
            <p className="mt-2">{i.severityReason}</p>
            <p className="mt-2 text-slate-600">
              Detection confidence: <strong className="font-medium text-slate-800">{i.confidence}</strong>.{' '}
              <Link to="/settings#severity" className="text-brand-700 underline underline-offset-2">How severity is assigned</Link>
            </p>
            {i.limitations && <p className="mt-2 rounded-lg bg-amber-50 p-3 text-amber-950">{i.limitations}</p>}
          </Section>

          <Section n={6} title="What should you do?">
            <p>{r.steps[0]}</p>
            {r.manualReview && (
              <p className="mt-3 flex gap-2 rounded-lg bg-violet-50 p-3 text-violet-950">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{r.manualReview}</span>
              </p>
            )}
          </Section>

          <Section n={7} title="Step-by-step fix">
            <ol className="list-decimal space-y-2 pl-5 marker:font-semibold marker:text-slate-500">
              {r.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </Section>

          <Section n={8} title="Example code">
            {r.codeExample ? (
              <div className="space-y-3">
                {r.codeExample.before && (
                  <div>
                    <div className="mb-1 text-xs font-medium text-slate-500">Before</div>
                    <pre className="code-block">{r.codeExample.before}</pre>
                  </div>
                )}
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500">{r.codeExample.before ? 'After' : r.codeExample.language.toUpperCase()}</div>
                  <pre className="code-block">{r.codeExample.after}</pre>
                </div>
                <p className="text-xs text-slate-500">A general example of the pattern — adapt it to your theme or plugin. It is not copied from your site.</p>
              </div>
            ) : (
              <p className="text-slate-600">No generic code example applies; the fix depends on where the content comes from on your site. Use the evidence above to locate it.</p>
            )}
          </Section>

          <Section n={9} title="How to verify the fix">
            <ul className="list-disc space-y-1.5 pl-5">
              {r.verify.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </Section>

          <Section n={10} title="Run a verification scan">
            {i.status === 'resolved' ? (
              <p>This issue is already resolved.</p>
            ) : (
              <>
                <p>Re-runs the {CATEGORY_INFO[i.category].label.toLowerCase()} check on the {plural(i.affectedCount, 'page')} above with the same viewports. It counts as one scan.</p>
                <Button className="mt-3" onClick={() => setVerifyOpen(true)} icon={<RefreshCw className="size-4" aria-hidden />}>
                  Run verification scan
                </Button>
              </>
            )}
          </Section>

          <details className="group border-t border-slate-100">
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-semibold text-slate-900 hover:bg-slate-50 sm:px-6">
              Technical details for developers
              <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden />
            </summary>
            <dl className="space-y-3 px-5 pb-5 text-sm sm:px-6">
              <div>
                <dt className="text-xs font-medium text-slate-500">Detection method</dt>
                <dd className="mt-0.5">{i.detectionMethod}</dd>
              </div>
              {i.technical.map((t) => (
                <div key={t.label}>
                  <dt className="text-xs font-medium text-slate-500">{t.label}</dt>
                  <dd className="mt-0.5 font-mono text-xs break-words whitespace-pre-wrap">{t.value}</dd>
                </div>
              ))}
              {r.references.length > 0 && (
                <div>
                  <dt className="text-xs font-medium text-slate-500">References</dt>
                  <dd className="mt-0.5 space-y-1">
                    {r.references.map((ref) => (
                      <a key={ref.url} href={ref.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1 text-brand-700 hover:underline">
                        {ref.label}
                        <ExternalLink className="size-3" aria-hidden />
                      </a>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </details>
        </Card>

        <aside className="space-y-6">
          <Card>
            <div className="p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="size-4 text-brand-600" aria-hidden />
                AI explanation
              </h2>
              {!i.aiAvailable ? (
                <p className="mt-2 text-sm text-slate-600">AI explanations are not configured on this server or are turned off for your workspace. Everything on this page comes from the scanner and works without AI.</p>
              ) : (
                <>
                  <p className="mt-2 text-xs text-slate-500">Written by an AI model from the evidence on this page only. It cannot change your website. Check its advice before acting.</p>
                  {aiShown ? (
                    <div className="mt-3">
                      <div className="text-sm leading-relaxed whitespace-pre-wrap text-slate-800">{aiShown.content}</div>
                      <p className="mt-3 flex items-center gap-1 text-xs text-slate-500">
                        <Bot className="size-3.5" aria-hidden />
                        {aiShown.provider} · {aiShown.model} · {fmtDateTime(aiShown.createdAt)}
                      </p>
                    </div>
                  ) : null}
                  {aiErr && <Alert tone="error" className="mt-3">{aiErr}</Alert>}
                  {aiBusy ? (
                    <div className="mt-3">
                      <Spinner label="Writing an explanation…" />
                    </div>
                  ) : (
                    <Button variant="secondary" size="sm" className="mt-3" onClick={explain}>
                      {aiShown ? 'Regenerate' : 'Explain this issue'}
                    </Button>
                  )}
                </>
              )}
            </div>
          </Card>

          <Card>
            <div className="p-5">
              <h2 className="text-sm font-semibold">Status</h2>
              <div className="mt-2">
                <IssueStatusBadge status={i.status} />
              </div>
              <p className="mt-2 text-xs text-slate-600">{issueStatusHelp(i.status)}</p>
              {i.status !== 'resolved' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {i.status !== 'needs_review' && (
                    <Button size="sm" variant="secondary" onClick={() => setStatus('needs_review')}>
                      Flag for review
                    </Button>
                  )}
                  {i.status !== 'open' && i.status !== 'reopened' && (
                    <Button size="sm" variant="secondary" onClick={() => setStatus('open')}>
                      Mark as open
                    </Button>
                  )}
                </div>
              )}
              <p className="mt-3 text-xs text-slate-500">Issues can only be resolved by a scan that re-tests them.</p>
            </div>
          </Card>

          <Card>
            <div className="p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <History className="size-4 text-slate-500" aria-hidden />
                History
              </h2>
              <ol className="mt-3 space-y-3 border-l border-slate-200 pl-4">
                {i.events.map((e) => (
                  <li key={e.id} className="relative text-sm">
                    <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-surface bg-slate-400" aria-hidden />
                    <div className="font-medium text-slate-900">{ISSUE_STATUS_LABELS[e.toStatus]}</div>
                    <div className="text-xs text-slate-600">{e.reason}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {fmtDateTime(e.createdAt)}
                      {e.scanId && (
                        <>
                          {' · '}
                          <Link to={`/scans/${e.scanId}`} className="hover:underline">scan</Link>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </Card>
        </aside>
      </div>

      <Modal
        open={verifyOpen}
        onClose={() => setVerifyOpen(false)}
        title="Run a verification scan"
        footer={
          <>
            <Button variant="secondary" onClick={() => setVerifyOpen(false)}>
              Cancel
            </Button>
            <Button onClick={verify} loading={busy} disabled={!authorised}>
              Start verification
            </Button>
          </>
        }
      >
        {/* Shown here too: the page behind an open dialog is inert, so an error there goes unseen and unannounced. */}
        {err && (
          <Alert tone="error" className="mb-3">
            {err}
          </Alert>
        )}
        <p>
          WebAudit AI will re-run the {CATEGORY_INFO[i.category].label.toLowerCase()} check on {plural(i.affectedCount, 'page')}
          {viewports.length ? ` at ${viewports.join(' and ')}` : ''}. The issue is marked resolved only if the check runs everywhere it was seen and no longer finds it.
        </p>
        <label className="mt-4 flex items-start gap-2.5">
          <input type="checkbox" className="mt-0.5 size-4 rounded accent-brand-600" checked={authorised} onChange={(e) => setAuthorised(e.target.checked)} />
          <span>I own this website or have permission to scan it.</span>
        </label>
      </Modal>
    </>
  );
}
