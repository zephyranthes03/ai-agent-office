// Attention signals: which sessions need the user, which finished a turn and wait for the next
// instruction, which were only opened, which have rested long enough to leave the office, and whose
// turn runs long. Judged here, outside the reducer,
// from the snapshots and each session's recorded transitions (`state_changes`): the rule id tells a
// lost process (B3) from an end the agent reported (B2). A session gone quiet (unknown) is not listed:
// most quiet turns are long commands or thoughts that come back by themselves, so the screen marks it
// quietly and the owner can send it home.
// The UI only reads the result (GET /v1/attention and the stream's `attention` events).
import { toMs } from "@agent-office/core";
import type { Snapshots, State } from "@agent-office/core";
import { changesState, startsTurn, TURN_STATES } from "./history.ts";
import type { HistoryRow } from "./history.ts";

export type { HistoryRow } from "./history.ts";

// The list's shape, as the screens read it, is written once in core.
import type { Attention, Away, Ended, Internal, Long, NeedsYou, NeedsYouSignal, Opened, Ready } from "@agent-office/core";
export type { Attention, Away, Ended, Internal, Long, NeedsYou, NeedsYouSignal, Opened, Ready };

const BUSY: readonly State[] = ["working", "waiting_dependency"];
/** Rest other than idle: a turn just ended (done, cancelled) or a session paused by a report. */
const REST_STATES: readonly State[] = ["done", "cancelled", "paused"];
const LOST_FROM: readonly State[] = ["working", "waiting_dependency", "waiting_user", "unknown"];
const ORDER: Record<NeedsYouSignal, number> = { approval: 0, input: 0, error: 1, lost: 2, schedule_missed: 3 };

/** `needs_you` with `extra` entries (missed scheduled tasks) in the list's order. */
export function withExtraNeeds(list: Attention, extra: readonly NeedsYou[]): Attention {
  if (extra.length === 0) return list;
  return { ...list, needs_you: [...list.needs_you, ...extra].sort((a, b) => ORDER[a.signal] - ORDER[b.signal] || bySince(a, b)) };
}

/**
 * The rows of the current turn, from its start. Without a recorded start, from the session's first
 * sight (a row with no previous state), or all rows given: the clock then counts from a lower bound.
 */
function currentTurn(rows: HistoryRow[]): { start: HistoryRow | null; rows: HistoryRow[] } {
  // For each row, the latest earlier row that changed the state (one pass, not one per row).
  const entered: (HistoryRow | undefined)[] = [];
  let last: HistoryRow | undefined;
  for (const row of rows) {
    entered.push(last);
    if (changesState(row)) last = row;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (startsTurn(row, entered[i])) return { start: row, rows: rows.slice(i) };
    if (row.from === null) return { start: null, rows: rows.slice(i) };
  }
  return { start: null, rows };
}

/** Milliseconds the session itself spent waiting for the user within `rows`, up to `now`. */
function waitedMs(rows: HistoryRow[], now: string): number {
  let ms = 0;
  rows.forEach((row, i) => {
    if (row.to === "waiting_user") ms += toMs(rows[i + 1]?.at ?? now) - toMs(row.at);
  });
  return ms;
}

/**
 * When the session last started (B1: started, resumed, cleared) or was first seen, if no turn has
 * started since; null otherwise.
 */
function openedSince(rows: HistoryRow[]): string | null {
  let since: string | null = null;
  let entered: HistoryRow | undefined;
  for (const row of rows) {
    // First seen in a turn (a direct report, or the daemon met it mid-turn) is not opened.
    if (row.from === null) since = TURN_STATES.includes(row.to) ? null : row.at;
    else if (row.rule === "B1") since = row.at;
    else if (startsTurn(row, entered)) since = null;
    if (changesState(row)) entered = row;
  }
  return since;
}

const bySince = (a: { session: string; since: string }, b: { session: string; since: string }): number =>
  toMs(a.since) - toMs(b.since) || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0);

