import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IssueStatusBadge, SeverityBadge, SeverityBar } from './ui';
import { fmtDuration, pathOf, plural } from '../lib/format';

describe('status display', () => {
  it('labels severity with text, not colour alone', () => {
    render(<SeverityBadge severity="critical" />);
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });
  it('explains issue statuses on hover', () => {
    render(<IssueStatusBadge status="not_tested" />);
    expect(screen.getByText('Not Tested').closest('[title]')).toHaveAttribute('title', expect.stringMatching(/could not re-run/));
  });
  it('describes the severity bar for screen readers', () => {
    render(<SeverityBar counts={{ critical: 1, high: 2, medium: 0, low: 0, info: 0 }} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/Critical 1, High 2/);
  });
});

describe('formatting', () => {
  it('formats durations and paths', () => {
    expect(fmtDuration(65000)).toBe('1 min 5 s');
    expect(pathOf('https://example.com/a?b=1')).toBe('/a?b=1');
    expect(plural(1, 'page')).toBe('1 page');
    expect(plural(2, 'page')).toBe('2 pages');
  });
});

describe('pagination', () => {
  it('shows the first, last and neighbouring pages with gaps', async () => {
    const { pageWindow } = await import('./ui');
    expect(pageWindow(1, 10)).toEqual([1, 2, null, 10]);
    expect(pageWindow(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageWindow(10, 10)).toEqual([1, null, 9, 10]);
    expect(pageWindow(1, 1)).toEqual([1]);
  });
});
