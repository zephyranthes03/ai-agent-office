-- Lifecycle control requests (docs/click-panel-and-controls.md): the owner's start, stop or restart
-- of an agent's process, from the click to its outcome, so the screens show what was asked and what
-- came of it and a daemon restart can settle a request it was waiting on without acting again.
-- `target` is the session id (or `start:<agent>` before a started session is known); `instance_json`
-- the process the request was bound to (id and start time); `launch_json` what a start or restart
-- opened (the session id it chose, the pid file, the folder); `evidence_json` allowlisted times and
-- counts only. Kept for `retention.history_days`.
CREATE TABLE control_requests (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  agent TEXT NOT NULL,
  control TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL,
  step TEXT,
  instance_json TEXT,
  launch_json TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  deadline_at TEXT,
  resolved_at TEXT,
  failure_reason TEXT
);
CREATE INDEX control_requests_open ON control_requests (status) WHERE status IN ('requested', 'sent');
CREATE INDEX control_requests_requested ON control_requests (requested_at);
