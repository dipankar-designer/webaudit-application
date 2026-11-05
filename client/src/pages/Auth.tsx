import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeft, CheckCircle2, ShieldCheck } from 'lucide-react';
import { errorMessage, post } from '../lib/api';
import { useSession } from '../lib/session';
import { PLANS } from '@wpcg/shared';
import { Alert, Button } from '../components/ui';

// Free plan terms, from the plan definition (the pricing table and scan limits use the same values).
const FREE_TERMS = `${PLANS.free.scansPerMonth} scans a month, up to ${PLANS.free.maxPagesPerScan} pages each`;

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col justify-center px-4 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <Link to="/" className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
            <ArrowLeft className="size-4" aria-hidden />
            Back to home
          </Link>
          <Link to="/" className="mb-8 flex items-center gap-2.5" aria-label="WebAudit AI home">
            <div className="flex size-9 items-center justify-center rounded-lg bg-brand-600 text-on-brand">
              <ShieldCheck className="size-5" aria-hidden />
            </div>
            <span className="text-base font-semibold">WebAudit AI</span>
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-sm text-slate-600">{subtitle}</p>
          <div className="mt-8">{children}</div>
          <div className="mt-6 text-sm text-slate-600">{footer}</div>
        </div>
      </div>
      <div className="relative hidden overflow-hidden bg-ink lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(99,102,241,0.35),transparent_55%),radial-gradient(circle_at_80%_80%,rgba(14,165,233,0.2),transparent_50%)]" />
        <div className="relative flex h-full flex-col justify-center px-14 text-white">
          <p className="text-sm font-medium tracking-wide text-brand-800 uppercase">Website quality assurance</p>
          <h2 className="mt-3 max-w-md text-3xl leading-tight font-semibold">Find what is broken. Understand why. Prove it is fixed.</h2>
          <ul className="mt-8 space-y-3 text-sm text-slate-800">
            {[
              'Real browser scans with Chrome, axe-core and Lighthouse',
              'Plain-language fixes with evidence for every finding',
              'Verification scans that only resolve what was re-tested',
              'Reports you can share: in-app, PDF and CSV',
            ].map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { refresh } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await post('/auth/login', { email: f.get('email'), password: f.get('password') });
      // GuestOnly redirects to location.state.from once the session is loaded.
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="Welcome back. Sign in to see your websites and scan results." footer={<>New here? <Link className="font-medium text-brand-700 hover:underline" to="/signup">Create an account</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <Button type="submit" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const scanUrl = params.get('url');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await post('/auth/signup', {
        name: f.get('name'),
        email: f.get('email'),
        password: f.get('password'),
        workspaceName: f.get('workspaceName') || undefined,
        acceptTerms: f.get('acceptTerms') === 'on',
      });
      navigate('.', { replace: true, state: { from: scanUrl ? `/scans/new?url=${encodeURIComponent(scanUrl)}` : '/scans/new' } });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle={scanUrl ? `Create a free account to scan ${scanUrl}. ${FREE_TERMS}, no card required.` : `Start on the Free plan: ${FREE_TERMS}. No card required.`}
      footer={<>Already have an account? <Link className="font-medium text-brand-700 hover:underline" to="/login">Sign in</Link></>}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        <div>
          <label className="label" htmlFor="name">Your name</label>
          <input className="input" id="name" name="name" autoComplete="name" required />
        </div>
        <div>
          <label className="label" htmlFor="email">Work email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required aria-describedby="pw-help" />
          <p id="pw-help" className="help">At least 10 characters.</p>
        </div>
        <div>
          <label className="label" htmlFor="workspaceName">Company or agency name <span className="font-normal text-slate-500">(optional)</span></label>
          <input className="input" id="workspaceName" name="workspaceName" autoComplete="organization" />
        </div>
        <label className="flex items-start gap-2.5 text-sm text-slate-700">
          <input type="checkbox" name="acceptTerms" className="mt-0.5 size-4 rounded border-slate-300 accent-brand-600" required />
          <span>I will only scan websites I own or have permission to test. Scans are passive: forms are never submitted and nothing is changed on the site.</span>
        </label>
        <Button type="submit" className="w-full" loading={busy}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
