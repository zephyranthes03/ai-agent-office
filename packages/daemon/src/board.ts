// The office board's record: how many top-level turns ended done each local day, how
// many were cancelled, and how they went: done without waiting for the owner once, failed or lost
// mid-turn, and the owner's waits (answered, and those that took more than five minutes). Also the
// owner's monthly goal as it stood in each month, and today's sessions with a failure, silence or
// loss. Counted from the state history (`state_changes`); days about to leave its retention are
// rolled up into `turns_daily` first, in the same transaction that removes them. Only counts, days
// and session ids; never content.
import { addDays, dayStart, localDay } from "@agent-office/core";
import type { Store } from "./store.ts";

/**
 * A day with any recorded state change; days without one are gaps, never zero. `solo`, `failed`,
 * `waits` and `long_waits` are null for a day rolled up before they were counted (unknown).
 */
export type BoardDay = { day: string; completed: number; cancelled: number; solo: number | null; failed: number | null; waits: number | null; long_waits: number | null };
export type BoardIssue = { session: string; kind: "error" | "lost"; at: string };
export type BoardMonth = { month: string; target: number | null };
export type Board = { today: string; year: number; days: BoardDay[]; months: BoardMonth[]; issues_today: BoardIssue[] };

export type BoardOptions = { timeZone: string; dayStartsAt: string; monthlyTarget: number | null };

/** A wait for the owner longer than this (seconds) counts as a long one. */
export const LONG_WAIT_S = 300;

type Row = { session: string; at: string; from_state: string | null; to_state: string; rule: string | null; lifecycle: string; parent: string | null };
type Counts = Omit<BoardDay, "day">;

const TURN = ["working", "waiting_dependency", "waiting_user"];
const iso = (ms: number): string => new Date(ms).toISOString();
const zero = (): Counts => ({ completed: 0, cancelled: 0, solo: 0, failed: 0, waits: 0, long_waits: 0 });
/** Adds two days' counts; a count unknown on either side stays unknown. */
const add = (a: Counts, b: Counts): Counts => {
  const both = (x: number | null, y: number | null) => (x === null || y === null ? null : x + y);
  return { completed: a.completed + b.completed, cancelled: a.cancelled + b.cancelled, solo: both(a.solo, b.solo), failed: both(a.failed, b.failed), waits: both(a.waits, b.waits), long_waits: both(a.long_waits, b.long_waits) };
};

export class BoardRecord {
  private readonly store: Store;
  private readonly options: BoardOptions;

  constructor(store: Store, options: BoardOptions) {
    this.store = store;
    this.options = options;
  }

  private day(at: string): string {
    return localDay(at, this.options.timeZone, this.options.dayStartsAt);
  }

  /**
   * Per local day, among rows in [from, to): the top-level turns that ended done (and those done
   * without the session waiting for the owner since its last turn ended), cancelled, or failed or
   * lost mid-turn; and the top-level waits for the owner that ended, by the day they ended. A turn
   * or a wait that started before `from` is judged from its rows inside the range only.
   */
  private tally(from: string, to: string): Map<string, Counts> {
    const { timeZone, dayStartsAt } = this.options;
    const days = new Map<string, Counts>();
    const rows = this.store.db
      .prepare(`SELECT c.session_id AS session, c.at, c.from_state, c.to_state, c.rule, c.lifecycle, s.parent FROM state_changes c LEFT JOIN sessions s ON s.session_id = c.session_id
        WHERE c.at >= ? AND c.at < ? ORDER BY c.at, c.id`)
      .iterate(from, to) as Iterable<Row>;
    // Per top-level session: whether it waited for the owner in the current turn, and since when it waits.
    const sessions = new Map<string, { waited: boolean; since: string | null }>();
    // Rows come in time order: find a row's day only when it passes the current day's end.
    let current: { day: string; end: string; counts: Counts } | null = null;
    for (const row of rows) {
      if (current === null || row.at >= current.end) {
        const day = this.day(row.at);
        const counts = days.get(day) ?? zero();
        days.set(day, counts);
        current = { day, end: iso(dayStart(addDays(day, 1), timeZone, dayStartsAt)), counts };
      }
      // A child's turn is part of its parent's.
      if (row.parent !== null) continue;
      const counts = current.counts;
      const session = sessions.get(row.session) ?? { waited: false, since: null };
      sessions.set(row.session, session);
      const lost = row.rule === "B3" && row.lifecycle === "ended" && TURN.includes(row.to_state);
      // A wait ends with the first row that leaves it (or with the session lost while waiting).
      if (session.since !== null && (row.to_state !== "waiting_user" || lost)) {
        counts.waits!++;
        if (Date.parse(row.at) - Date.parse(session.since) > LONG_WAIT_S * 1000) counts.long_waits!++;
        session.since = null;
      }
      if (lost) {
        counts.failed!++;
        session.waited = false;
        continue;
      }
      // A row that keeps the state ends nothing.
      if (row.from_state === row.to_state) continue;
      if (row.to_state === "waiting_user") {
        session.waited = true;
        session.since = row.at;
      } else if (row.to_state === "done") {
        counts.completed++;
        if (!session.waited) counts.solo!++;
      } else if (row.to_state === "cancelled") counts.cancelled++;
      else if (row.to_state === "error") counts.failed!++;
      // Resting ends the turn; idle straight from a wait (an approval that timed out) does not.
      if (["done", "cancelled", "error"].includes(row.to_state) || (row.to_state === "idle" && row.from_state !== "waiting_user")) session.waited = false;
    }
    return days;
  }

