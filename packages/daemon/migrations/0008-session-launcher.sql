-- Where a session runs (an app, an editor, a terminal), read once from the path of its verified
-- process by the liveness check; only the kind is kept, never the path.
ALTER TABLE sessions ADD COLUMN launcher TEXT;
