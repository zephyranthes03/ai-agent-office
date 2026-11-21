-- The character species the owner chose for a session (docs/storage.md); NULL keeps the configured
-- assignment (scene.cast).
ALTER TABLE session_notes ADD COLUMN species TEXT;
