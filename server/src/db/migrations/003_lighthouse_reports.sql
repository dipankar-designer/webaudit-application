-- Full Lighthouse reports (PageSpeed-style: categories, groups, audits with details, screenshots),
-- one per scanned page and viewport. Compacted by the runner; typically 50–300 KB each.

CREATE TABLE lighthouse_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id     uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  page_url    text NOT NULL,
  viewport    text NOT NULL CHECK (viewport IN ('desktop', 'mobile')),
  scores      jsonb NOT NULL DEFAULT '{}',
  report      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, page_url, viewport)
);

CREATE INDEX lighthouse_reports_scan_idx ON lighthouse_reports (scan_id);
