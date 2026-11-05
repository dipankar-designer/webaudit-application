-- WebAudit AI — initial schema.
-- All customer data hangs off a workspace; every API query is scoped by workspace_id.

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE CHECK (email = lower(email)),
  name           text NOT NULL,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

CREATE TABLE workspaces (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  plan               text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'agency')),
  retention_days     integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  ai_enabled         boolean NOT NULL DEFAULT true,
  report_brand_name  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

-- Session tokens are stored only as SHA-256 hashes.
CREATE TABLE sessions (
  id            text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  csrf_token    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE websites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  base_url      text NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, base_url)
);

-- Scans double as the job queue: workers claim queued rows with FOR UPDATE SKIP LOCKED.
CREATE TABLE scans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  website_id        uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  kind              text NOT NULL CHECK (kind IN ('quick', 'full', 'verification')),
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  config            jsonb NOT NULL,
  authorised_at     timestamptz NOT NULL,
  authorised_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  heartbeat_at      timestamptz,
  worker_id         text,
  attempts          integer NOT NULL DEFAULT 0,
  cancel_requested  boolean NOT NULL DEFAULT false,
  error             text,
  progress          jsonb,
  summary           jsonb
);
CREATE INDEX scans_queue_idx ON scans(status, created_at);
CREATE INDEX scans_workspace_idx ON scans(workspace_id, created_at DESC);
CREATE INDEX scans_website_idx ON scans(website_id, created_at DESC);

CREATE TABLE scan_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id         uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url             text NOT NULL,
  final_url       text,
  status_code     integer,
  content_type    text,
  load_ms         integer,
  title           text,
  error           text,
  source          text NOT NULL,
  depth           integer NOT NULL DEFAULT 0,
  redirect_chain  jsonb NOT NULL DEFAULT '[]',
  lab_metrics     jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, url)
);

-- One row per category per scan: records honestly what ran, partially ran, failed or was skipped.
CREATE TABLE check_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id       uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  category      text NOT NULL,
  status        text NOT NULL CHECK (status IN ('completed', 'partial', 'failed', 'skipped', 'unavailable')),
  pages_tested  integer NOT NULL DEFAULT 0,
  detail        text NOT NULL DEFAULT '',
  started_at    timestamptz,
  finished_at   timestamptz,
  UNIQUE (scan_id, category)
);

-- What a scan successfully tested (check|viewport|target). Used so an issue is only
-- marked resolved when the same check re-ran on the same target under the same conditions.
CREATE TABLE scan_coverage (
  scan_id  uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  key      text NOT NULL,
  PRIMARY KEY (scan_id, key)
);

CREATE TABLE issues (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  website_id         uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  fingerprint        text NOT NULL,
  rule_id            text NOT NULL,
  category           text NOT NULL,
  severity           text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  title              text NOT NULL,
  status             text NOT NULL CHECK (status IN ('open', 'resolved', 'reopened', 'needs_review', 'not_tested', 'inconclusive')),
  wcag               text[] NOT NULL DEFAULT '{}',
  details            jsonb NOT NULL,
  coverage_keys      text[] NOT NULL DEFAULT '{}',
  first_detected_at  timestamptz NOT NULL,
  last_detected_at   timestamptz NOT NULL,
  first_scan_id      uuid REFERENCES scans(id) ON DELETE SET NULL,
  last_scan_id       uuid REFERENCES scans(id) ON DELETE SET NULL,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (website_id, fingerprint)
);
CREATE INDEX issues_workspace_idx ON issues(workspace_id, status, severity);

CREATE TABLE findings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id    uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  scan_id     uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  page_url    text NOT NULL,
  viewport    text,
  evidence    jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX findings_scan_idx ON findings(scan_id);
CREATE INDEX findings_issue_idx ON findings(issue_id, created_at DESC);

CREATE TABLE issue_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id       uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  scan_id        uuid REFERENCES scans(id) ON DELETE SET NULL,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  from_status    text,
  to_status      text NOT NULL,
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX issue_events_issue_idx ON issue_events(issue_id, created_at);

CREATE TABLE screenshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id     uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  page_id     uuid NOT NULL REFERENCES scan_pages(id) ON DELETE CASCADE,
  viewport    text NOT NULL CHECK (viewport IN ('desktop', 'mobile')),
  width       integer NOT NULL,
  height      integer NOT NULL,
  path        text NOT NULL,
  bytes       integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, viewport)
);
CREATE INDEX screenshots_scan_idx ON screenshots(scan_id);

CREATE TABLE baselines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  website_id    uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  scan_id       uuid NOT NULL UNIQUE REFERENCES scans(id) ON DELETE CASCADE,
  name          text NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE visual_comparisons (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id                 uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  baseline_scan_id        uuid REFERENCES scans(id) ON DELETE SET NULL,
  page_url                text NOT NULL,
  viewport                text NOT NULL,
  status                  text NOT NULL CHECK (status IN ('match', 'changed', 'incomparable', 'failed')),
  diff_ratio              double precision,
  threshold_pct           double precision NOT NULL,
  pixel_tolerance         double precision NOT NULL,
  baseline_screenshot_id  uuid REFERENCES screenshots(id) ON DELETE SET NULL,
  current_screenshot_id   uuid REFERENCES screenshots(id) ON DELETE SET NULL,
  diff_path               text,
  note                    text,
  settings                jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visual_comparisons_scan_idx ON visual_comparisons(scan_id);

-- Metering for server-side quota enforcement.
CREATE TABLE usage_events (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('scan', 'ai')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_idx ON usage_events(workspace_id, kind, created_at);

CREATE TABLE ai_outputs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id      uuid REFERENCES issues(id) ON DELETE CASCADE,
  scan_id       uuid REFERENCES scans(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  provider      text NOT NULL,
  model         text NOT NULL,
  content       text NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_outputs_issue_idx ON ai_outputs(issue_id, created_at DESC);
CREATE INDEX ai_outputs_scan_idx ON ai_outputs(scan_id, created_at DESC);
