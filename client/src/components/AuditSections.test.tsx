import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WordPressReportDTO, WpPluginDTO } from '@wpcg/shared';
import { VerificationPanel, WordPressSection } from './AuditSections';
import { parentPath } from './Layout';

afterEach(cleanup);

const plugin = (p: Partial<WpPluginDTO>): WpPluginDTO => ({
  slug: 'x',
  name: null,
  installedVersion: null,
  versionSource: null,
  versionConfidence: null,
  latestVersion: null,
  wordpressOrg: true,
  closedReason: null,
  lastUpdated: null,
  updateStatus: 'unknown',
  risk: 'unknown',
  riskReason: '',
  vulnLookup: 'ok',
  vulnerabilities: [],
  evidence: [],
  ...p,
});

const wp: WordPressReportDTO = {
  detected: true,
  markers: ['Files served from /wp-content/'],
  core: { version: '6.6.2', versionSource: 'Generator tag in the page HTML', confidence: 'high', latestVersion: '6.7', status: 'outdated', vulnLookup: 'ok', vulnerabilities: [], risk: 'low' },
  themes: [],
  totalInstalledPlugins: null,
  detectedPlugins: 2,
  plugins: [
    plugin({ slug: 'maps', name: 'Maps', installedVersion: '5.0.2', versionSource: 'Stable tag in the plugin’s readme.txt', versionConfidence: 'medium', latestVersion: '5.0.3', updateStatus: 'update_available', risk: 'low', riskReason: 'Update available.' }),
    plugin({ slug: 'premium-thing', wordpressOrg: false, riskReason: 'Installed version could not be verified.' }),
  ],
  sources: ['WordPress.org'],
  limitations: ['Total installed plugins cannot be determined from outside.'],
  checkedAt: '2026-10-28T10:00:00Z',
};

describe('WordPress and plugin information', () => {
  it('never claims a total plugin count it cannot know', () => {
    render(<WordPressSection wp={wp} />);
    const total = screen.getByText('Total installed plugins').closest('div')!;
    expect(within(total).getByText('Unable to verify')).toBeInTheDocument();
    expect(within(total).getByText(/2 detected on the public pages/)).toBeInTheDocument();
  });

  it('shows versions with their source, and "Unable to verify" instead of guesses', () => {
    render(<WordPressSection wp={wp} />);
    const rows = screen.getAllByRole('row');
    const maps = rows.find((r) => within(r).queryByText('Maps'))!;
    expect(within(maps).getByText('5.0.2')).toBeInTheDocument();
    expect(within(maps).getByText(/readme\.txt/)).toBeInTheDocument();
    expect(within(maps).getByText('Update available')).toBeInTheDocument();
    const premium = rows.find((r) => within(r).queryByText('premium-thing'))!;
    expect(within(premium).getByText('Unable to verify')).toBeInTheDocument();
    expect(within(premium).getByText('Not on WordPress.org')).toBeInTheDocument();
    expect(within(premium).getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getByText('Outdated')).toBeInTheDocument();
  });

  it('says so when the site is not WordPress', () => {
    render(<WordPressSection wp={{ ...wp, detected: false, core: null, plugins: [] }} />);
    expect(screen.getByText(/does not appear to run WordPress/)).toBeInTheDocument();
  });
});

describe('verification panel', () => {
  it('separates confirmed issues from review and pending items', () => {
    render(
      <VerificationPanel
        counts={{ confirmed: 7, needsManualReview: 3, pendingVerification: 1 }}
        summary={{ pagesDiscovered: 1, pagesScanned: 1, pagesFailed: 0, findings: 0, issuesDetected: 11, newIssues: 0, reopenedIssues: 0, resolvedIssues: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {}, verification: { checked: 4, confirmed: 1, pending: 1, dismissed: [{ rule: 'images.broken', item: 'https://s.test/a.webp', reason: 'HTTP 200 with image data' }] } }}
      />,
    );
    expect(screen.getByText('Confirmed issues').parentElement!.parentElement).toHaveTextContent('7');
    expect(screen.getByText(/1 dismissed as false positive/)).toBeInTheDocument();
  });
});

describe('back navigation', () => {
  it('falls back to the parent page when there is no history', () => {
    expect(parentPath('/monitors/abc')).toBe('/monitors');
    expect(parentPath('/scans/new')).toBe('/scans');
    expect(parentPath('/reports/xyz')).toBe('/reports');
    expect(parentPath('/incidents')).toBe('/dashboard');
  });
});
