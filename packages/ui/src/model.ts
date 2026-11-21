// What the screen shows, derived from what the daemon already judged: the sessions (standard events)
// and the attention list. Nothing here judges again: long, silent, ready and lost come only from the
// attention list, and missing facts stay missing. Pure: the clock is only used by the formatters.
import type { StandardEvent, State } from "@agent-office/core";
import type * as core from "@agent-office/core";
import type { Away, ControlsState, Ended, FromOlderDaemon, Internal, Long, NeedsYou, NeedsYouSignal, Opened, Ready, Schedule, ScheduledTask } from "@agent-office/core";
import { t } from "./i18n/index.ts";
import { identityFor } from "./identity.ts";
import type { Identity } from "./identity.ts";
import type { Behavior } from "./motion.ts";
import type { SeatNeed } from "./seats.ts";
import { seedUnit } from "./seed.ts";

// The stream's shapes are core's; here is only what an older daemon may leave out.
export type { Away, Ended, Internal, Long, NeedsYou, NeedsYouSignal, Opened, Ready };
/** Older daemons leave out `opened`, `away`, `internal` and `ended`. */
export type Attention = FromOlderDaemon<core.Attention, "opened" | "away" | "internal" | "ended">;
export const NO_ATTENTION: Attention = { needs_you: [], ready: [], long: [], opened: [], away: [], internal: [], ended: [] };
/** The owner's note on a session (a viewer gets no `alert_on_rest`, and the description only at its `full` level); `species`: chosen on the card (older daemons send none). */
export type Note = FromOlderDaemon<core.Note, "alert_on_rest" | "species">;
export type Notes = Record<string, Note>;

/** The scheduled tasks as the daemon read them from the agents' schedulers (`GET /v1/schedule`, the stream's `schedule` event). */
export type { Schedule, ScheduledTask };
export type { ScheduledRun, ScheduledThread, ScheduleSource } from "@agent-office/core";

/** The daemon's lifecycle controls (`controls` stream event, GET /v1/controls): a request, a background service, and the whole state. Older daemons never send it. */
export type { ControlsState };
export type { ControlView as ControlRequest, ServiceView as ServiceState } from "@agent-office/core";
export const NO_CONTROLS: ControlsState = { requests: [], available: {}, start: { agents: [], folders: [] }, services: [] };
export const NO_SCHEDULE: Schedule = { sources: [], tasks: [] };
/** The default of schedule.bench_before_min, in seconds. */
export const DEFAULT_BENCH_BEFORE_S = 3600;
/** The default of schedule.rest_after_min, in seconds. */
export const DEFAULT_REST_AFTER_S = 300;

export type Species = "cat" | "otter" | "bird" | "dog" | "rabbit" | "fox" | "panda" | "hedgehog";
/** Every species the preview art draws: the three first ones, then the cast packs (art-preview/assets-cast). */
export const SPECIES: readonly Species[] = ["otter", "cat", "bird", "dog", "rabbit", "fox", "panda", "hedgehog"];
/** A species by name, in the language shown. */
export const speciesName = (species: Species): string => t().format.species[species];
const drawable = (value: unknown): value is Species => (SPECIES as readonly unknown[]).includes(value);

/** The owner's cast settings (scene.cast and species in config.json). */
export type Cast = { cast: "per-session" | "per-agent" | "per-project"; species: Readonly<Record<string, string>> };
export const DEFAULT_CAST: Cast = { cast: "per-session", species: { "claude-code": "cat", codex: "otter" } };
/** One marker per character, by priority: needs you, "?" (quiet), long, ready (a finished turn), dependency link; a scheduled task on its bench carries its time. */
export type Marker =
  | { kind: "needs"; signal: NeedsYouSignal }
  | { kind: "unknown" }
  | { kind: "long"; since: string }
  | { kind: "ready" }
  | { kind: "link" }
  /** Work handed to other sessions and not yet back; worn while the session rests. */
  | { kind: "delegating"; count: number }
  | { kind: "scheduled"; at: string }
  | null;

