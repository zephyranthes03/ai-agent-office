// Copy-on-write working set for one reduction plus the helpers shared by the rule phases
// (phase I; rule ids are named in rules.ts). Input snapshots are never mutated: a snapshot is
// cloned the first time a rule edits it, and the result map is a fresh object.
import type { StatesConfig } from "./config.ts";
import { addSeconds, toMs } from "./time.ts";
import type { ActiveTool, Snapshot, Snapshots, State, TraceEntry } from "./types.ts";

export type Ctx = {
  /** Null-prototype map: session ids such as "constructor" or "__proto__" are plain keys. */
  out: Snapshots;
  cloned: Set<string>;
  /** Sessions that entered waiting_user during this input, even if they were waiting before it (A5 then D1–D5). */
  waitEntered: Set<string>;
  trace: TraceEntry[];
  config: StatesConfig;
  at: string;
};

/** A map whose keys cannot collide with Object.prototype names. */
export function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function createCtx(snapshots: Snapshots, config: StatesConfig, at: string): Ctx {
  toMs(at); // every input time must parse with an offset before it is written into any snapshot
  const out = emptyMap<Snapshot>();
  for (const [id, snapshot] of Object.entries(snapshots)) out[id] = snapshot;
  return { out, cloned: new Set(), waitEntered: new Set(), trace: [], config, at };
}

export function record(ctx: Ctx, rule: string, session: string | null): void {
  ctx.trace.push({ rule, session });
}

export function has(ctx: Ctx, id: string): boolean {
  return Object.hasOwn(ctx.out, id);
}

export function get(ctx: Ctx, id: string): Snapshot | undefined {
  return Object.hasOwn(ctx.out, id) ? ctx.out[id] : undefined;
}

/** The editable copy of a snapshot; cloned once per reduction. */
export function edit(ctx: Ctx, id: string): Snapshot {
  const current = get(ctx, id);
  if (!current) throw new Error(`no snapshot for session ${id}`);
  if (ctx.cloned.has(id)) return current;
  const copy = cloneSnapshot(current);
  ctx.out[id] = copy;
  ctx.cloned.add(id);
  return copy;
}

export function put(ctx: Ctx, snapshot: Snapshot): Snapshot {
  ctx.out[snapshot.session] = snapshot;
  ctx.cloned.add(snapshot.session);
  return snapshot;
}

export function cloneSnapshot(s: Snapshot): Snapshot {
  const tools = emptyMap<ActiveTool>();
  for (const [id, tool] of Object.entries(s.active_tools)) tools[id] = { ...tool };
  return {
    ...s,
    waiting_on: s.waiting_on ? { ...s.waiting_on } : null,
    result: s.result ? { ...s.result } : null,
    active_tools: tools,
    finished_tool_ids: [...s.finished_tool_ids],
    pending_approval: s.pending_approval ? { ...s.pending_approval } : null,
    children: [...s.children],
    delegations: { open: s.delegations.open.map((item) => ({ ...item })), returned: s.delegations.returned },
  };
}

/** A1 default: idle, active, nothing known. */
export function defaultSnapshot(session: string, agent: string, at: string): Snapshot {
  return {
    session,
    agent,
    parent: null,
    child_type: null,
    lifecycle: "active",
    state: "idle",
    state_before_unknown: null,
    waiting_on: null,
    detail: null,
    result: null,
    origin: "unknown",
    active_tools: emptyMap<ActiveTool>(),
    finished_tool_ids: [],
    pending_approval: null,
    children: [],
    delegations: { open: [], returned: 0 },
    background: 0,
    work_since: null,
    stale_after_s: null,
    last_signal_at: at,
    last_alive_at: null,
    state_since: at,
    waiting_since: null,
    hold_until: null,
  };
}

export function getTool(tools: Record<string, ActiveTool>, id: string): ActiveTool | undefined {
  return Object.hasOwn(tools, id) ? tools[id] : undefined;
}

/** I2: `state_since` moves whenever the state changes. Leaving `unknown` forgets the restore point. */
export function setState(ctx: Ctx, snap: Snapshot, state: State): void {
  if (snap.state !== state) {
    snap.state = state;
    snap.state_since = ctx.at;
    if (state === "waiting_user") ctx.waitEntered.add(snap.session);
    record(ctx, "I2", snap.session);
  }
  if (state !== "unknown") snap.state_before_unknown = null;
}

/**
 * I2 for user waits, run once after every input over the snapshots it touched: `waiting_since`
 * starts when a session enters `waiting_user` or its `waiting_on.reason` changes there, and is
 * null outside `waiting_user`. H6 measures from it.
 */
export function stampWaits(ctx: Ctx, before: Snapshots): void {
  for (const id of ctx.cloned) {
    const snap = ctx.out[id];
    if (!snap) continue;
    if (snap.state !== "waiting_user") {
      snap.waiting_since = null;
      continue;
    }
    const prior = Object.hasOwn(before, id) ? before[id] : undefined;
    const sameWait = !ctx.waitEntered.has(id) && prior !== undefined && prior.state === "waiting_user" && prior.waiting_on?.reason === snap.waiting_on?.reason && snap.waiting_since != null;
    if (!sameWait) snap.waiting_since = ctx.at;
  }
}

