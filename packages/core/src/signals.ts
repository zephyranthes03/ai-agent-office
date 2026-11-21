// Phases A–G for one signal (rule ids are named in rules.ts). Ticks, liveness and adapter status
// are in ticks.ts.
import type { Ctx } from "./store.ts";
import { activeChildren, clearTurn, defaultSnapshot, edit, endSession, get, getTool, has, holdUntil, isSelfOrAncestor, mostRecentTool, put, record, retireTool, setState, settle } from "./store.ts";
import type { Outcome, Signal, Snapshot } from "./types.ts";

/**
 * A1 for a child routed by an adapter: created working under its parent, origin inherited. Under
 * an ended parent the child is created ended too: the parent's end already ended its children.
 */
function createChild(ctx: Ctx, id: string, parentId: string, childType: string | null, agent: string): Snapshot {
  if (!has(ctx, parentId)) {
    put(ctx, defaultSnapshot(parentId, agent, ctx.at));
    record(ctx, "A1", parentId);
  }
  const parent = edit(ctx, parentId);
  const child = defaultSnapshot(id, parent.agent, ctx.at);
  child.parent = parentId;
  child.child_type = childType;
  child.state = "working";
  child.origin = parent.origin;
  if (parent.lifecycle === "ended") child.lifecycle = "ended";
  if (!parent.children.includes(id)) parent.children.push(id);
  return put(ctx, child);
}

/**
 * A5 exceptions: the signals that keep a `waiting_user` session waiting. `child_started` and
 * `child_stopped` are the session's view of its children (a background subagent starting or
 * finishing), not an answer to its own prompt.
 */
function keepsWaiting(sig: Signal, snap: Snapshot): boolean {
  switch (sig.name) {
    case "approval_requested":
    case "input_requested":
    case "parent_linked":
    case "session_ended":
    case "child_started":
    case "child_stopped":
      return true;
    case "tool_started": {
      if (snap.pending_approval?.tool_use_id === sig.tool_use_id) return true;
      const waiting = getTool(snap.active_tools, sig.tool_use_id);
      return waiting !== undefined && (waiting.class === "input" || waiting.class === "approval");
    }
    default:
      return false;
  }
}

function endTurn(ctx: Ctx, snap: Snapshot, state: "done" | "error" | "cancelled", outcome: Outcome): void {
  clearTurn(snap);
  setState(ctx, snap, state);
  snap.result = { outcome, at: ctx.at };
  if (state !== "error") snap.hold_until = holdUntil(ctx, state);
}

/** B5/E3: attach `childId` under `parentId` unless that would make a session its own ancestor. */
function attachChild(ctx: Ctx, parent: Snapshot, childId: string): boolean {
  if (isSelfOrAncestor(ctx, parent.session, childId)) return false;
  if (!parent.children.includes(childId)) parent.children.push(childId);
  return true;
}

/**
 * B5 and F1: attach the session under `parentId` (created per A1 if needed), leaving a previous
 * parent, inheriting an unknown origin, and settling the parent. The session takes the parent's
 * lifecycle, as A1 and A2 do for routed children: under an ended parent it is ended, under an
 * active one it is active. Ignored when it would make a cycle.
 */
function linkParent(ctx: Ctx, snap: Snapshot, parentId: string, childType: string | null): void {
  if (!has(ctx, parentId)) {
    put(ctx, defaultSnapshot(parentId, snap.agent, ctx.at));
    record(ctx, "A1", parentId);
  }
  const parent = edit(ctx, parentId);
  if (!attachChild(ctx, parent, snap.session)) return;
  if (snap.parent !== null && snap.parent !== parentId && has(ctx, snap.parent)) {
    const previous = edit(ctx, snap.parent);
    previous.children = previous.children.filter((child) => child !== snap.session);
    settle(ctx, previous, false);
  }
  snap.parent = parentId;
  snap.lifecycle = parent.lifecycle;
  if (childType != null) snap.child_type = childType;
  if (snap.origin === "unknown") snap.origin = parent.origin;
  settle(ctx, parent, false);
}

