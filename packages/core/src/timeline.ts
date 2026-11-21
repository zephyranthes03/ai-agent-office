// Reorder window for late inputs. Hooks run as separate processes and spooled envelopes arrive in
// batches, so inputs can reach the daemon out of order. The timeline keeps the inputs of the last
// `windowS` seconds sorted by (at, seq) on top of a checkpoint (the state before them); an input
// that lands before the newest one is inserted in place and the window is reduced again from the
// checkpoint. One window covers all sessions, because rules cross sessions (children refresh their
// parent, adapter status and ticks touch every session). Pure: no clock, no I/O.
import type { StatesConfig } from "./config.ts";
import { reduceTraced } from "./reduce.ts";
import { toMs } from "./time.ts";
import type { Input, Snapshot, Snapshots, TraceEntry } from "./types.ts";

export type TimelineEntry = { input: Input; seq: number };

export type Timeline = {
  /** The state before every input in `entries`. */
  checkpoint: Snapshots;
  /** Time of the newest input folded into the checkpoint; null before any. */
  checkpointAt: string | null;
  /** The window, sorted by (at, seq). */
  entries: TimelineEntry[];
  /** The checkpoint with every entry applied. */
  current: Snapshots;
};

/** A transition worth a history row: state, waiting_on or lifecycle of a session changed. */
export type Transition = {
  seq: number;
  at: string;
  session: string;
  from: Snapshot | undefined;
  to: Snapshot;
  /** The last non-bookkeeping rule recorded for the session in this input; else the input's first such rule. */
  rule: string | null;
};

export type Advance = {
  timeline: Timeline;
  /** Transitions of the inputs that were (re)applied, in application order. */
  transitions: Transition[];
  /** Sequence numbers whose earlier transitions are void: they were reduced again. */
  replayed: number[];
  /** Inputs older than the window: applied at the head time instead of their own. */
  late: TimelineEntry[];
  /** Sessions whose snapshot object changed in `current`. */
  touched: string[];
  /** Inputs the reducer rejected (for example an unparsable time), with the error. */
  rejected: { entry: TimelineEntry; error: Error }[];
};

export function createTimeline(snapshots: Snapshots, checkpointAt: string | null): Timeline {
  return { checkpoint: snapshots, checkpointAt, entries: [], current: snapshots };
}

/**
 * Drops sessions from memory (for example ended ones nobody has heard from for a day), from both
 * the checkpoint and the current state. A later signal for such an id starts a new snapshot (A1).
 */
export function forgetSessions(timeline: Timeline, ids: Iterable<string>): Timeline {
  const drop = new Set(ids);
  if (drop.size === 0) return timeline;
  const without = (snapshots: Snapshots): Snapshots => {
    const out = Object.create(null) as Snapshots;
    for (const [id, snapshot] of Object.entries(snapshots)) if (!drop.has(id)) out[id] = snapshot;
    return out;
  };
  return { ...timeline, checkpoint: without(timeline.checkpoint), current: without(timeline.current) };
}

const before = (a: TimelineEntry, b: TimelineEntry): number => toMs(a.input.at) - toMs(b.input.at) || a.seq - b.seq;

const sameWait = (a: Snapshot["waiting_on"], b: Snapshot["waiting_on"]): boolean => (a === null || b === null ? a === b : a.reason === b.reason && a.target === b.target);

function transitionsOf(prior: Snapshots, next: Snapshots, entry: TimelineEntry, trace: TraceEntry[]): Transition[] {
  const out: Transition[] = [];
  const causes = trace.filter((item) => !item.rule.startsWith("I"));
  // A session the input changed without a rule of its own (a child created by E3, ended by B2)
  // gets the input's primary rule, which is the first one recorded.
  const ruleFor = (session: string) => causes.findLast((item) => item.session === session)?.rule ?? causes[0]?.rule ?? null;
  for (const [id, to] of Object.entries(next)) {
    const from = Object.hasOwn(prior, id) ? prior[id] : undefined;
    if (from === to) continue;
    if (from && from.state === to.state && from.lifecycle === to.lifecycle && sameWait(from.waiting_on, to.waiting_on)) continue;
    out.push({ seq: entry.seq, at: entry.input.at, session: id, from, to, rule: ruleFor(id) });
  }
  return out;
}