export type SessionView = {
  id: string;
  event: StandardEvent;
  identity: Identity;
  species: Species;
  agentName: string;
  /** The name tag: the owner's nickname, else the project folder's name, else the agent's. */
  name: string;
  note: Note | null;
  /** The owner watches this session (a star; listed first). */
  watched: boolean;
  active: boolean;
  needs: NeedsYou | null;
  ready: Ready | null;
  long: Long | null;
  /** Opened and never asked anything since: waits on a bench in the waiting room until its first prompt (or it goes home). */
  opened: Opened | null;
  /** Rested long enough to go home: listed, but not in the office until its next turn. */
  away: Away | null;
  /** The app's own thread: listed, never in the office. */
  internal: Internal | null;
  /** Ended: on the home tab with how it ended. */
  ended: Ended | null;
  marker: Marker;
  /** Background work the session left running while it rests (the event's `background`), 0 otherwise: it stays at its desk and is not finished. */
  subprocesses: number;
  behavior: Behavior;
  seat: SeatNeed;
  faded: boolean;
  /** The scheduled task this figure stands for: a session that is the task's own thread, or a stand-in. */
  task: ScheduledTask | null;
  /** No session: the `event` is a stand-in built from the task, waiting on a bench for the run. */
  standIn: boolean;
  /** A scheduled task's own thread waiting for its next run in the waiting room (after its rest at the desk, or back from home within the bench window). */
  benched: boolean;
};

export const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", openclaw: "OpenClaw", hermes: "Hermes", opencode: "OpenCode", pi: "pi" };
/** The agent, and where it runs when known (as the daemon learnt it from its process): "Claude Code · Claude app". */
export const agentLine = (view: SessionView): string => {
  const launcher = view.event.launcher === undefined ? undefined : t().format.launchers[view.event.launcher];
  return launcher === undefined ? view.agentName : `${view.agentName} · ${launcher}`;
};
/**
 * A session's species: the one chosen on its card, else by the owner's setting — per session from
 * the session id (the same session always looks the same, on every screen and after reconnecting),
 * per project from the project's folder name (every session of a project looks the same; one
 * without a project falls back to its id), or per agent kind from the mapping (kinds not listed, or
 * mapped to a species this screen cannot draw, get `bird`). A chosen species this screen cannot draw is ignored.
 */
export function speciesOf(session: string, agent: string, cast: Cast = DEFAULT_CAST, chosen: string | null = null, project: string | null = null): Species {
  if (drawable(chosen)) return chosen;
  if (cast.cast === "per-agent") {
    const mapped = cast.species[agent];
    return drawable(mapped) ? mapped : "bird";
  }
  const seed = cast.cast === "per-project" && project !== null ? `project:${project}` : session;
  return SPECIES[Math.floor(seedUnit(seed, "species") * SPECIES.length)]!;
}

const WORK: readonly State[] = ["working", "waiting_dependency"];
/**
 * Resting: the turn is over and the session waits for its next prompt, whether or not that turn ended
 * cleanly. `done` and `cancelled` last a few seconds (states.done_hold_s) before `idle`, and nothing
 * produces `paused` yet (controls are post-v1; only a direct report can), so all of them rest as idle does.
 */
const REST: readonly State[] = ["idle", "done", "cancelled", "paused"];

function behaviorOf(state: State): Behavior {
  if (WORK.includes(state)) return "work";
  if (state === "waiting_user" || state === "error") return "wait";
  if (state === "unknown") return "unknown";
  return "rest";
}

/** Working colleagues sit at desks; resting and finished ones go to rest seats; the rest stay where they are; a session only opened, or one gone quiet, waits on a bench. */
function seatNeedOf(state: State, opened: boolean): SeatNeed {
  if (opened || state === "unknown") return "wait";
  if (WORK.includes(state)) return "work";
  return REST.includes(state) ? "rest" : "stay";
}

/**
 * A subagent's name: what its agent calls it. A Codex worker or reviewer thread has a nickname (its
 * `title`, read from Codex's files) and a role (`child_type`): "Tesla · worker"; a Claude Code
 * subagent has only its kind: "Explore helper". Null for a top-level session or a child without either.
 */
export function childName(event: StandardEvent): string | null {
  if (event.parent === null) return null;
  const kind = event.child_type ?? null;
  if (event.title !== undefined) return kind === null ? event.title : `${event.title} · ${kind}`;
  return kind === null ? null : t().format.helper(kind);
}

