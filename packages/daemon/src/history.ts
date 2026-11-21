// A session's recorded transitions (`state_changes`) and where its current turn starts in them. The
// store reads a session's rows back only as far as that start, and the attention list judges the
// turn from the same rows, so both take the boundary from here.
import type { Lifecycle, State } from "@agent-office/core";

/** One history row of a session; a session's rows are passed oldest first. */
export type HistoryRow = { at: string; seq: number; from: State | null; to: State; lifecycle: Lifecycle; rule: string | null };

/** The states of a turn. */
export const TURN_STATES: readonly State[] = ["working", "waiting_dependency", "waiting_user"];
const REST: readonly State[] = ["idle", "done", "error", "cancelled"];
// Neither turn nor rest: leaving them continues whatever the session was doing before.
const HELD: readonly State[] = ["unknown", "paused"];

/**
 * Whether `row` starts a turn, given `entered`, the row that brought the session into the state
 * `row` leaves: a prompt (C1); a move from rest into a turn without one (a direct report, tool
 * activity the user did not prompt); or leaving `unknown` or `paused` into a turn when the session
 * had entered it from rest. Idle after an approval wait that timed out (H6) is not rest: the turn
 * may go on. A prompt sent while the session is already working leaves no row, so its turn counts
 * from the earlier start: overstated, never understated.
 */
export function startsTurn(row: HistoryRow, entered: HistoryRow | undefined): boolean {
  if (row.rule === "C1") return true;
  if (row.from === null || !TURN_STATES.includes(row.to)) return false;
  if (REST.includes(row.from)) return !(row.from === "idle" && entered?.rule === "H6");
  return HELD.includes(row.from) && entered !== undefined && entered.from !== null && REST.includes(entered.from);
}

/** Whether a row changed the state (rows that keep it changed only the lifecycle or the wait). */
export const changesState = (row: HistoryRow): boolean => row.from !== row.to;