/**
 * Adds a batch of inputs. In-order inputs are reduced on top of `current`; if any input sorts
 * before the newest entry, the whole window is reduced again from the checkpoint (once per batch).
 * Inputs older than the checkpoint are applied at the head time and reported in `late`, except a signal
 * whose session already has a newer one, which is only reported. Afterwards
 * entries older than `windowS` before the newest are folded into the checkpoint.
 */
export function addInputs(timeline: Timeline, batch: TimelineEntry[], config: StatesConfig, windowS: number): Advance {
  const late: TimelineEntry[] = [];
  const rejected: Advance["rejected"] = [];
  let head = timeline.entries.length > 0 ? timeline.entries[timeline.entries.length - 1]!.input.at : timeline.checkpointAt;
  const accepted: TimelineEntry[] = [];
  for (const entry of batch) {
    let ms: number;
    try {
      ms = toMs(entry.input.at);
    } catch (error) {
      rejected.push({ entry, error: error as Error });
      continue;
    }
    if (timeline.checkpointAt !== null && ms < toMs(timeline.checkpointAt)) {
      late.push(entry);
      // A session that already had a newer signal keeps it: moved to the head, this one would undo it.
      if (supersededSignal(timeline.current, entry.input, ms)) continue;
      const moved = { input: { ...entry.input, at: head ?? entry.input.at }, seq: entry.seq } as TimelineEntry;
      accepted.push(moved);
    } else {
      accepted.push(entry);
      if (head === null || ms > toMs(head)) head = entry.input.at;
    }
  }

  const newestBefore = timeline.entries.length > 0 ? timeline.entries[timeline.entries.length - 1]! : null;
  const sortedBatch = [...accepted].sort(before);
  const inOrder = newestBefore === null || sortedBatch.length === 0 || before(sortedBatch[0]!, newestBefore) > 0;
  const entries = inOrder ? [...timeline.entries, ...sortedBatch] : [...timeline.entries, ...sortedBatch].sort(before);

  const transitions: Transition[] = [];
  const replayed: number[] = [];
  let current: Snapshots;
  let toApply: TimelineEntry[];
  if (inOrder) {
    current = timeline.current;
    toApply = sortedBatch;
  } else {
    const fresh = new Set(sortedBatch);
    const firstNew = entries.findIndex((entry) => fresh.has(entry));
    current = timeline.checkpoint;
    for (const entry of entries.slice(0, firstNew)) current = applyOne(current, entry, config, rejected, null);
    toApply = entries.slice(firstNew);
    for (const entry of toApply) if (!fresh.has(entry)) replayed.push(entry.seq);
  }
  for (const entry of toApply) current = applyOne(current, entry, config, rejected, transitions);

  const dropped = new Set(rejected.map((r) => r.entry));
  const kept = entries.filter((entry) => !dropped.has(entry));
  let checkpoint = timeline.checkpoint;
  let checkpointAt = timeline.checkpointAt;
  const newest = kept.length > 0 ? toMs(kept[kept.length - 1]!.input.at) : null;
  let cut = 0;
  if (newest !== null) {
    while (cut < kept.length && toMs(kept[cut]!.input.at) < newest - windowS * 1000) {
      // An entry that fails here already failed (and was reported) when it was first applied.
      checkpoint = applyOne(checkpoint, kept[cut]!, config, rejected, null);
      checkpointAt = kept[cut]!.input.at;
      cut++;
    }
  }

  const touched = Object.keys(current).filter((id) => !Object.hasOwn(timeline.current, id) || timeline.current[id] !== current[id]);
  return { timeline: { checkpoint, checkpointAt, entries: kept.slice(cut), current }, transitions, replayed, late, touched, rejected };
}

/** Whether `input` is a signal older than the last signal its session (or, for a child, its parent) already has. */
function supersededSignal(current: Snapshots, input: TimelineEntry["input"], ms: number): boolean {
  if (input.kind !== "signal") return false;
  const last = current[input.session]?.last_signal_at ?? (input.child_of ? current[input.child_of]?.last_signal_at : undefined);
  return last !== undefined && toMs(last) > ms;
}

function applyOne(state: Snapshots, entry: TimelineEntry, config: StatesConfig, rejected: Advance["rejected"], transitions: Transition[] | null): Snapshots {
  try {
    const { snapshots, trace } = reduceTraced(state, entry.input, config);
    if (transitions) transitions.push(...transitionsOf(state, snapshots, entry, trace));
    return snapshots;
  } catch (error) {
    if (!rejected.some((r) => r.entry === entry)) rejected.push({ entry, error: error instanceof Error ? error : new Error(String(error)) });
    return state;
  }
}