/** The rows with each session's children right after it (in their own order); a child whose parent is not among them stays where it is. */
export function withChildrenUnderParents(views: readonly SessionView[]): SessionView[] {
  const ids = new Set(views.map((view) => view.id));
  const placed = new Set<string>();
  const out: SessionView[] = [];
  for (const view of views) {
    if (placed.has(view.id)) continue;
    if (view.event.parent !== null && ids.has(view.event.parent)) continue;
    out.push(view);
    placed.add(view.id);
    for (const child of views) {
      if (child.event.parent !== view.id || placed.has(child.id)) continue;
      out.push(child);
      placed.add(child.id);
    }
  }
  return out;
}

/**
 * `task`: the scheduled task whose own thread this session is; its needs-you entry (under the task's key)
 * and its next time are the session's. Such a thread waits for its next run in the waiting room: after a
 * run it rests at its desk for `restAfterS` (so a short run is still seen there), then sits on a bench
 * until the daemon sends it home; it stays, or comes back from home, while the next run is within
 * `benchBeforeS` (the owner's decision of 2026-11-01).
 */
export function viewOf(event: StandardEvent, attention: Attention, note: Note | null = null, cast: Cast = DEFAULT_CAST, task: ScheduledTask | null = null, nowMs = Date.now(), benchBeforeS = DEFAULT_BENCH_BEFORE_S, restAfterS = DEFAULT_REST_AFTER_S): SessionView {
  const needs = attention.needs_you.find((entry) => entry.session === event.session || (task !== null && entry.session === task.key)) ?? null;
  const ready = attention.ready.find((entry) => entry.session === event.session) ?? null;
  const long = attention.long.find((entry) => entry.session === event.session) ?? null;
  const opened = (attention.opened ?? []).find((entry) => entry.session === event.session) ?? null;
  let away = (attention.away ?? []).find((entry) => entry.session === event.session) ?? null;
  const internal = (attention.internal ?? []).find((entry) => entry.session === event.session) ?? null;
  const ended = (attention.ended ?? []).find((entry) => entry.session === event.session) ?? null;
  const state = event.state;
  let benched = false;
  if (task !== null && task.thread?.session === event.session && task.status === "active" && event.parent === null && REST.includes(state) && opened === null) {
    if (away !== null) {
      // Gone home after its rest: back on a bench once the next run is within the window.
      if (onBench(task, nowMs, benchBeforeS)) {
        away = null;
        benched = true;
      }
    } else {
      // The rest at the desk counts from the end of the turn (the daemon's `since`, else the event's time).
      const restedSince = Date.parse(ready?.since ?? event.result?.at ?? event.ts);
      benched = !Number.isFinite(restedSince) || nowMs - restedSince >= restAfterS * 1000;
    }
  }
  const subprocesses = REST.includes(state) ? (event.background ?? 0) : 0;
  let marker: Marker = null;
  if (needs !== null) marker = { kind: "needs", signal: needs.signal };
  else if (state === "unknown") marker = { kind: "unknown" };
  else if (long !== null) marker = { kind: "long", since: long.since };
  // On the bench for its next run, the thread wears its time rather than the finished turn's tick.
  else if (benched && task !== null && task.next_run_at !== null) marker = { kind: "scheduled", at: task.next_run_at };
  // Resting with work handed to other sessions still out: the delegation shows, not the finished turn.
  else if ((event.delegations?.open.length ?? 0) > 0 && REST.includes(state)) marker = { kind: "delegating", count: event.delegations!.open.length };
  // A turn that just ended is `done` for a few seconds before the daemon lists it as ready; with background
  // work still running it is not finished, so it wears no tick.
  else if (subprocesses === 0 && (ready !== null || state === "done")) marker = { kind: "ready" };
  else if (state === "waiting_dependency") marker = { kind: "link" };
  // The task's thread at rest wears its next time.
  else if (task !== null && task.status === "active" && task.next_run_at !== null && REST.includes(state)) marker = { kind: "scheduled", at: task.next_run_at };
  const agentName = AGENT_NAMES[event.agent] ?? event.agent;
  return {
    id: event.session,
    event,
    identity: identityFor(event.session),
    species: speciesOf(event.session, event.agent, cast, note?.species ?? null, event.project),
    agentName,
    // The owner's name, else the title the agent's own app shows, else the folder.
    name: note?.nickname ?? childName(event) ?? event.title ?? event.project ?? agentName,
    note,
    watched: note?.watched === true,
    active: event.lifecycle === "active",
    needs,
    ready,
    long,
    opened,
    away,
    internal,
    ended,
    marker,
    subprocesses,
    behavior: subprocesses > 0 ? "work" : behaviorOf(state),
    seat: benched ? "wait" : subprocesses > 0 ? "work" : seatNeedOf(state, opened !== null),
    faded: state === "unknown",
    task,
    standIn: false,
    benched,
  };
}

