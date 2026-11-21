-- The office board's record (docs/storage.md): per local day, the top-level turns that ended done
-- and those cancelled, rolled up from `state_changes` before its retention removes them (days still
-- in the history are counted from it). A row means the day was observed: a day without one is a gap,
-- never zero. And the owner's monthly goal as it stood in each month, kept after the month ends.
CREATE TABLE turns_daily (
  day TEXT PRIMARY KEY,
  completed INTEGER NOT NULL,
  cancelled INTEGER NOT NULL
);

CREATE TABLE board_months (
  month TEXT PRIMARY KEY,
  target INTEGER
);