  /** Adds the days of the rows before `before` to `turns_daily`; run in the transaction that then deletes those rows. */
  rollup(before: string): void {
    // A day rolled up in part before the new counts existed keeps them unknown (NULL + n is NULL).
    const insert = this.store.db.prepare(`INSERT INTO turns_daily (day, completed, cancelled, solo, failed, waits, long_waits) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (day) DO UPDATE SET completed = completed + excluded.completed, cancelled = cancelled + excluded.cancelled, solo = solo + excluded.solo,
        failed = failed + excluded.failed, waits = waits + excluded.waits, long_waits = long_waits + excluded.long_waits`);
    for (const [day, c] of this.tally("", before)) insert.run(day, c.completed, c.cancelled, c.solo, c.failed, c.waits, c.long_waits);
  }

  /** Records the owner's goal for the month `now` is in; a past month keeps the last goal recorded in it. */
  noteMonth(now: number): void {
    this.store.db
      .prepare("INSERT INTO board_months (month, target) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET target = excluded.target")
      .run(this.day(iso(now)).slice(0, 7), this.options.monthlyTarget);
  }

  /** The record of a local calendar year, and today's issues, as of `now`. */
  read(year: number, now: number): Board {
    const { timeZone, dayStartsAt } = this.options;
    this.noteMonth(now);
    const today = this.day(iso(now));
    const from = iso(dayStart(`${year}-01-01`, timeZone, dayStartsAt));
    const to = iso(dayStart(`${year + 1}-01-01`, timeZone, dayStartsAt));
    const days = new Map<string, Counts>();
    const rolled = this.store.db.prepare("SELECT day, completed, cancelled, solo, failed, waits, long_waits FROM turns_daily WHERE day >= ? AND day < ?").all(`${year}-01-01`, `${year + 1}-01-01`) as BoardDay[];
    for (const { day, ...counts } of rolled) days.set(day, counts);
    for (const [day, counts] of this.tally(from, to)) {
      const earlier = days.get(day);
      days.set(day, earlier === undefined ? counts : add(earlier, counts));
    }
    const months = this.store.db.prepare("SELECT month, target FROM board_months WHERE month >= ? AND month < ? ORDER BY month").all(`${year}-01`, `${year + 1}-01`) as BoardMonth[];
    return {
      today,
      year,
      days: [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, counts]) => ({ day, ...counts })),
      months,
      issues_today: this.issues(iso(dayStart(today, timeZone, dayStartsAt))),
    };
  }

  /**
   * Sessions that failed a turn or were lost today, the latest per session, oldest first. As in the
   * attention list: a failure counts for any session, a loss for top-level ones and only mid-turn (a
   * process gone after it went `unknown` is left out). Quiet turns are not issues.
   */
  private issues(since: string): BoardIssue[] {
    const rows = this.store.db
      .prepare(`SELECT c.session_id AS session, c.at, c.to_state, c.rule, c.lifecycle, s.parent FROM state_changes c LEFT JOIN sessions s ON s.session_id = c.session_id
        WHERE c.at >= ? AND (c.to_state = 'error' OR (c.rule = 'B3' AND c.lifecycle = 'ended' AND c.to_state IN ('working', 'waiting_dependency', 'waiting_user')))
        ORDER BY c.at`)
      .all(since) as { session: string; at: string; to_state: string; rule: string | null; lifecycle: string; parent: string | null }[];
    const latest = new Map<string, BoardIssue>();
    for (const row of rows) {
      const kind = row.to_state === "error" ? "error" : "lost";
      if (kind !== "error" && row.parent !== null) continue;
      latest.set(row.session, { session: row.session, kind, at: row.at });
    }
    return [...latest.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
}
