// Ingest: hook envelopes and standard events → signals → the timeline (reducer with the reorder
// window) → SQLite → change notifications. Everything that enters is validated against the
// published schemas first. The `meta` an envelope carries is dropped (it exists for replay fixtures),
// so a forged envelope cannot set a session's origin; the daemon reads it itself, from the transcript
// the hook names, while a Claude Code session's origin is still open (envelope-meta.ts). Diagnostics
// name codes and rule paths, never input.
import { createHash } from "node:crypto";
import { mapperFor } from "@agent-office/adapters";
import { addInputs, createTimeline, DISMISSIBLE, forgetSessions, signalFromEvent, toEvent } from "@agent-office/core";
import type { HookEnvelope, Input, Snapshot, Snapshots, StandardEvent, State, StateReportEvent, Timeline, TimelineEntry, Transition } from "@agent-office/core";
import type { CodexTurnMeta, TranscriptMeta } from "@agent-office/adapters";
import type { DaemonConfig } from "./config.ts";
import { EnvelopeMeta } from "./envelope-meta.ts";
import { NO_INFO } from "./store.ts";
import type { PidConfidence, SessionInfo, Store } from "./store.ts";
import type { Validators } from "./validate.ts";

export type Prepared = { entries: TimelineEntry[]; hookId: string | null; info: Map<string, Partial<SessionInfo>> };
export type Rejection = { code: string };
/** What a commit wrote to the history: the sessions with new rows, and whether earlier rows were replaced. */
export type Committed = { sessions: string[]; replayed: boolean };

const FUTURE_SLACK_MS = 5000;

/**
 * The id of a standard event: its content (`event:<sha256>`), recorded in `ingest_log` like a hook id,
 * so the copy `agent-office emit` spooled after a timed-out POST is recognised when it is drained.
 */
