-- Scheduled tasks as the agents' own schedulers plan them (today: Codex's scheduled tasks, read from
-- the app's database), refreshed on each pass: the schedule (name, status, rule, next and last run,
-- the project folder) apart from the run (the thread the newest run opened, its status, when), the
-- occurrence the daemon waits for (`expected_at`), and what it decided about an occurrence that
-- passed without a run: missed (watched all the while) or unsure (the daemon or the source was down).
-- Only ids, names, folders, states and times; never a prompt.
CREATE TABLE scheduled_tasks (
  task_key TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  name TEXT,
  project TEXT,
  cwd TEXT,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  rrule TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  expected_at TEXT,
  missed_at TEXT,
  unsure_at TEXT,
  unsure_reason TEXT,
  run_session TEXT,
  run_status TEXT,
  run_at TEXT,
  observed_at TEXT NOT NULL
);
