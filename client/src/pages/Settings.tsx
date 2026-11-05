import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Database, KeyRound, Scale, Trash2, Users, Building2 } from 'lucide-react';
import { PLANS, SEVERITY_LABELS, type Severity } from '@wpcg/shared';
import { del, errorMessage, patch, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useSession } from '../lib/session';
import { fmtDate } from '../lib/format';
import { Alert, Button, Card, CardHeader, Modal, PageHeader, SeverityBadge } from '../components/ui';

interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
}

function useFormAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
      return true;
    } catch (e) {
      setMsg({ tone: 'error', text: errorMessage(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const node: ReactNode = msg ? (
    <Alert tone={msg.tone} onDismiss={() => setMsg(null)}>
      {msg.text}
    </Alert>
  ) : null;
  return { busy, run, node };
}

const SEVERITY_POLICY: [Severity, string][] = [
  ['critical', 'The website itself cannot be used: the home page does not load, returns a server error, or has a broken HTTPS certificate. Reserved for availability.'],
  ['high', 'A core function or a group of users is blocked: linked pages return errors, broken internal links, JavaScript errors from your own code, form data sent insecurely, the home page set to noindex, and axe-core “critical” accessibility failures.'],
  ['medium', 'Degrades the experience or discoverability for some visitors: missing page language or title, broken images, sideways scrolling on mobile, invalid structured data, console errors, and axe-core “serious” failures.'],
  ['low', 'Best-practice gaps with limited direct impact: missing meta description or canonical, skipped heading levels, missing security headers, unsized or oversized images, third-party script errors, and axe-core “moderate” issues.'],
  ['info', 'Observations to review: missing sitemap, Referrer-Policy, version numbers in headers, and axe-core “minor” issues.'],
];

export function SettingsPage() {
  const { session, refresh, logout } = useSession();
  const navigate = useNavigate();
  const ws = session!.workspace;
  const canAdmin = ws.role === 'owner' || ws.role === 'admin';
  const plan = PLANS[ws.plan];

  const [name, setName] = useState(ws.name);
  const [retention, setRetention] = useState(ws.retentionDays);
  const [aiEnabled, setAiEnabled] = useState(ws.aiEnabled);
  const [brand, setBrand] = useState(ws.reportBrandName ?? '');
  useEffect(() => {
    setName(ws.name);
    setRetention(ws.retentionDays);
    setAiEnabled(ws.aiEnabled);
    setBrand(ws.reportBrandName ?? '');
  }, [ws]);
  const wsForm = useFormAction();
  const pwForm = useFormAction();
  const teamForm = useFormAction();
  const members = useApi<Member[]>('/workspace/members');
  const ai = useApi<{ configured: boolean; provider: string | null; model: string | null }>('/ai/status');

  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeText, setPurgeText] = useState('');
  const purgeForm = useFormAction();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePw, setDeletePw] = useState('');
  const [deleteText, setDeleteText] = useState('');
  const deleteForm = useFormAction();

  const saveWorkspace = (e: FormEvent) => {
    e.preventDefault();
    void wsForm.run(async () => {
      await patch('/workspace', { name, retentionDays: retention, aiEnabled, ...(plan.brandedReports ? { reportBrandName: brand || null } : {}) });
      await refresh();
    }, 'Workspace settings saved.');
  };

  const changePassword = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (f.get('newPassword') !== f.get('confirmPassword')) return void pwForm.run(async () => Promise.reject(new Error('The new passwords do not match.')), '');
    void pwForm.run(async () => {
      await post('/auth/password', { currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') });
      form.reset();
    }, 'Password changed. Other devices have been signed out.');
  };

  const addMember = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void teamForm.run(async () => {
      await post('/workspace/members', { email: f.get('email'), role: f.get('role') });
      form.reset();
      members.reload();
    }, 'Member added.');
  };

  return (
    <>
      <PageHeader title="Settings" description="Workspace, team, security and data controls." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Workspace" icon={<Building2 className="size-5" aria-hidden />} description={`${plan.name} plan · your role: ${ws.role}`} />
          <form onSubmit={saveWorkspace} className="space-y-4 p-5">
            {wsForm.node}
            <div>
              <label className="label" htmlFor="ws-name">Workspace name</label>
              <input id="ws-name" className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!canAdmin} maxLength={100} />
            </div>
            <div>
              <label className="label" htmlFor="ws-retention">Keep scan data for (days)</label>
              <input id="ws-retention" className="input w-40" type="number" min={1} max={3650} value={retention} onChange={(e) => setRetention(Number(e.target.value))} disabled={!canAdmin} />
              <p className="help">Older scans, screenshots and issues not seen in this period are deleted automatically every hour. Baseline scans are kept until you remove the baseline.</p>
            </div>
            <label className="flex items-start gap-2.5 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 rounded accent-brand-600" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} disabled={!canAdmin} />
              <span>
                <span className="font-medium">Allow AI explanations</span>
                <span className="block text-slate-600">
                  {ai.data?.configured
                    ? `Uses ${ai.data.provider} (${ai.data.model}). Only scan evidence is sent — never passwords or form data.`
                    : 'No AI provider is configured on this server, so this setting has no effect yet.'}
                </span>
              </span>
            </label>
            <div>
              <label className="label" htmlFor="ws-brand">Report brand name</label>
              <input id="ws-brand" className="input" value={brand} onChange={(e) => setBrand(e.target.value)} disabled={!canAdmin || !plan.brandedReports} placeholder={plan.brandedReports ? 'Your agency name' : 'Agency plan'} maxLength={100} />
              {!plan.brandedReports && <p className="help">Branded client reports are part of the Agency plan.</p>}
            </div>
            {canAdmin && (
              <Button type="submit" loading={wsForm.busy}>
                Save workspace
              </Button>
            )}
          </form>
        </Card>

        <Card>
          <CardHeader title="Team" icon={<Users className="size-5" aria-hidden />} description={`${members.data?.length ?? 0} of ${plan.maxMembers} member${plan.maxMembers === 1 ? '' : 's'} on your plan`} />
          <ul className="divide-y divide-slate-100">
            {members.data?.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{m.name}</div>
                  <div className="truncate text-xs text-slate-500">
                    {m.email} · joined {fmtDate(m.joinedAt)}
                  </div>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium capitalize">{m.role}</span>
                {canAdmin && m.role !== 'owner' && (
                  <Button size="sm" variant="ghost" onClick={() => teamForm.run(async () => { await del(`/workspace/members/${m.userId}`); members.reload(); }, 'Member removed.')}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {canAdmin && (
            <form onSubmit={addMember} className="space-y-3 border-t border-slate-100 p-5">
              {teamForm.node}
              <p className="text-sm text-slate-600">Add someone who already has a WebAudit AI account. Invitation e-mails are not sent by this version.</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <label htmlFor="m-email" className="sr-only">E-mail</label>
                <input id="m-email" name="email" type="email" className="input" placeholder="colleague@agency.com" required />
                <label htmlFor="m-role" className="sr-only">Role</label>
                <select id="m-role" name="role" className="input sm:w-36">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <Button type="submit" variant="secondary" loading={teamForm.busy}>
                  Add
                </Button>
              </div>
            </form>
          )}
        </Card>

        <Card>
          <CardHeader title="Password" icon={<KeyRound className="size-5" aria-hidden />} />
          <form onSubmit={changePassword} className="space-y-4 p-5">
            {pwForm.node}
            <div>
              <label className="label" htmlFor="pw-current">Current password</label>
              <input id="pw-current" name="currentPassword" type="password" className="input" autoComplete="current-password" required />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="pw-new">New password</label>
                <input id="pw-new" name="newPassword" type="password" className="input" autoComplete="new-password" minLength={10} required />
              </div>
              <div>
                <label className="label" htmlFor="pw-confirm">Repeat new password</label>
                <input id="pw-confirm" name="confirmPassword" type="password" className="input" autoComplete="new-password" minLength={10} required />
              </div>
            </div>
            <Button type="submit" variant="secondary" loading={pwForm.busy}>
              Change password
            </Button>
          </form>
        </Card>

        <Card>
          <CardHeader title="Your data" icon={<Database className="size-5" aria-hidden />} />
          <div className="space-y-4 p-5 text-sm text-slate-700">
            <p>
              <strong className="font-medium text-slate-900">What is stored:</strong> your name, e-mail and a salted scrypt password hash; website addresses; for each scan the page URLs, HTTP status codes, page titles, findings with the
              evidence shown on issue pages (selectors, short HTML snippets, header values, error messages with tokens and e-mail addresses masked), and screenshots of the pages scanned.
            </p>
            <p>
              <strong className="font-medium text-slate-900">What is not stored:</strong> page bodies, cookies’ values, form submissions, passwords of scanned sites or payment details. The scanner never submits forms or logs in.
            </p>
            <p>Scan data lives in this deployment’s PostgreSQL database and screenshot storage. It is visible only to members of this workspace.</p>
            {purgeForm.node}
            {ws.role === 'owner' && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="secondary" onClick={() => setPurgeOpen(true)} icon={<Trash2 className="size-4" aria-hidden />}>
                  Delete all scan data
                </Button>
              </div>
            )}
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>
              Delete my account
            </Button>
          </div>
        </Card>

        <Card className="xl:col-span-2">
          <div id="severity" className="scroll-mt-6">
            <CardHeader title="How severity is assigned" icon={<Scale className="size-5" aria-hidden />} description="Each rule has a fixed severity based on these criteria — nothing is scored ad hoc." />
          </div>
          <ul className="divide-y divide-slate-100">
            {SEVERITY_POLICY.map(([sev, text]) => (
              <li key={sev} className="grid gap-2 px-5 py-3.5 text-sm sm:grid-cols-[9rem_1fr]">
                <div>
                  <SeverityBadge severity={sev} />
                  <span className="sr-only">{SEVERITY_LABELS[sev]}</span>
                </div>
                <p className="text-slate-700">{text}</p>
              </li>
            ))}
          </ul>
          <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
            Results the scanner could not confirm (blocked, rate-limited, timed out) are marked <em>Pending Verification</em>; results that need a person’s judgement (for example colour contrast over images) are marked <em>Needs Manual Review</em>. Neither is reported as a confirmed defect.
          </p>
        </Card>
      </div>

      <Modal
        open={purgeOpen}
        onClose={() => setPurgeOpen(false)}
        title="Delete all scan data?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPurgeOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={purgeText !== 'DELETE'}
              loading={purgeForm.busy}
              onClick={async () => {
                const ok = await purgeForm.run(() => post('/workspace/purge', { confirm: 'DELETE' }), 'All scans, issues, screenshots and baselines were deleted.');
                if (ok) setPurgeOpen(false);
              }}
            >
              Delete scan data
            </Button>
          </>
        }
      >
        {/* A failed purge is shown inside the dialog: the page behind it is inert while it is open. */}
        {purgeForm.node && <div className="mb-3">{purgeForm.node}</div>}
        <p>Every scan, issue, screenshot, baseline and AI explanation in this workspace will be deleted permanently. Your websites list is kept.</p>
        <label className="label mt-4" htmlFor="purge-confirm">Type DELETE to confirm</label>
        <input id="purge-confirm" className="input" value={purgeText} onChange={(e) => setPurgeText(e.target.value)} autoComplete="off" />
      </Modal>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete your account?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={deleteText !== 'DELETE' || !deletePw}
              loading={deleteForm.busy}
              onClick={async () => {
                const ok = await deleteForm.run(() => post('/auth/delete-account', { password: deletePw, confirm: 'DELETE' }), 'Account deleted.');
                if (ok) {
                  await logout();
                  navigate('/signup');
                }
              }}
            >
              Delete account
            </Button>
          </>
        }
      >
        {deleteForm.node}
        <p>Your account is deleted permanently. Workspaces where you are the only owner are deleted too, with all their websites, scans and screenshots.</p>
        <label className="label mt-4" htmlFor="del-pw">Password</label>
        <input id="del-pw" type="password" className="input" value={deletePw} onChange={(e) => setDeletePw(e.target.value)} autoComplete="current-password" />
        <label className="label mt-3" htmlFor="del-confirm">Type DELETE to confirm</label>
        <input id="del-confirm" className="input" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} autoComplete="off" />
      </Modal>
    </>
  );
}
