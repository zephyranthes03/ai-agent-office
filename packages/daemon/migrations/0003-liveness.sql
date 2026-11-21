-- The agent process behind a session (the hook's process facts): the parent id its hooks reported,
-- and the start time of the verified process, so a later process with the same id is not taken for it.
ALTER TABLE sessions ADD COLUMN reported_pid INTEGER;
ALTER TABLE sessions ADD COLUMN pid_started_at TEXT;
