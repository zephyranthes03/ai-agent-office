-- What the owner writes about a session (docs/storage.md): a nickname shown instead of the project
-- name, a one-line description shown on the card, whether it is watched (a star, listed first) and
-- whether its finished turns are notified. Kept until the owner clears them.
CREATE TABLE session_notes (
  session_id TEXT PRIMARY KEY,
  nickname TEXT,
  description TEXT,
  watched INTEGER NOT NULL DEFAULT 0,
  alert_on_rest INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