export function applySignal(ctx: Ctx, sig: Signal): void {
  const id = sig.session;
  // A1 exception: a stop for a child never seen or already ended is dropped before anything else
  // can react, so it neither reactivates the parent (A2) nor refreshes it (I1).
  if (sig.name === "child_stopped") {
    const child = get(ctx, sig.child);
    if (!child || child.lifecycle === "ended") {
      record(ctx, "A1", id);
      return;
    }
  }
  // A3: a late start for a finished tool id is dropped, whatever its class.
  const existing = get(ctx, id);
  if (existing && sig.name === "tool_started" && existing.finished_tool_ids.includes(sig.tool_use_id)) {
    record(ctx, "A3", id);
    return;
  }
  // A1: first sight creates the session (or the child under its parent).
  if (!existing) {
    if (sig.child_of) createChild(ctx, id, sig.child_of, sig.child_type ?? null, sig.agent);
    else put(ctx, defaultSnapshot(id, sig.agent, ctx.at));
    record(ctx, "A1", id);
  }
  const snap = edit(ctx, id);
  // A2: a signal reactivates an ended session and puts a child back under its parent. A child
  // whose parent has ended stays ended (the signal still applies, for the history).
  if (snap.lifecycle === "ended") {
    record(ctx, "A2", id);
    const parent = snap.parent !== null ? get(ctx, snap.parent) : undefined;
    if (!parent) snap.lifecycle = "active";
    else if (parent.lifecycle === "active") {
      snap.lifecycle = "active";
      attachChild(ctx, edit(ctx, parent.session), id);
    }
  }
  // A4: recover from unknown, then apply the signal.
  if (snap.state === "unknown") {
    record(ctx, "A4", id);
    setState(ctx, snap, snap.state_before_unknown ?? "idle");
  }
  // A5: release waiting_user before the signal is applied.
  if (snap.state === "waiting_user" && !keepsWaiting(sig, snap)) {
    record(ctx, "A5", id);
    snap.waiting_on = null;
    const pendingId = snap.pending_approval?.tool_use_id ?? null;
    if (pendingId !== null) retireTool(snap, pendingId);
    snap.pending_approval = null;
    setState(ctx, snap, "working");
    snap.detail = mostRecentTool(snap.active_tools)?.detail ?? null;
  }
  applyPhasesBtoG(ctx, snap, sig);
  // I1: the signal refreshes its session and, through `parent`, the parent too.
  snap.last_signal_at = ctx.at;
  if (snap.parent !== null && has(ctx, snap.parent)) edit(ctx, snap.parent).last_signal_at = ctx.at;
  record(ctx, "I1", id);
}

