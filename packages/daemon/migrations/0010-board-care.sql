-- How the office's turns went, beside how many ended (docs/storage.md): per local day, the top-level
-- turns that ended done without waiting for the owner once (`solo`), those that failed or were lost
-- mid-turn (`failed`), the owner's answered waits (`waits`) and those that took more than five minutes
-- (`long_waits`). NULL for a day rolled up before this migration: unknown, never zero.
ALTER TABLE turns_daily ADD COLUMN solo INTEGER;
ALTER TABLE turns_daily ADD COLUMN failed INTEGER;
ALTER TABLE turns_daily ADD COLUMN waits INTEGER;
ALTER TABLE turns_daily ADD COLUMN long_waits INTEGER;