/** I3 */
export function clearTurn(snap: Snapshot): void {
  snap.active_tools = emptyMap<ActiveTool>();
  snap.finished_tool_ids = [];
  snap.pending_approval = null;
  snap.waiting_on = null;
  snap.detail = null;
  snap.hold_until = null;
}

/** A tool id leaves `active_tools` and joins `finished_tool_ids` once (A3 keys on it). */
export function retireTool(snap: Snapshot, id: string): void {
  delete snap.active_tools[id];
  if (!snap.finished_tool_ids.includes(id)) snap.finished_tool_ids.push(id);
}

export function holdUntil(ctx: Ctx, state: "done" | "cancelled"): string {
  return addSeconds(ctx.at, state === "done" ? ctx.config.done_hold_s : ctx.config.cancelled_hold_s);
}

export type ActiveToolEntry = ActiveTool & { id: string };

/** I4: most recently started by `started_at`, ties by insertion order (the later entry wins). */
export function mostRecentTool(tools: Record<string, ActiveTool>, filter?: (tool: ActiveToolEntry) => boolean): ActiveToolEntry | null {
  let best: ActiveToolEntry | null = null;
  for (const [id, tool] of Object.entries(tools)) {
    const entry = { id, ...tool };
    if (filter && !filter(entry)) continue;
    if (!best || toMs(entry.started_at) >= toMs(best.started_at)) best = entry;
  }
  return best;
}

export function activeChildren(ctx: Ctx, snap: Snapshot): Snapshot[] {
  const out: Snapshot[] = [];
  for (const id of snap.children) {
    const child = get(ctx, id);
    if (child && child.lifecycle === "active") out.push(child);
  }
  return out;
}

/** The most recently attached active child that has a type (used as the waiting target). */
export function mostRecentActiveChild(ctx: Ctx, snap: Snapshot): Snapshot | null {
  const typed = activeChildren(ctx, snap).filter((child) => child.child_type !== null);
  return typed.length > 0 ? typed[typed.length - 1]! : null;
}

/** An active direct child of the session waits for the user (H2/H3 leave such a parent alone). */
export function hasWaitingChild(ctx: Ctx, snap: Snapshot): boolean {
  return activeChildren(ctx, snap).some((child) => child.state === "waiting_user");
}

/** `candidate` is `id` itself or one of its ancestors through `parent` links (cycle guard for B5/E3). */
export function isSelfOrAncestor(ctx: Ctx, id: string, candidate: string): boolean {
  const seen = new Set<string>();
  let current: string | null = id;
  while (current !== null && !seen.has(current)) {
    if (current === candidate) return true;
    seen.add(current);
    current = get(ctx, current)?.parent ?? null;
  }
  return false;
}

const DEPENDENCY_CLASSES = new Set(["dependency", "dependency_tool"]);

/**
 * E5: the parent rule, judged by the session's own work. `byToolStart` says the trigger was a
 * `tool_started` on this session, which is the only trigger that may move a resting session.
 */
export function settle(ctx: Ctx, snap: Snapshot, byToolStart: boolean): void {
  record(ctx, "E5", snap.session);
  if (snap.state === "waiting_user" || snap.state === "error") return;
  if (!byToolStart && (snap.state === "idle" || snap.state === "done" || snap.state === "cancelled" || snap.state === "paused" || snap.state === "unknown")) return;
  if (snap.state === "done" || snap.state === "cancelled") snap.hold_until = null;
  const tools = Object.values(snap.active_tools);
  if (tools.length > 0 && tools.every((tool) => DEPENDENCY_CLASSES.has(tool.class))) {
    const reason = tools.some((tool) => tool.class === "dependency") ? "child" : "tool";
    // E5.3: a child's type names the target only when the session waits on children.
    const child = reason === "child" ? mostRecentActiveChild(ctx, snap) : null;
    const target = child ? child.child_type : (mostRecentTool(snap.active_tools)?.detail ?? null);
    setState(ctx, snap, "waiting_dependency");
    snap.waiting_on = { reason, target };
    return;
  }
  setState(ctx, snap, "working");
  snap.waiting_on = null;
}

/**
 * Shared by B1 (children only), B2, B3 and H4: the session keeps its state, its children end with
 * it, and when `detach` is set it leaves its parent's `children` and the parent is settled again.
 */
export function endSession(ctx: Ctx, id: string, detach: boolean, visited: Set<string> = new Set()): void {
  if (visited.has(id)) return;
  visited.add(id);
  const snap = edit(ctx, id);
  snap.lifecycle = "ended";
  // Its background work ended with it; a later signal (A2) starts from nothing running.
  snap.background = 0;
  for (const child of snap.children) if (has(ctx, child)) endSession(ctx, child, false, visited);
  if (detach && snap.parent !== null && has(ctx, snap.parent)) {
    const parent = edit(ctx, snap.parent);
    parent.children = parent.children.filter((child) => child !== id);
    settle(ctx, parent, false);
  }
}
