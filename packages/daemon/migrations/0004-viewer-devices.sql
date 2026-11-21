-- Devices paired with the read-only viewer listener (server mode): one row per device, holding only
-- the SHA-256 of its token. Kept across restarts so a phone does not have to pair again; a revoked
-- device's row is deleted.
CREATE TABLE viewer_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
