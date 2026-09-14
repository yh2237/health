-- Health monitor checks table
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  ok INTEGER NOT NULL, -- 0 or 1
  status INTEGER,
  latency_ms INTEGER NOT NULL,
  error TEXT,
  is_tunnel_error INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_checks_service_time ON checks(service_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_checks_timestamp ON checks(timestamp);