/**
 * Whether a scheduled task sits on a bench now: an active task whose next run is within
 * `benchBeforeS` (or already due), or whose last occurrence was missed or could not be watched.
 * A paused task, or one further off, is not in the office or its lists.
 */
export function onBench(task: ScheduledTask, nowMs: number, benchBeforeS: number): boolean {
  if (task.status !== "active") return false;
  if (task.missed !== null || task.unsure !== null) return true;
  if (task.next_run_at === null) return task.rule?.kind === "cron" && task.can_confirm_run === false;
  return Date.parse(task.next_run_at) - nowMs <= benchBeforeS * 1000;
}

/** A scheduled task as a bench sitter: a stand-in event (its thread is not in the office), faded, waiting for its run; a missed one carries the needs-you marker. */
export function taskViewOf(task: ScheduledTask, attention: Attention, cast: Cast = DEFAULT_CAST): SessionView {
  const event: StandardEvent = { schema_version: 1, agent: task.agent, session: task.key, parent: null, project: task.project, cwd: task.cwd, state: "idle", lifecycle: "active", waiting_on: null, result: null, detail: null, origin: "scheduled", ts: task.observed_at, ...(task.name !== null ? { title: task.name } : {}) };
  const needs = attention.needs_you.find((entry) => entry.session === task.key) ?? null;
  const agentName = AGENT_NAMES[task.agent] ?? task.agent;
  const marker: Marker = needs !== null ? { kind: "needs", signal: needs.signal } : task.next_run_at !== null ? { kind: "scheduled", at: task.next_run_at } : null;
  return {
    id: task.key,
    event,
    identity: identityFor(task.key),
    species: speciesOf(task.key, task.agent, cast, null, task.project),
    agentName,
    name: task.name ?? task.project ?? agentName,
    note: null,
    watched: false,
    active: true,
    needs,
    ready: null,
    long: null,
    opened: null,
    away: null,
    internal: null,
    ended: null,
    marker,
    subprocesses: 0,
    behavior: "rest",
    seat: "wait",
    faded: true,
    task,
    standIn: true,
    benched: false,
  };
}

export type Office = {
  /** Every known session in a stable order (first seen), active and recently ended. */
  all: SessionView[];
  /** Active sessions, every kind (the All tab is `allTab` in lists.ts). */
  present: SessionView[];
  /** Active sessions in the office: all but those gone home after a long rest (back with their next turn) and the apps' own threads. A session only opened waits in the waiting room. */
  inOffice: SessionView[];
  needsYou: SessionView[];
  /** Active sessions in a turn, and resting ones, in the fixed order of `present`. */
  working: SessionView[];
  resting: SessionView[];
  /** In the waiting room, in the fixed order of `present`: only opened, gone quiet, a scheduled task's stand-in, a scheduled thread between runs. */
  waiting: SessionView[];
  /** Gone home: sessions away after a long rest and ended ones (sent home, ended by their agent, lost), latest first. */
  home: SessionView[];
  /** `waiting`: in the waiting room — only opened, gone quiet, or a scheduled task on its bench. */
  counts: { needsYou: number; working: number; resting: number; waiting: number; long: number; home: number };
};

/** Whether a view is in the office (not gone home, not the app's own thread). */
const inOfficeNow = (view: SessionView): boolean => view.active && view.away === null && view.internal === null;

/**
 * `order` is the order sessions were first seen; sessions missing from it go last, in map order.
 * A session that is a task's own thread carries the task (one figure for the two). Scheduled tasks
 * on their bench (`onBench` at `nowMs`) whose thread is not in the office come after the sessions,
 * as stand-ins, by their next run.
 */