/**
 * The attention list at `now`. User waits and failed turns count for every active session (a child
 * is named under its parent by whoever shows it); loss, finished turns, opened sessions and long turns
 * only for top-level sessions, because a child's loss is its parent's. `history` gives a
 * session's rows from the start of its current turn (see `startsTurn`); `longTurnS` 0 turns the long
 * marker off; `awayAfterS` 0 keeps resting sessions in the office.
 */
export function deriveAttention(snapshots: Snapshots, history: (session: string) => HistoryRow[], longTurnS: number, now: string, awayAfterS = 0, internalIds: ReadonlySet<string> = new Set()): Attention {
  const needsYou: NeedsYou[] = [];
  const ready: Ready[] = [];
  const long: Long[] = [];
  const opened: Opened[] = [];
  const away: Away[] = [];
  const internal: Internal[] = [];
  const ended: Ended[] = [];
  const leaves = (session: string, since: string) => {
    if (awayAfterS > 0 && toMs(now) - toMs(since) >= awayAfterS * 1000) away.push({ session, since });
  };
  for (const s of Object.values(snapshots)) {
    const active = s.lifecycle === "active";
    // The app's own thread, and its children: nobody can go to it; whatever it does shows in the
    // owner's conversation that uses it.
    if (internalIds.has(s.session) || (s.parent !== null && internalIds.has(s.parent))) {
      if (active && s.parent === null) internal.push({ session: s.session });
      continue;
    }
    if (active && s.state === "waiting_user") {
      needsYou.push({ session: s.session, signal: s.waiting_on?.reason === "approval" ? "approval" : "input", since: s.waiting_since ?? s.state_since });
      continue;
    }
    if (active && s.state === "error") {
      needsYou.push({ session: s.session, signal: "error", since: s.state_since });
      continue;
    }
    if (s.parent !== null) continue;
    if (!active) {
      const last = history(s.session).at(-1);
      // Lost mid-turn only: `unknown` counts when it interrupted a turn, not a session at rest.
      const midTurn = last !== undefined && (last.to !== "unknown" || (s.state_before_unknown !== null && TURN_STATES.includes(s.state_before_unknown)));
      const lost = last?.lifecycle === "ended" && last.rule === "B3" && LOST_FROM.includes(last.to) && midTurn;
      if (lost) needsYou.push({ session: s.session, signal: "lost", since: last.at });
      // How it ended: the owner's send-home (G2), its process going mid-turn (B3), or its agent's own end (a confirmed stop, G3, counts as that: the agent was asked and ended).
      const since = last?.lifecycle === "ended" ? last.at : s.last_signal_at;
      ended.push({ session: s.session, since, by: last?.rule === "G2" ? "owner" : lost ? "lost" : "agent" });
      continue;
    }
    // Quiet since its last signal: it leaves like a resting session, counted from when it went quiet.
    if (s.state === "unknown") {
      leaves(s.session, s.state_since);
      continue;
    }
    // Background work still running (commands, subagents or monitors the session left on): it rests but
    // is not finished, so it is neither a finished turn nor on its way home until its agent says the work
    // is over; the clock to go home starts at the turn that ends with none left.
    if (s.background > 0 && (s.state === "idle" || REST_STATES.includes(s.state))) continue;
    if (s.state === "idle") {
      const rows = history(s.session);
      const last = rows.at(-1);
      if (last?.from !== "done" || last.to !== "idle" || last.rule !== "H1") {
        const since = openedSince(rows);
        // Opened and never asked anything: it stands in the office until the same threshold as a
        // resting one, counted from when it was opened, then goes home (an app reopening old
        // sessions does not fill the room for good).
        if (since !== null) opened.push({ session: s.session, since });
        leaves(s.session, since ?? s.result?.at ?? s.state_since);
        continue;
      }
      const turn = currentTurn(rows);
      const end = rows.findLast((row) => row.to === "done") ?? last;
      // From the prompt the work began at: an earlier one when this turn went on with background work it had left running.
      const began = s.work_since !== null && turn.start !== null && toMs(s.work_since) < toMs(turn.start.at) ? s.work_since : (turn.start?.at ?? null);
      ready.push({ session: s.session, since: end.at, turn_s: began !== null ? Math.round((toMs(end.at) - toMs(began)) / 1000) : null });
      leaves(s.session, end.at);
      continue;
    }
    if (REST_STATES.includes(s.state)) {
      leaves(s.session, s.result?.at ?? s.state_since);
      continue;
    }
    if (longTurnS > 0 && BUSY.includes(s.state)) {
      const turn = currentTurn(history(s.session));
      const since = turn.start?.at ?? turn.rows[0]?.at ?? s.state_since;
      const waited = waitedMs(turn.rows, now);
      if (toMs(now) - toMs(since) - waited >= longTurnS * 1000) long.push({ session: s.session, since, basis: "threshold", start_known: turn.start !== null, waited_s: Math.round(waited / 1000) });
    }
  }
  needsYou.sort((a, b) => ORDER[a.signal] - ORDER[b.signal] || bySince(a, b));
  ready.sort(bySince);
  long.sort(bySince);
  opened.sort(bySince);
  away.sort(bySince);
  internal.sort((a, b) => a.session.localeCompare(b.session));
  ended.sort(bySince);
  return { needs_you: needsYou, ready, long, opened, away, internal, ended };
}

