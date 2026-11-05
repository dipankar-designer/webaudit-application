-- Real-user (field) data from the Chrome UX Report for a scan's home page and its origin,
-- mobile and desktop. Fetched once per scan and kept, so the report does not change on every view
-- and Google's API is not called repeatedly. The 28-day collection period is stored with it.

CREATE TABLE crux_field_data (
  scan_id     uuid PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  page_url    text NOT NULL,
  data        jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
