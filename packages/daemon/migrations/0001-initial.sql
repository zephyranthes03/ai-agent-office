-- Session snapshots, state history and hook dedupe. Columns follow the storage spec; the
-- remaining tables (notes, usage, limits, controls, notifications, desks) arrive with their features.

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  parent TEXT,
  cwd TEXT,
  project TEXT,
  space TEXT,
  origin TEXT NOT NULL,
  state TEXT NOT NULL,
  waiting_reason TEXT,
  waiting_target TEXT,
  detail TEXT,
  result_json TEXT,
  lifecycle TEXT NOT NULL,
  state_since TEXT NOT NULL,
  last_signal_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  ended_at TEXT,
  pid INTEGER,
  pid_confidence TEXT,
  terminal_json TEXT,
  desk_id TEXT,
  snapshot_json TEXT NOT NULL
);
CREATE INDEX sessions_lifecycle ON sessions (lifecycle, ended_at);

CREATE TABLE state_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  at TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  rule TEXT,
  waiting_reason TEXT,
  waiting_target TEXT,
  detail TEXT
);
CREATE INDEX state_changes_seq ON state_changes (seq);
CREATE INDEX state_changes_session ON state_changes (session_id, at);

CREATE TABLE ingest_log (
  hook_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
CREATE INDEX ingest_log_received ON ingest_log (received_at);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