export function officeOf(sessions: ReadonlyMap<string, StandardEvent>, order: readonly string[], attention: Attention, notes: Notes = {}, cast: Cast = DEFAULT_CAST, schedule: Schedule = NO_SCHEDULE, benchBeforeS = DEFAULT_BENCH_BEFORE_S, nowMs = Date.now(), restAfterS = DEFAULT_REST_AFTER_S): Office {
  const ids = [...order.filter((id) => sessions.has(id)), ...[...sessions.keys()].filter((id) => !order.includes(id))];
  // A task's permanent thread carries it; otherwise its exact latest run may carry it
  // while that session is still in the office. Run sessions keep their ordinary lifecycle.
  const candidateSession = (task: ScheduledTask): string | null => {
    const id = task.thread?.session ?? (task.run?.linked ? task.run.session : null);
    return id !== null && sessions.get(id)?.agent === task.agent ? id : null;
  };
  const candidateCounts = new Map<string, number>();
  for (const task of schedule.tasks) {
    const id = candidateSession(task);
    if (id !== null) candidateCounts.set(id, (candidateCounts.get(id) ?? 0) + 1);
  }
  const sessionOfTask = (task: ScheduledTask): string | null => {
    const id = candidateSession(task);
    return id !== null && candidateCounts.get(id) === 1 ? id : null;
  };
  const taskOfThread = new Map(schedule.tasks.flatMap((task) => {
    const id = sessionOfTask(task);
    return id === null ? [] : [[id, task] as const];
  }));
  const views = new Map(ids.map((id) => [id, viewOf(sessions.get(id)!, attention, Object.hasOwn(notes, id) ? notes[id]! : null, cast, taskOfThread.get(id) ?? null, nowMs, benchBeforeS, restAfterS)]));
  // The task's key resolves to the session that carries it, for the attention lists.
  const carrier = new Map<string, string>();
  for (const task of schedule.tasks) {
    const id = sessionOfTask(task);
    const thread = id === null ? undefined : views.get(id);
    if (thread !== undefined && thread.event.agent === task.agent && inOfficeNow(thread)) carrier.set(task.key, thread.id);
    else if (onBench(task, nowMs, benchBeforeS) && !views.has(task.key)) views.set(task.key, taskViewOf(task, attention, cast));
  }
  const all = [...views.values()];
  // The attention list's own order (docs/notifications.md, queue tab); an entry without a known session is
  // left out of the rows but still counted, so the count never claims less than the daemon says.
  const pick = (entries: readonly { session: string }[]) => entries.map((entry) => views.get(carrier.get(entry.session) ?? entry.session)).filter((view): view is SessionView => view !== undefined);
  const present = all.filter((view) => view.active);
  const inOffice = present.filter(inOfficeNow);
  const working = inOffice.filter((view) => WORK.includes(view.event.state));
  // A session only opened stands in the office but is not resting from a turn: it is on the All tab only.
  const resting = inOffice.filter((view) => REST.includes(view.event.state) && view.opened === null && !view.standIn && !view.benched);
  // In the waiting room: not yet in (only opened), out of touch (quiet), a scheduled task's stand-in before its run, or a task's thread waiting for its next run; counted apart from working and resting.
  const waitingRoom = inOffice.filter((view) => view.opened !== null || view.event.state === "unknown" || view.standIn || view.benched);
  const home = all
    .filter((view) => (view.active ? view.away !== null : view.ended !== null) && view.event.parent === null && view.internal === null)
    .sort((a, b) => leftAt(b).localeCompare(leftAt(a)));
  return {
    all,
    present,
    inOffice,
    needsYou: pick(attention.needs_you),
    working,
    resting,
    waiting: waitingRoom,
    home,
    counts: { needsYou: attention.needs_you.length, working: working.length, resting: resting.length, waiting: waitingRoom.length, long: attention.long.length, home: home.length },
  };
}

/** When a home-tab session left: the end, the start of its rest, else its last event. */
export const leftAt = (view: SessionView): string => view.ended?.since ?? view.away?.since ?? view.event.ts;

/** States the owner can send a session home from (the daemon's rule G2): all but a turn at work. */
const SEND_HOME: readonly State[] = ["idle", "done", "cancelled", "error", "paused", "unknown", "waiting_user"];
export const canSendHome = (view: SessionView): boolean => view.active && !view.standIn && view.event.parent === null && SEND_HOME.includes(view.event.state);
