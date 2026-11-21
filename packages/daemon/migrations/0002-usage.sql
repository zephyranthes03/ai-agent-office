-- Token usage and rate limits read from the agents' own logs (usage-and-cost.md, storage.md).
-- Only counts, ids, times and model names; never content.

CREATE TABLE usage_samples (
  record_key TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT,
  at TEXT NOT NULL,
  model TEXT,
  "in" INTEGER NOT NULL,
  out INTEGER NOT NULL,
  cached_in INTEGER NOT NULL,
  cache_write_in INTEGER NOT NULL,
  reasoning_out INTEGER NOT NULL,
  source_file TEXT
);
CREATE INDEX usage_samples_at ON usage_samples (at);

-- Unknown project or model is '' (not NULL), so the primary key can be replaced.
CREATE TABLE usage_daily (
  day TEXT NOT NULL,
  tz TEXT NOT NULL,
  agent TEXT NOT NULL,
  project TEXT NOT NULL,
  model TEXT NOT NULL,
  "in" INTEGER NOT NULL,
  out INTEGER NOT NULL,
  cached_in INTEGER NOT NULL,
  cache_write_in INTEGER NOT NULL,
  reasoning_out INTEGER NOT NULL,
  estimated_cost_usd REAL,
  pricing_version TEXT,
  complete INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (day, tz, agent, project, model)
);

-- One row per window (primary, secondary) of each observation.
CREATE TABLE rate_limits (
  provider TEXT NOT NULL,
  limit_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  window TEXT NOT NULL,
  window_minutes INTEGER,
  used_percent REAL NOT NULL,
  resets_at TEXT,
  plan_type TEXT,
  limit_name TEXT,
  credits_balance TEXT,
  reached TEXT,
  source_file TEXT,
  PRIMARY KEY (provider, limit_id, observed_at, window)
);

-- Where the log strategies stopped: a thread's last cumulative total, a file's last modification time.
CREATE TABLE usage_cursors (
  key TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  value_json TEXT NOT NULL
);
