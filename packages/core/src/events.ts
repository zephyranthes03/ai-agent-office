// A standard event posted directly (`emit`, HTTP) is a state report, adopted by rule F1.
// Unknown enum values fall back to their safe default (state → unknown, reason → tool, outcome →
// completed, origin → unknown), as the schema compatibility rules require; an unknown lifecycle
// value is ignored. `toEvent` goes the other way: a snapshot as the standard event the UI reads.
import { clipDetail } from "./detail.ts";
import { ORIGINS, STATES, WAIT_REASONS } from "./types.ts";
import type { Lifecycle, Origin, Outcome, Signal, Snapshot, State, WaitingOn, WaitReason } from "./types.ts";

const OUTCOMES: readonly Outcome[] = ["completed", "failed", "interrupted", "cancelled"];

/** The fields of a standard event the reducer reads; everything else is ignored. */
export type StateReportEvent = {
  agent: string;
  session: string;
  state: string;
  waiting_on?: { reason: string; target?: string | null } | null;
  detail?: string | null;
  result?: { outcome: string; at?: string | null } | null;
  ttl_s?: number | null;
  parent?: string | null;
  origin?: string | null;
  lifecycle?: string | null;
};

const pick = <T extends string>(allowed: readonly T[], value: string, fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

export function stateOf(value: string): State {
  return pick(STATES, value, "unknown");
}

export function originOf(value: string | null | undefined): Origin | null {
  return value == null ? null : pick(ORIGINS, value, "unknown");
}

export function signalFromEvent(event: StateReportEvent, at: string): Signal {
  const reason: WaitReason | null = event.waiting_on ? pick(WAIT_REASONS, event.waiting_on.reason, "tool") : null;
  return {
    kind: "signal",
    at,
    session: event.session,
    agent: event.agent,
    name: "state_reported",
    state: stateOf(event.state),
    waiting_on: reason === null ? null : { reason, target: clipDetail(event.waiting_on?.target) },
    detail: clipDetail(event.detail),
    result: event.result ? { outcome: pick(OUTCOMES, event.result.outcome, "completed"), at: event.result.at ?? null } : null,
    ttl_s: event.ttl_s ?? null,
    parent: event.parent ? event.parent : null,
    origin: originOf(event.origin),
    lifecycle: event.lifecycle === "active" || event.lifecycle === "ended" ? (event.lifecycle as Lifecycle) : null,
  };
}

/** What the daemon knows about a session besides its snapshot (from the hook envelopes). */
/** Where a session runs, from its verified process: an app, an editor, or a terminal. */
export type Launcher = "claude-app" | "codex-app" | "vscode" | "terminal";
/** `origin`: an origin the daemon learnt from the agent's own records (a scheduler's run opened this session), shown instead of the snapshot's. */
export type SessionMeta = { cwd: string | null; launcher?: Launcher | null; title?: string | null; origin?: Origin | null };

/** A standard event (schema version 1) describing one session as the reducer sees it. */
export type StandardEvent = {
  schema_version: 1;
  agent: string;
  session: string;
  parent: string | null;
  project: string | null;
  cwd: string | null;
  state: State;
  lifecycle: Lifecycle;
  waiting_on: WaitingOn | null;
  result: { outcome: Outcome; at: string } | null;
  detail: string | null;
  origin: Origin;
  ts: string;
  /** Set by the daemon once it knows the session's process; absent when it does not. */
  launcher?: Launcher;
  /** The title the agent's own apps show for the session (≤ 64 characters), when the daemon read one. */
  title?: string;
  /** For a subagent: its kind as its agent names it (Claude Code's `agent_type`, a Codex thread's role), when known. */
  child_type?: string;
  /** Work handed to other sessions: what is still out (where, who asked, since when) and how many results came back; absent when neither. */
  delegations?: { open: { target: string | null; initiation: string | null; since: string }[]; returned: number };
  /** How much of the session's background work (commands, subagents, monitors it left running) still ran when its agent last said; absent when none. */
  background?: number;
};

/** Last path segment of a working folder, for either separator; null for none. */
export function projectOf(cwd: string | null): string | null {
  if (cwd === null) return null;
  const name = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return name === "" ? null : (clipDetail(name)?.slice(0, 128) ?? null);
}

/** The snapshot as a standard event; `ts` is the time of its last signal. */
export function toEvent(snapshot: Snapshot, meta: SessionMeta): StandardEvent {
  return {
    schema_version: 1,
    agent: snapshot.agent,
    session: snapshot.session,
    parent: snapshot.parent,
    project: projectOf(meta.cwd),
    cwd: meta.cwd,
    state: snapshot.state,
    lifecycle: snapshot.lifecycle,
    waiting_on: snapshot.waiting_on ? { reason: snapshot.waiting_on.reason, target: clipDetail(snapshot.waiting_on.target) } : null,
    result: snapshot.result ? { outcome: snapshot.result.outcome, at: snapshot.result.at } : null,
    detail: clipDetail(snapshot.detail),
    origin: meta.origin ?? snapshot.origin,
    ts: snapshot.last_signal_at,
    ...(meta.launcher ? { launcher: meta.launcher } : {}),
    ...(meta.title ? { title: clipDetail(meta.title)! } : {}),
    ...(snapshot.parent !== null && snapshot.child_type ? { child_type: clipDetail(snapshot.child_type)! } : {}),
    ...(snapshot.delegations.open.length > 0 || snapshot.delegations.returned > 0 ? { delegations: { open: snapshot.delegations.open.map((item) => ({ target: clipDetail(item.target), initiation: clipDetail(item.initiation), since: item.started_at })), returned: snapshot.delegations.returned } } : {}),
    ...(snapshot.background > 0 && snapshot.lifecycle === "active" ? { background: snapshot.background } : {}),
  };
}
