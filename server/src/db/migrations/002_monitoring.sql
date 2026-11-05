-- Scheduled website monitoring (Web Watcher catalogue), alerts and Stripe billing state.

-- ---------------------------------------------------------------- billing state on the workspace
ALTER TABLE workspaces
  ADD COLUMN stripe_customer_id      text UNIQUE,
  ADD COLUMN stripe_subscription_id  text UNIQUE,
  ADD COLUMN subscription_status     text,          -- Stripe status: active, trialing, past_due, canceled, ...
  ADD COLUMN subscription_period_end timestamptz,
  ADD COLUMN plan_source             text NOT NULL DEFAULT 'default' CHECK (plan_source IN ('default', 'stripe', 'operator')),
  ADD COLUMN alert_min_severity      text NOT NULL DEFAULT 'p2' CHECK (alert_min_severity IN ('p1', 'p2', 'p3', 'p4'));

-- Webhook idempotency: every Stripe event is processed at most once.
CREATE TABLE stripe_events (
  id            text PRIMARY KEY,
  type          text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  error         text
);

-- ---------------------------------------------------------------- monitors
CREATE TABLE monitors (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  website_id              uuid REFERENCES websites(id) ON DELETE SET NULL,
  kind                    text NOT NULL DEFAULT 'website' CHECK (kind IN ('website', 'heartbeat')),
  name                    text NOT NULL,
  url                     text,                         -- NULL for heartbeat monitors
  enabled                 boolean NOT NULL DEFAULT true,
  interval_seconds        integer NOT NULL DEFAULT 300 CHECK (interval_seconds BETWEEN 30 AND 86400),
  keyword                 text,
  keyword_mode            text CHECK (keyword_mode IN ('present', 'absent')),
  money_page              boolean NOT NULL DEFAULT false,
  exposure_authorised_at  timestamptz,                  -- opt-in for attack-shaped probes (R6–R8)
  heartbeat_token         text UNIQUE,
  heartbeat_grace_seconds integer NOT NULL DEFAULT 300,
  last_heartbeat_at       timestamptz,
  created_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'website' AND url IS NOT NULL) OR (kind = 'heartbeat' AND heartbeat_token IS NOT NULL))
);
CREATE INDEX monitors_workspace_idx ON monitors(workspace_id, created_at);

-- One row per watcher on a monitor: its own cadence, schedule, lock, last state and change baseline.
CREATE TABLE monitor_checks (
  monitor_id            uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  check_key             text NOT NULL,
  enabled               boolean NOT NULL DEFAULT true,
  interval_seconds      integer NOT NULL,
  next_run_at           timestamptz NOT NULL DEFAULT now(),
  locked_at             timestamptz,
  locked_by             text,
  last_run_at           timestamptz,
  last_status           text,
  last_severity         text,
  last_summary          text,
  last_change_at        timestamptz,
  consecutive_errors    integer NOT NULL DEFAULT 0,
  baseline              jsonb,
  PRIMARY KEY (monitor_id, check_key)
);
CREATE INDEX monitor_checks_due_idx ON monitor_checks(next_run_at) WHERE enabled;

-- Timestamped history of every run.
CREATE TABLE check_results (
  id           bigserial PRIMARY KEY,
  monitor_id   uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  check_key    text NOT NULL,
  status       text NOT NULL CHECK (status IN ('up', 'warning', 'down', 'not_assessed', 'error')),
  severity     text CHECK (severity IN ('p1', 'p2', 'p3', 'p4')),
  summary      text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}',
  response_ms  integer,
  ttfb_ms      integer,
  http_status  integer,
  attempts     integer NOT NULL DEFAULT 1,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX check_results_monitor_idx ON check_results(monitor_id, check_key, started_at DESC);
CREATE INDEX check_results_time_idx ON check_results(started_at);

-- An incident spans consecutive failing results of one watcher.
CREATE TABLE incidents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  monitor_id          uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  check_key           text NOT NULL,
  severity            text NOT NULL CHECK (severity IN ('p1', 'p2', 'p3', 'p4')),
  title               text NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  occurrences         integer NOT NULL DEFAULT 1,
  first_result_id     bigint REFERENCES check_results(id) ON DELETE SET NULL,
  last_result_id      bigint REFERENCES check_results(id) ON DELETE SET NULL,
  detail              jsonb NOT NULL DEFAULT '{}',
  acknowledged_at     timestamptz,
  acknowledged_by     uuid REFERENCES users(id) ON DELETE SET NULL
);
-- At most one open incident per watcher: the de-duplication rule for alerts.
CREATE UNIQUE INDEX incidents_one_open_idx ON incidents(monitor_id, check_key) WHERE status = 'open';
CREATE INDEX incidents_workspace_idx ON incidents(workspace_id, status, opened_at DESC);

-- ---------------------------------------------------------------- alerts
CREATE TABLE alert_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel       text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  target        text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, channel, target)
);

CREATE TABLE alert_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  incident_id   uuid REFERENCES incidents(id) ON DELETE CASCADE,
  contact_id    uuid REFERENCES alert_contacts(id) ON DELETE SET NULL,
  target        text NOT NULL,
  event         text NOT NULL CHECK (event IN ('opened', 'resolved', 'test')),
  status        text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, contact_id, event)
);
CREATE INDEX alert_deliveries_workspace_idx ON alert_deliveries(workspace_id, created_at DESC);

-- ---------------------------------------------------------------- watch the watcher
CREATE TABLE system_heartbeats (
  component   text PRIMARY KEY,
  worker_id   text NOT NULL,
  beat_at     timestamptz NOT NULL DEFAULT now(),
  detail      jsonb NOT NULL DEFAULT '{}'
);