function applyPhasesBtoG(ctx: Ctx, snap: Snapshot, sig: Signal): void {
  const id = snap.session;
  switch (sig.name) {
    // Phase B — lifecycle
    case "session_started": {
      record(ctx, "B1", id);
      snap.lifecycle = "active";
      setState(ctx, snap, "idle");
      clearTurn(snap);
      for (const child of snap.children) if (has(ctx, child)) endSession(ctx, child, false);
      snap.children = [];
      // A new process: the background work of the old one is not its own.
      snap.background = 0;
      snap.work_since = null;
      if (sig.origin !== null) snap.origin = sig.origin;
      if (!sig.resumed) snap.result = null;
      return;
    }
    case "session_ended":
      record(ctx, "B2", id);
      endSession(ctx, id, true);
      return;
    case "parent_linked":
      record(ctx, "B5", id);
      linkParent(ctx, snap, sig.parent, sig.child_type);
      return;
    // Phase C — turn boundaries
    case "prompt_submitted":
      record(ctx, "C1", id);
      // A prompt while background work still runs (often that work waking the session) goes on with the
      // same work, which began at an earlier prompt; otherwise the work begins here.
      if (snap.background === 0 || snap.work_since === null) snap.work_since = ctx.at;
      setState(ctx, snap, "working");
      clearTurn(snap);
      if (sig.origin !== null && snap.origin === "unknown") snap.origin = sig.origin;
      // Another task's result coming back closes the oldest delegation still open (the record names no start to match).
      if (sig.returned && snap.delegations.open.length > 0) {
        record(ctx, "E8", id);
        snap.delegations.open.shift();
        snap.delegations.returned += 1;
      }
      return;
    case "turn_ended":
      // The agent lists the background work still running at the end of every turn (C2, C3).
      if (sig.background != null) snap.background = sig.background;
      if (sig.ok) {
        record(ctx, "C2", id);
        endTurn(ctx, snap, "done", "completed");
      } else {
        record(ctx, "C3", id);
        endTurn(ctx, snap, "error", "failed");
        // C6: a child's failed turn is its parent's to handle (the subagent's result tells it), and
        // nothing can open the child, so it ends here instead of waiting for the owner.
        if (snap.parent !== null) {
          record(ctx, "C6", id);
          endSession(ctx, id, true);
        }
      }
      return;
    case "turn_interrupted":
      record(ctx, "C4", id);
      endTurn(ctx, snap, "cancelled", "interrupted");
      return;
    case "idle_hint":
      record(ctx, "C5", id);
      if (snap.state === "working" || snap.state === "waiting_dependency") {
        setState(ctx, snap, "idle");
        clearTurn(snap);
      }
      return;
    // Phase D — waiting for the user
    case "approval_requested": {
      record(ctx, "D1", id);
      if (sig.tool === null && activeChildren(ctx, snap).some((child) => child.state === "waiting_user")) return;
      const byName = sig.tool === null ? null : mostRecentTool(snap.active_tools, (tool) => tool.tool === sig.tool);
      const toolUseId = sig.tool_use_id ?? byName?.id ?? snap.pending_approval?.tool_use_id ?? null;
      const target = sig.detail ?? snap.pending_approval?.detail ?? mostRecentTool(snap.active_tools)?.detail ?? null;
      setState(ctx, snap, "waiting_user");
      snap.waiting_on = { reason: "approval", target };
      snap.pending_approval = { tool_use_id: toolUseId, detail: target };
      return;
    }
    case "approval_reviewed":
      // D6: the agent's own reviewer answers this request, so the session keeps working; the tool
      // line names the command under review, as it does for a running tool.
      record(ctx, "D6", id);
      if (snap.state === "working" && sig.detail !== null) snap.detail = sig.detail;
      return;
    case "input_requested":
      record(ctx, "D2", id);
      setState(ctx, snap, "waiting_user");
      snap.waiting_on = { reason: "input", target: sig.target };
      return;
    case "input_resolved":
      record(ctx, "D3", id);
      return;
    case "tool_started": {
      snap.active_tools[sig.tool_use_id] = { tool: sig.tool, detail: sig.detail, class: sig.class, started_at: ctx.at };
      snap.detail = sig.detail;
      if (sig.class === "input") {
        record(ctx, "D4", id);
        setState(ctx, snap, "waiting_user");
        snap.waiting_on = { reason: "input", target: sig.detail };
      } else if (sig.class === "approval") {
        record(ctx, "D5", id);
        setState(ctx, snap, "waiting_user");
        snap.waiting_on = { reason: "approval", target: sig.detail };
        snap.pending_approval = { tool_use_id: sig.tool_use_id, detail: sig.detail };
      } else {
        record(ctx, "E1", id);
        settle(ctx, snap, true);
        if (sig.class === "delegation" && !snap.delegations.open.some((item) => item.tool_use_id === sig.tool_use_id)) {
          record(ctx, "E6", id);
          snap.delegations.open.push({ tool_use_id: sig.tool_use_id, target: sig.meta?.target ?? null, initiation: sig.meta?.initiation ?? null, started_at: ctx.at });
        }
      }
      return;
    }
    // Phase E — tools and children
    case "tool_finished":
      record(ctx, "E2", id);
      // A delegation tool that failed handed nothing over.
      if (!sig.ok && snap.delegations.open.some((item) => item.tool_use_id === sig.tool_use_id)) {
        record(ctx, "E7", id);
        snap.delegations.open = snap.delegations.open.filter((item) => item.tool_use_id !== sig.tool_use_id);
      }
      retireTool(snap, sig.tool_use_id);
      snap.detail = mostRecentTool(snap.active_tools)?.detail ?? null;
      settle(ctx, snap, false);
      return;
    case "child_started": {
      record(ctx, "E3", id);
      if (!has(ctx, sig.child)) createChild(ctx, sig.child, id, sig.type, snap.agent);
      else if (attachChild(ctx, snap, sig.child)) {
        const child = edit(ctx, sig.child);
        child.lifecycle = "active";
        child.parent = id;
        if (sig.type != null) child.child_type = sig.type;
        clearTurn(child);
        setState(ctx, child, "working");
        if (child.origin === "unknown") child.origin = snap.origin;
      }
      settle(ctx, snap, false);
      return;
    }
    case "child_stopped": {
      record(ctx, "E4", id);
      // A subagent's stop lists the whole session's background work, as the session's own stop does.
      if (sig.background != null) snap.background = sig.background;
      const child = edit(ctx, sig.child);
      clearTurn(child);
      setState(ctx, child, "done");
      child.result = { outcome: "completed", at: ctx.at };
      child.hold_until = holdUntil(ctx, "done");
      child.lifecycle = "ended";
      snap.children = snap.children.filter((c) => c !== sig.child);
      settle(ctx, snap, false);
      return;
    }
    // Phase F — direct reports
    case "state_reported":
      record(ctx, "F1", id);
      setState(ctx, snap, sig.state);
      snap.waiting_on = sig.waiting_on ? { ...sig.waiting_on } : null;
      snap.detail = sig.detail;
      snap.result = sig.result ? { outcome: sig.result.outcome, at: sig.result.at ?? ctx.at } : null;
      snap.stale_after_s = sig.ttl_s;
      snap.hold_until = sig.state === "done" || sig.state === "cancelled" ? holdUntil(ctx, sig.state) : null;
      // The report's origin fills an unknown one, its parent attaches it (as B5), and
      // lifecycle ended ends it (as B2: children end, it leaves its parent).
      if (sig.origin !== null && snap.origin === "unknown") snap.origin = sig.origin;
      if (sig.parent !== null) linkParent(ctx, snap, sig.parent, null);
      if (sig.lifecycle === "ended") endSession(ctx, id, true);
      return;
    // Phase G — controls
    case "control_confirmed":
      record(ctx, "G1", id);
      switch (sig.control) {
        case "pause":
          setState(ctx, snap, "paused");
          return;
        case "resume":
          setState(ctx, snap, "working");
          settle(ctx, snap, false);
          return;
        case "cancel":
          endTurn(ctx, snap, "cancelled", "cancelled");
          return;
        case "interrupt_turn":
          endTurn(ctx, snap, "cancelled", "interrupted");
          return;
        case "rerun":
          return;
      }
  }
}