export type TrackerDeps = {
  snapshots: () => Snapshots;
  /** A session's rows from the start of its current turn, oldest first (the store's `turnRows`). */
  history: (session: string) => HistoryRow[];
  longTurnS: number;
  /** states.away_after_min in seconds; 0 or absent keeps resting sessions in the office. */
  awayAfterS?: number;
  /** Sessions the agent's app runs for itself (the daemon learns them from the app's own thread list). */
  internal?: () => ReadonlySet<string>;
  /** Needs-you entries judged elsewhere (missed scheduled tasks, schedule.ts), merged into the list. */
  extra?: () => NeedsYou[];
  now: () => number;
};

/**
 * Keeps the history rows it read per session until told that they changed, and recomputes the list
 * on demand: after each commit (new transitions) and on each tick (a turn crossing the threshold
 * changes no state).
 */
export class AttentionTracker {
  private readonly rows = new Map<string, HistoryRow[]>();
  private readonly deps: TrackerDeps;
  private last: string | null = null;
  private lastList: Attention | null = null;

  constructor(deps: TrackerDeps) {
    this.deps = deps;
  }

  /** Forgets the rows read for these sessions (for every session after a replay), so they are read again. */
  invalidate(sessions: Iterable<string> | "all"): void {
    if (sessions === "all") this.rows.clear();
    else for (const id of sessions) this.rows.delete(id);
  }

  current(): Attention {
    const snapshots = this.deps.snapshots();
    for (const id of this.rows.keys()) if (!Object.hasOwn(snapshots, id)) this.rows.delete(id);
    const list = deriveAttention(snapshots, (id) => this.historyOf(id), this.deps.longTurnS, new Date(this.deps.now()).toISOString(), this.deps.awayAfterS ?? 0, this.deps.internal?.() ?? new Set());
    return withExtraNeeds(list, this.deps.extra?.() ?? []);
  }

  /** The list when it differs from the one this last returned, else null. */
  changed(): Attention | null {
    const list = this.current();
    this.lastList = list;
    const text = JSON.stringify(list);
    if (text === this.last) return null;
    this.last = text;
    return list;
  }

  /** The list `changed` computed last (changed or not), else a fresh one. */
  latest(): Attention {
    return this.lastList ?? this.current();
  }

  private historyOf(id: string): HistoryRow[] {
    let rows = this.rows.get(id);
    if (rows === undefined) {
      rows = this.deps.history(id);
      this.rows.set(id, rows);
    }
    return rows;
  }
}
