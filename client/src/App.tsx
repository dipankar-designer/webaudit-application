import { lazy, type ComponentType } from 'react';
import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation, useRouteError } from 'react-router';
import { AppLayout } from './components/Layout';
import { ErrorState, LoadingState } from './components/ui';
import { SessionProvider, useSession } from './lib/session';
import { LoginPage, SignupPage } from './pages/Auth';
import { LandingPage } from './pages/Landing';
// Signed-in pages load on first use, so the public landing and sign-in pages do not download the
// whole dashboard (Lighthouse report, monitoring charts…). AppLayout shows a loading state meanwhile.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const OverviewPage = page(() => import('./pages/Overview'), 'OverviewPage');
const WebsitesPage = page(() => import('./pages/Websites'), 'WebsitesPage');
const WebsiteDetailPage = page(() => import('./pages/Websites'), 'WebsiteDetailPage');
const NewScanPage = page(() => import('./pages/NewScan'), 'NewScanPage');
const ScanHistoryPage = page(() => import('./pages/ScanHistory'), 'ScanHistoryPage');
const ScanDetailPage = page(() => import('./pages/ScanDetail'), 'ScanDetailPage');
const IssuesPage = page(() => import('./pages/Issues'), 'IssuesPage');
const IssueDetailPage = page(() => import('./pages/IssueDetail'), 'IssueDetailPage');
const BaselinesPage = page(() => import('./pages/Baselines'), 'BaselinesPage');
const ReportsPage = page(() => import('./pages/Reports'), 'ReportsPage');
const ReportViewPage = page(() => import('./pages/Reports'), 'ReportViewPage');
const SettingsPage = page(() => import('./pages/Settings'), 'SettingsPage');
const BillingPage = page(() => import('./pages/Billing'), 'BillingPage');
const MonitorsPage = page(() => import('./pages/Monitors'), 'MonitorsPage');
const NewMonitorPage = page(() => import('./pages/Monitors'), 'NewMonitorPage');
const MonitorDetailPage = page(() => import('./pages/Monitors'), 'MonitorDetailPage');
const IncidentsPage = page(() => import('./pages/Incidents'), 'IncidentsPage');
const AlertsPage = page(() => import('./pages/Incidents'), 'AlertsPage');
const NotFoundPage = page(() => import('./pages/NotFound'), 'NotFoundPage');

function RequireAuth() {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <LoadingState label="Checking your session…" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

function GuestOnly() {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <LoadingState />;
  // Signed in (e.g. just after login/sign-up): continue to where the user was heading.
  if (session) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/dashboard'} replace />;
  return <Outlet />;
}

function RouteError() {
  const error = useRouteError();
  return (
    <div className="mx-auto max-w-xl p-8">
      <ErrorState error={error instanceof Error ? error : new Error('This page could not be displayed.')} onRetry={() => window.location.reload()} />
    </div>
  );
}

const router = createBrowserRouter([
  // Public landing page: the first thing a visitor sees. Sign-in and sign-up are secondary links on it.
  { path: '/', element: <LandingPage />, errorElement: <RouteError /> },
  {
    element: <GuestOnly />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        errorElement: <RouteError />,
        children: [
          { path: '/dashboard', element: <OverviewPage /> },
          { path: '/monitors', element: <MonitorsPage /> },
          { path: '/monitors/new', element: <NewMonitorPage /> },
          { path: '/monitors/:id', element: <MonitorDetailPage /> },
          { path: '/incidents', element: <IncidentsPage /> },
          { path: '/alerts', element: <AlertsPage /> },
          { path: '/websites', element: <WebsitesPage /> },
          { path: '/websites/:id', element: <WebsiteDetailPage /> },
          { path: '/scans/new', element: <NewScanPage /> },
          { path: '/scans', element: <ScanHistoryPage /> },
          { path: '/scans/:id', element: <ScanDetailPage /> },
          { path: '/issues', element: <IssuesPage /> },
          { path: '/issues/:id', element: <IssueDetailPage /> },
          { path: '/baselines', element: <BaselinesPage /> },
          { path: '/reports', element: <ReportsPage /> },
          { path: '/reports/:scanId', element: <ReportViewPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '/billing', element: <BillingPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  );
}