export const eventId = (event: unknown): string => `event:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
const RELOAD_ENDED_MS = 86_400_000;
/** The states of a turn that Esc can end without a hook. */
const INTERRUPTIBLE: readonly State[] = ["working", "waiting_dependency", "waiting_user"];

export class Ingestor {
  private timeline: Timeline;
  private readonly info = new Map<string, SessionInfo>();
  private readonly persisted = new Map<string, string>();
  /** The titles the agents' own apps show, read from their files; kept in memory only. */
  private readonly titles = new Map<string, string>();
  /** Sessions a scheduler's run opened (schedule.ts, by exact thread id): shown as scheduled, named for the task; memory only. */
  private readonly scheduled = new Map<string, string | null>();
  private seq: number;
  /** What a failed commit could not write; carried into the next commit (and hook ids kept for dedupe). */
  private readonly unwritten = { sessions: new Set<string>(), transitions: [] as Transition[], replayed: [] as number[], hookIds: new Map<string, string>() };
  private readonly store: Store;
  private readonly config: DaemonConfig;
  private readonly validators: Validators;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly onChange: (events: StandardEvent[]) => void;
  private readonly onCommit: (commit: Committed) => void;
  /** What the daemon reads itself for an envelope: a session's origin, a Codex turn's settings. */
  private readonly meta: EnvelopeMeta;

  constructor(deps: {
    store: Store;
    config: DaemonConfig;
    validators: Validators;
    now: () => number;
    log: (line: string) => void;
    onChange: (events: StandardEvent[]) => void;
    /** Called after each successful commit (the attention list reads the history rows it wrote). */
    onCommit?: (commit: Committed) => void;
    /** The transcript-metadata strategy; absent, origins come from direct reports only. */
    readMeta?: (transcriptPath: string) => TranscriptMeta | null;
    /** The Codex turn-settings strategy; absent, every Codex approval request is a wait for the owner. */
    readTurnMeta?: (transcriptPath: string) => CodexTurnMeta | null;
  }) {
    ({ store: this.store, config: this.config, validators: this.validators, now: this.now, log: this.log, onChange: this.onChange } = deps);
    this.onCommit = deps.onCommit ?? (() => undefined);
    this.meta = new EnvelopeMeta(deps, this.log);
    const snapshots: Snapshots = Object.create(null) as Snapshots;
    for (const { snapshot, info } of this.store.loadSessions(new Date(this.now() - RELOAD_ENDED_MS).toISOString())) {
      snapshots[snapshot.session] = snapshot;
      this.info.set(snapshot.session, info);
      this.persisted.set(snapshot.session, JSON.stringify(snapshot));
    }
    this.timeline = createTimeline(snapshots, this.store.getMeta("head_at"));
    const row = this.store.db.prepare("SELECT MAX(seq) AS seq FROM state_changes").get() as { seq: number | null };
    this.seq = row.seq ?? 0;
  }

  /** Every known session as a standard event. */
  sessions(): StandardEvent[] {
    return Object.values(this.timeline.current).map((snapshot) => this.eventOf(snapshot));
  }

  /** A session as the screens see it: its snapshot with its working folder, where it runs and its title (not in screen-share mode); a scheduler's run is scheduled, named for its task. */
  private eventOf(snapshot: Snapshot): StandardEvent {
    const info = this.info.get(snapshot.session);
    const scheduled = this.scheduled.has(snapshot.session);
    const title = this.config.notify.screenShare ? null : ((scheduled ? this.scheduled.get(snapshot.session) : null) ?? this.titles.get(snapshot.session) ?? null);
    return toEvent(snapshot, { cwd: info?.cwd ?? null, launcher: info?.launcher ?? null, title, origin: scheduled ? "scheduled" : null });
  }

  /** The ids of every session of `agent` the daemon knows, active or recently ended. */
  sessionIds(agent: string): Set<string> {
    return new Set(Object.values(this.timeline.current).filter((s) => s.agent === agent).map((s) => s.session));
  }

  /**
   * The sessions a scheduler's runs opened (session → the task's name), as the schedule pass found
   * them by exact id: they show as `scheduled` and carry the task's name. The set replaces the last
   * one; the sessions whose event changed are announced.
   */
  setScheduled(links: ReadonlyMap<string, string | null>): void {
    const changed = new Set<string>();
    for (const [id, name] of links) {
      if (this.scheduled.has(id) && this.scheduled.get(id) === name) continue;
      this.scheduled.set(id, name);
      changed.add(id);
    }
    for (const id of [...this.scheduled.keys()]) {
      if (links.has(id)) continue;
      this.scheduled.delete(id);
      changed.add(id);
    }
    const events = [...changed].flatMap((id) => {
      const snapshot = this.timeline.current[id];
      return snapshot === undefined ? [] : [this.eventOf(snapshot)];
    });
    if (events.length > 0) this.onChange(events);
  }

  /** Active top-level sessions of `agent` that a hook reported: only their ids may select an agent's files. */
  reportedSessions(agent: string): string[] {
    return Object.values(this.timeline.current)
      .filter((s) => s.agent === agent && s.lifecycle === "active" && s.parent === null && (this.info.get(s.session)?.reportedPid ?? null) !== null)
      .map((s) => s.session);
  }

  /**
   * Active child sessions of `agent` under a reported top-level session, by the child's own id (the
   * part after the parent's): for Codex that is the subagent thread's id, which names its row in the
   * agent's files.
   */
  reportedChildren(agent: string): Map<string, string> {
    const parents = new Set(this.reportedSessions(agent));
    const children = new Map<string, string>();
    for (const s of Object.values(this.timeline.current)) {
      if (s.agent !== agent || s.lifecycle !== "active" || s.parent === null || !parents.has(s.parent)) continue;
      const own = s.session.slice(s.parent.length + 1);
      if (own !== "") children.set(own, s.session);
    }
    return children;
  }

  /** Titles read from the agents' files; the sessions whose title changed are announced. */
  setTitles(titles: ReadonlyMap<string, string>): void {
    const changed: StandardEvent[] = [];
    for (const [id, title] of titles) {
      const snapshot = this.timeline.current[id];
      if (snapshot === undefined || this.titles.get(id) === title) continue;
      this.titles.set(id, title);
      changed.push(this.eventOf(snapshot));
    }
    if (changed.length > 0 && !this.config.notify.screenShare) this.onChange(changed);
  }

  /** What the hooks and the liveness check reported about a session, if it is known. */
  infoOf(id: string): SessionInfo | undefined {
    return this.info.get(id);
  }

  /** Every known session's snapshot (read-only). */
  snapshots(): Snapshots {
    return this.timeline.current;
  }

  /** ISO time of `value`, clamped to a few seconds into the future; null when it does not parse. */
  private normalizeTime(value: string): string | null {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return null;
    return new Date(Math.min(ms, this.now() + FUTURE_SLACK_MS)).toISOString();
  }

  private entries(inputs: Input[]): TimelineEntry[] {
    return inputs.map((input) => ({ input, seq: ++this.seq }));
  }

  /** Checks and maps one envelope posted for `agent` (the URL segment or the spool file name). */
  prepareEnvelope(agent: string, body: unknown): Prepared | Rejection {
    const errors = this.validators.envelope(body);
    if (errors.length > 0) {
      this.log(`invalid_envelope ${errors.slice(0, 3).join("; ")}`);
      return { code: "invalid_envelope" };
    }
    const envelope = body as HookEnvelope & { event: { meta?: unknown } };
    if (envelope.agent !== agent) return { code: "agent_mismatch" };
    const map = mapperFor(agent);
    if (!map) return { code: "unknown_agent" };
    const at = this.normalizeTime(envelope.observed_at);
    if (at === null) return { code: "invalid_time" };
    if (this.unwritten.hookIds.has(envelope.hook_id) || this.store.hookSeen(envelope.hook_id)) return { entries: [], hookId: null, info: new Map() };
    // `meta` exists for replay fixtures only; what an envelope carries there is never trusted.
    const event = { ...envelope.event, meta: this.meta.read(agent, envelope.event, this.timeline.current[envelope.event.session_id]) };
    const signals = map(event, at);
    const info = new Map<string, Partial<SessionInfo>>();
    const facts: Partial<SessionInfo> = { reportedPid: envelope.process.ppid, terminal: envelope.terminal ?? null };
    if (event.cwd) facts.cwd = event.cwd;
    for (const id of new Set([event.session_id, ...signals.map((signal) => signal.session)])) info.set(id, { ...facts, firstSeenAt: at });
    return { entries: this.entries(signals), hookId: envelope.hook_id, info };
  }

  /** Whether an input with this id was applied in memory but its commit has not succeeded yet. */
  waitingFor(id: string): boolean {
    return this.unwritten.hookIds.has(id);
  }

  /** Checks one standard event (a direct state report); one already applied adds nothing. */
  prepareEvent(body: unknown): Prepared | Rejection {
    const errors = this.validators.event(body);
    if (errors.length > 0) {
      this.log(`invalid_event ${errors.slice(0, 3).join("; ")}`);
      return { code: "invalid_event" };
    }
    const event = body as StateReportEvent & { ts: string; cwd?: string | null };
    const at = this.normalizeTime(event.ts);
    if (at === null) return { code: "invalid_time" };
    const id = eventId(body);
    if (this.unwritten.hookIds.has(id) || this.store.hookSeen(id)) return { entries: [], hookId: null, info: new Map() };
    const info = new Map<string, Partial<SessionInfo>>([[event.session, { ...(event.cwd ? { cwd: event.cwd } : {}), firstSeenAt: at }]]);
    return { entries: this.entries([signalFromEvent(event, at)]), hookId: id, info };
  }

  /** The newest signal of any session, or null when there is none (the polling policy's activity). */
  lastSignalAt(): string | null {
    let last: string | null = null;
    for (const snapshot of Object.values(this.timeline.current)) if (last === null || snapshot.last_signal_at > last) last = snapshot.last_signal_at;
    return last;
  }

  /** Lets go of sessions that ended and have been silent for a day; their rows stay in the database. */
  evictEnded(): number {
    const before = new Date(this.now() - RELOAD_ENDED_MS).getTime();
    const ids = Object.values(this.timeline.current)
      .filter((snapshot) => snapshot.lifecycle === "ended" && Date.parse(snapshot.last_signal_at) < before)
      .map((snapshot) => snapshot.session);
    this.timeline = forgetSessions(this.timeline, ids);
    for (const id of ids) {
      this.info.delete(id);
      this.persisted.delete(id);
      this.titles.delete(id);
      this.scheduled.delete(id);
    }
    return ids.length;
  }

  /** Active sessions whose hooks named a parent process, with what is known of that process. */
  livenessTargets(): { session: string; agent: string; info: SessionInfo }[] {
    return Object.values(this.timeline.current)
      .filter((snapshot) => snapshot.lifecycle === "active")
      .flatMap((snapshot) => {
        const info = this.info.get(snapshot.session);
        return info !== undefined && info.reportedPid !== null ? [{ session: snapshot.session, agent: snapshot.agent, info }] : [];
      });
  }

  /**
   * The liveness check's results: what it learnt about each session's process, and a liveness
   * report (rule B3) for the sessions whose process it could check.
   */
  reportLiveness(results: { session: string; facts: Partial<SessionInfo>; report: { alive: boolean; confidence: Exclude<PidConfidence, "unknown"> } | null }[]): boolean {
    const at = new Date(this.now()).toISOString();
    const inputs: Input[] = results.flatMap(({ session, report }) => (report === null ? [] : [{ kind: "liveness" as const, at, session, alive: report.alive, confidence: report.confidence }]));
    const info = new Map(results.map(({ session, facts }) => [session, facts]));
    return this.apply([{ entries: this.entries(inputs), hookId: null, info }]);
  }

  /**
   * Claude Code sessions in a turn (or gone quiet in one) whose last signal is at least `quietMs` old:
   * Esc sends no hook, so their transcripts are looked at for its marker. Top-level sessions a hook
   * reported only (an id given by `agent-office emit` never selects a file).
   */
  interruptCandidates(quietMs: number): { session: string; since: string }[] {
    const now = this.now();
    return Object.values(this.timeline.current)
      .filter((snapshot) => this.interruptible(snapshot) && now - Date.parse(snapshot.last_signal_at) >= quietMs)
      .map((snapshot) => ({ session: snapshot.session, since: snapshot.last_signal_at }));
  }

  private interruptible(snapshot: Snapshot): boolean {
    const turn = snapshot.state === "unknown" ? snapshot.state_before_unknown : snapshot.state;
    return snapshot.agent === "claude-code" && snapshot.lifecycle === "active" && snapshot.parent === null && turn !== null && INTERRUPTIBLE.includes(turn) && (this.info.get(snapshot.session)?.reportedPid ?? null) !== null;
  }

  /**
   * Interrupt markers found in transcripts, as turn interruptions (rule C4) now: only for sessions
   * still in a turn with no signal since the marker (a prompt sent meanwhile wins).
   */
  reportInterrupts(found: { session: string; at: string }[]): boolean {
    const at = new Date(this.now()).toISOString();
    const sessions = new Set(found.flatMap(({ session, at: marker }) => {
      const snapshot = this.timeline.current[session];
      return snapshot !== undefined && this.interruptible(snapshot) && Date.parse(marker) > Date.parse(snapshot.last_signal_at) ? [session] : [];
    }));
    const inputs: Input[] = [...sessions].map((session) => ({ kind: "signal", at, session, agent: "claude-code", name: "turn_interrupted" }));
    return this.apply([{ entries: this.entries(inputs), hookId: null, info: new Map() }]);
  }

  /**
   * The owner sends a session home (rule G2): "unknown" for an id it does not know, "refused" for a
   * child, an ended session, or one in a turn or waiting for the owner; "stored" or "unstored" (the
   * database write failed and is retried with the next commit) once applied.
   */
  dismiss(id: string): "unknown" | "refused" | "stored" | "unstored" {
    const snapshot = this.timeline.current[id];
    if (snapshot === undefined) return "unknown";
    if (snapshot.lifecycle === "ended" || snapshot.parent !== null || !DISMISSIBLE.includes(snapshot.state)) return "refused";
    const at = new Date(this.now()).toISOString();
    return this.apply([{ entries: this.entries([{ kind: "dismissal", at, session: id }]), hookId: null, info: new Map() }]) ? "stored" : "unstored";
  }

  /**
   * The owner's stop of a session's process was confirmed (rule G3, controls.ts): the session ends
   * with its children until its next signal. False when the database write failed (retried with the next commit).
   */
  stopped(id: string): boolean {
    const at = new Date(this.now()).toISOString();
    return this.apply([{ entries: this.entries([{ kind: "stopped", at, session: id }]), hookId: null, info: new Map() }]);
  }

  /**
   * A clock tick, a second behind now so that hooks just arriving are not late, but never before the
   * newest input already reduced: a tick that sorted before it would make the whole window replay.
   */
  tick(): void {
    const head = this.timeline.entries.at(-1)?.input.at ?? this.timeline.checkpointAt;
    const at = Math.max(this.now() - 1000, head === null ? 0 : Date.parse(head));
    this.apply([{ entries: this.entries([{ kind: "tick", at: new Date(at).toISOString() }]), hookId: null, info: new Map() }]);
  }

  /**
   * Reduces a batch once, persists it in one transaction and reports the changed sessions. Returns
   * false when the database write failed: the state stays in memory, what could not be written is
   * carried into the next commit, and callers should not treat the batch as stored (the HTTP route
   * answers 503 so the hook spools; a drain keeps its file).
   */
  apply(batch: Prepared[]): boolean {
    const hookIds = new Set<string>();
    const entries: TimelineEntry[] = [];
    const infoTouched = new Set<string>();
    for (const item of batch) {
      if (item.hookId !== null) {
        if (hookIds.has(item.hookId)) continue;
        hookIds.add(item.hookId);
      }
      entries.push(...item.entries);
      for (const [id, facts] of item.info) {
        const current = this.info.get(id);
        const reportedPid = facts.reportedPid !== undefined ? facts.reportedPid : (current?.reportedPid ?? null);
        // A check stays valid while the hooks name the same parent process; a new one is checked again.
        const same = current !== undefined && reportedPid === current.reportedPid;
        const next: SessionInfo = {
          cwd: facts.cwd ?? current?.cwd ?? null,
          reportedPid,
          pid: facts.pid !== undefined ? facts.pid : same ? current.pid : reportedPid,
          pidConfidence: facts.pidConfidence !== undefined ? facts.pidConfidence : same ? current.pidConfidence : null,
          pidStartedAt: facts.pidStartedAt !== undefined ? facts.pidStartedAt : same ? current.pidStartedAt : null,
          terminal: facts.terminal ?? current?.terminal ?? null,
          launcher: facts.launcher !== undefined ? facts.launcher : (current?.launcher ?? null),
          firstSeenAt: current?.firstSeenAt ?? facts.firstSeenAt ?? new Date(this.now()).toISOString(),
        };
        if (!current || JSON.stringify(current) !== JSON.stringify(next)) {
          this.info.set(id, next);
          infoTouched.add(id);
        }
      }
    }
    if (entries.length === 0 && hookIds.size === 0) return true;
    const advance = addInputs(this.timeline, entries, this.config.states, this.config.reorderWindowS);
    this.timeline = advance.timeline;
    for (const entry of advance.late) this.log(`late_input seq=${entry.seq} at=${entry.input.at}`);
    for (const { entry, error } of advance.rejected) this.log(`rejected_input seq=${entry.seq} ${error.name}`);

    const receivedAt = new Date(this.now()).toISOString();
    const pending = this.unwritten;
    const upserts: { id: string; json: string }[] = [];
    const quiet = new Set<string>();
    for (const id of new Set([...advance.touched, ...infoTouched, ...pending.sessions])) {
      const snapshot = this.timeline.current[id];
      if (!snapshot) continue;
      const json = JSON.stringify(snapshot);
      if (infoTouched.has(id) || pending.sessions.has(id)) upserts.push({ id, json });
      else if (this.persisted.get(id) !== json) {
        const alive = this.aliveOnly(this.persisted.get(id), snapshot);
        if (alive === "recent") continue;
        if (alive === "stale") quiet.add(id);
        upserts.push({ id, json });
      }
    }
    // A row still waiting to be written whose input was reduced again is void, like a written row of a
    // replayed seq (which the commit deletes); the replay produced its replacement.
    const redone = new Set(advance.replayed);
    const transitions = [...pending.transitions.filter((t) => !redone.has(t.seq)), ...advance.transitions];
    const replayed = [...pending.replayed, ...advance.replayed];
    const hooks = new Map(pending.hookIds);
    for (const id of hookIds) hooks.set(id, receivedAt);
    // A tick that changed nothing writes nothing (head_at alone is refreshed with the next real change).
    if (upserts.length === 0 && transitions.length === 0 && replayed.length === 0 && hooks.size === 0) return true;
    const last = this.timeline.entries.at(-1);
    try {
      this.store.commit({
        upserts: upserts.map(({ id }) => ({ snapshot: this.timeline.current[id]!, info: this.info.get(id) ?? NO_INFO(receivedAt) })),
        transitions,
        replayed,
        hookIds: [...hooks].map(([id, at]) => ({ id, at })),
        headAt: last ? last.input.at : this.timeline.checkpointAt,
      });
    } catch (error) {
      this.log(`store_failed ${(error as Error).name} ${(error as NodeJS.ErrnoException).code ?? ""}`.trim());
      for (const { id } of upserts) pending.sessions.add(id);
      pending.transitions = transitions;
      pending.replayed = replayed;
      pending.hookIds = hooks;
      return false;
    }
    pending.sessions.clear();
    pending.transitions = [];
    pending.replayed = [];
    pending.hookIds = new Map();
    for (const { id, json } of upserts) this.persisted.set(id, json);
    const announced = upserts.filter(({ id }) => !quiet.has(id));
    if (announced.length > 0) this.onChange(announced.map(({ id }) => this.eventOf(this.timeline.current[id]!)));
    this.onCommit({ sessions: [...new Set(transitions.map((t) => t.session))], replayed: replayed.length > 0 });
    return true;
  }

  /**
   * Whether a snapshot differs from its stored copy only by a newer alive report (B3, every 30 s for
   * a running agent). That change is not part of the session's event, so it is never announced, and
   * it is written only once the stored report no longer counts as recent (`liveness_fresh_s`), so the
   * copy a restart loads still serves H3: "recent" skips the write, "stale" writes quietly.
   */
  private aliveOnly(persisted: string | undefined, snapshot: Snapshot): "recent" | "stale" | null {
    if (persisted === undefined || snapshot.last_alive_at === null) return null;
    const stored = JSON.parse(persisted) as Snapshot;
    if (JSON.stringify({ ...stored, last_alive_at: snapshot.last_alive_at }) !== JSON.stringify(snapshot)) return null;
    const fresh = stored.last_alive_at !== null && Date.parse(snapshot.last_alive_at) - Date.parse(stored.last_alive_at) < this.config.states.liveness_fresh_s * 1000;
    return fresh ? "recent" : "stale";
  }
}
