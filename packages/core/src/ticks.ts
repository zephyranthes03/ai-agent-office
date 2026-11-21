// Non-signal inputs: ticks (phase H), liveness reports (B3), adapter status (B4) and the owner's
// dismissals (G2) and confirmed stops (G3). None of them creates a session or touches `last_signal_at` (A1, I1).
import type { Ctx } from "./store.ts";
import { clearTurn, edit, endSession, get, hasWaitingChild, record, setState } from "./store.ts";
import { elapsedSeconds, reached } from "./time.ts";
import type { AdapterStatus, Dismissal, Liveness, Snapshot, State, Stopped } from "./types.ts";

function tickSession(ctx: Ctx, snap: Snapshot): void {
  const { config, at } = ctx;
  const id = snap.session;
  // H1: transient done/cancelled expire to idle.
  if ((snap.state === "done" || snap.state === "cancelled") && snap.hold_until !== null && reached(at, snap.hold_until)) {
    record(ctx, "H1", id);
    const s = edit(ctx, id);
    setState(ctx, s, "idle");
    s.hold_until = null;
    return;
  }
  // H2/H3 leave a parent alone while one of its children waits for the user: the child sends
  // nothing while it waits, so the parent's silence says nothing about the parent.
  const busyOrIdle = snap.state === "working" || snap.state === "waiting_dependency" || snap.state === "idle";
  if (busyOrIdle && hasWaitingChild(ctx, snap)) return;
  const busyTooLong = (snap.state === "working" || snap.state === "waiting_dependency") && elapsedSeconds(snap.last_signal_at, at) >= (snap.stale_after_s ?? config.working_stale_s);
  // H7: a child (a hook-routed subagent) that has gone silent ends instead of going unknown: its
  // stop never came, it has no process of its own to find dead (liveness is its parent's), and
  // nothing can open it. Its next hook brings it back (A2). A child recorded as unknown before
  // this rule existed ends at the first tick for the same reasons, and so does a child left in error
  // (by a direct report, or recorded before C6 ended a child's failed turn at once).
  if (snap.parent !== null && (busyTooLong || snap.state === "unknown" || snap.state === "error")) {
    record(ctx, "H7", id);
    endSession(ctx, id, true);
    return;
  }
  // H2: a busy session that has been silent too long is unknown, whatever liveness says.
  if (busyTooLong) {
    record(ctx, "H2", id);
    const s = edit(ctx, id);
    s.state_before_unknown = s.state;
    setState(ctx, s, "unknown");
    return;
  }
  // H3: idle goes unknown only without a recent alive report.
  if (snap.state === "idle" && elapsedSeconds(snap.last_signal_at, at) >= (snap.stale_after_s ?? config.idle_stale_s)) {
    if (snap.last_alive_at === null || elapsedSeconds(snap.last_alive_at, at) >= config.liveness_fresh_s) {
      record(ctx, "H3", id);
      const s = edit(ctx, id);
      s.state_before_unknown = "idle";
      setState(ctx, s, "unknown");
    }
    return;
  }
  // H4: unknown for too long ends the session and its children.
  if (snap.state === "unknown") {
    if (elapsedSeconds(snap.state_since, at) >= config.unknown_gone_s) {
      record(ctx, "H4", id);
      endSession(ctx, id, true);
    }
    return;
  }
  // H6 (only with the option set): an approval wait ends in idle this long after it began.
  if (snap.state === "waiting_user" && snap.waiting_on?.reason === "approval" && config.approval_wait_timeout_s !== null && elapsedSeconds(snap.waiting_since ?? snap.state_since, at) >= config.approval_wait_timeout_s) {
    record(ctx, "H6", id);
    const s = edit(ctx, id);
    setState(ctx, s, "idle");
    clearTurn(s);
    return;
  }
  // H5: waiting_user, error and paused never change on ticks.
  if (snap.state === "waiting_user" || snap.state === "error" || snap.state === "paused") record(ctx, "H5", id);
}

export function applyTick(ctx: Ctx): void {
  // A2: ended sessions are skipped. The key list is fixed first because H4 may edit parents.
  for (const id of Object.keys(ctx.out)) {
    const snap = get(ctx, id);
    if (snap && snap.lifecycle === "active") tickSession(ctx, snap);
  }
}

export function applyLiveness(ctx: Ctx, input: Liveness): void {
  const snap = get(ctx, input.session);
  if (!snap || snap.lifecycle === "ended") return;
  record(ctx, "B3", input.session);
  if (input.alive) {
    edit(ctx, input.session).last_alive_at = ctx.at;
  } else if (input.confidence === "exact") {
    endSession(ctx, input.session, true);
  }
}

/**
 * States a session can be sent home from: all but a turn at work (working, or waiting on its own
 * child or tool). A user wait is included because Claude Code reports a denial with Esc with no hook
 * at all, leaving the wait behind.
 */
export const DISMISSIBLE: readonly State[] = ["idle", "done", "cancelled", "error", "paused", "unknown", "waiting_user"];

/**
 * States the owner may stop a session's process in: those it may be sent home from, except a
 * session gone quiet, which may still be in a turn (nothing says it is not).
 */
export const STOPPABLE: readonly State[] = DISMISSIBLE.filter((state) => state !== "unknown");

/**
 * The owner's stop was confirmed (the process is gone): a top-level session still active ends with
 * its children, whatever it showed, until its next signal (A2), as when its agent reports the end.
 */
export function applyStopped(ctx: Ctx, input: Stopped): void {
  const snap = get(ctx, input.session);
  if (!snap || snap.lifecycle === "ended" || snap.parent !== null) return;
  record(ctx, "G3", input.session);
  endSession(ctx, input.session, true);
}

export function applyDismissal(ctx: Ctx, input: Dismissal): void {
  const snap = get(ctx, input.session);
  if (!snap || snap.lifecycle === "ended" || snap.parent !== null || !DISMISSIBLE.includes(snap.state)) return;
  record(ctx, "G2", input.session);
  endSession(ctx, input.session, true);
}

export function applyAdapterStatus(ctx: Ctx, input: AdapterStatus): void {
  record(ctx, "B4", null);
  if (input.connected) return;
  for (const id of Object.keys(ctx.out)) {
    const snap = get(ctx, id);
    if (!snap || snap.lifecycle === "ended" || snap.agent !== input.agent) continue;
    if (snap.state === "idle" || snap.state === "working" || snap.state === "waiting_dependency") {
      const s = edit(ctx, id);
      s.state_before_unknown = s.state;
      setState(ctx, s, "unknown");
    }
  }
}
