// What a colleague does between moments that matter (from the art run's flow-life-v3): every
// session has its own plan of resting, strolling, looking out of the window and chatting, chosen by
// its state and how long it has been in it. Presentation only: states keep their meaning (a waiting
// colleague keeps asking for help while it strolls), and nothing here judges a session. There is no
// cap on how many walk at once. The time before a waiting or resting colleague starts moving is the
// owner's setting (`scene.wander_after_s`, five minutes by default). A colleague waiting only on its
// own child or tool is still in its turn, so it stays at its desk like a working one.
import type { State } from "@agent-office/core";
import { seedUnit } from "./seed.ts";

export const DEFAULT_WANDER_AFTER_S = 300;

export type Mode = "work" | "user-wait" | "dependency-wait" | "rest" | "hold" | "unknown" | "departed";
export type Activity = { mode: Mode; canMove: boolean; needsHelp: boolean };
export type ActivityKind = "rest" | "chat" | "wander" | "window";

const validTime = (value: number) => Number.isFinite(value) && value >= 0;

/**
 * `atDesk`: a resting colleague left at a desk because the rest seats are full gets up at once, so
 * that only working colleagues sit at desks.
 */
export function activityFor({ state, lifecycle = "active", elapsed = 0, wanderAfterS = DEFAULT_WANDER_AFTER_S, atDesk = false }: { state: State; lifecycle?: "active" | "ended"; elapsed?: number; wanderAfterS?: number; atDesk?: boolean }): Activity {
  if (!validTime(elapsed)) throw new RangeError("elapsed must be finite and >= 0");
  if (lifecycle === "ended") return { mode: "departed", canMove: false, needsHelp: false };
  const long = elapsed >= wanderAfterS;
  switch (state) {
    case "working":
      return { mode: "work", canMove: false, needsHelp: false };
    case "waiting_user":
      return { mode: "user-wait", canMove: long, needsHelp: true };
    case "waiting_dependency":
      return { mode: "dependency-wait", canMove: false, needsHelp: false };
    // `done` and `cancelled` last a few seconds before `idle`, and nothing produces `paused` yet: all
    // rest as idle does, moving about after the owner's wait (a finished colleague no longer gets up
    // for those few seconds only to turn back).
    case "idle":
    case "done":
    case "cancelled":
    case "paused":
      return { mode: "rest", canMove: long || atDesk, needsHelp: false };
    case "error":
      return { mode: "hold", canMove: false, needsHelp: true };
    case "unknown":
      return { mode: "unknown", canMove: false, needsHelp: false };
  }
}

const RESTING: readonly ActivityKind[] = ["wander", "rest", "chat", "window"];
const AGENDAS: Partial<Record<State, readonly ActivityKind[]>> = {
  idle: RESTING,
  done: RESTING,
  cancelled: RESTING,
  paused: RESTING,
  waiting_user: ["wander", "window", "rest", "chat"],
};

/** `elapsed`: seconds in this state when the caller knows it (the daemon's `since`); else counted here from first sight. */
export type LifeActor = { id: string; state: State; lifecycle?: "active" | "ended"; elapsed?: number; atDesk?: boolean };
export type Assignment = { kind: ActivityKind; visit: number };
export type LifeUpdate = {
  /** Motion time; stops while motion is paused. */
  dt?: number;
  /** State time; runs on while motion is paused. */
  elapsedDt?: number;
  actors?: readonly LifeActor[];
  /** Colleagues held still (the one under the pointer). */
  frozenIds?: readonly string[];
  paused?: boolean;
  /** Colleagues that finished their activity (arrived and stayed their time). */
  completed?: readonly string[];
  wanderAfterS?: number;
};

type Record_ = { stateKey: string; resting: boolean; elapsed: number; visits: number; eligible: boolean; availableAt: number };

export function createActivityDirector() {
  let motionAge = 0;
  const records = new Map<string, Record_>();
  const assignments = new Map<string, Assignment>();
  function update({ dt = 0, elapsedDt = dt, actors = [], frozenIds = [], paused = false, completed = [], wanderAfterS = DEFAULT_WANDER_AFTER_S }: LifeUpdate = {}) {
    if (!validTime(dt) || !validTime(elapsedDt)) throw new RangeError("elapsed deltas must be finite and >= 0");
    if (!paused) motionAge += dt;
    const present = new Set(actors.map((a) => a.id));
    const frozen = new Set(frozenIds);
    const finished = new Set(completed);
    const released: string[] = [];
    const grants: string[] = [];
    const byId = new Map<string, Activity & { elapsed: number }>();
    const release = (id: string) => {
      if (assignments.delete(id)) released.push(id);
    };
    for (const id of records.keys())
      if (!present.has(id)) {
        release(id);
        records.delete(id);
      }
    for (const actor of actors) {
      const stateKey = `${actor.state}:${actor.lifecycle ?? "active"}`;
      const resting = AGENDAS[actor.state] === RESTING && (actor.lifecycle ?? "active") === "active";
      let record = records.get(actor.id);
      if (record === undefined) {
        record = { stateKey, resting, elapsed: 0, visits: 0, eligible: false, availableAt: motionAge };
        records.set(actor.id, record);
      } else if (record.stateKey !== stateKey) {
        // From one resting state to another (a finished turn's `done` becomes `idle` seconds later)
        // the colleague goes on with what it was doing; any other change starts it over.
        if (!(record.resting && resting)) {
          release(actor.id);
          record.eligible = false;
        }
        record.stateKey = stateKey;
        record.resting = resting;
        record.elapsed = 0;
      } else record.elapsed += elapsedDt;
      if (actor.elapsed !== undefined && validTime(actor.elapsed)) record.elapsed = actor.elapsed;
      const activity = { ...activityFor({ state: actor.state, lifecycle: actor.lifecycle ?? "active", elapsed: record.elapsed, wanderAfterS, atDesk: actor.atDesk ?? false }), elapsed: record.elapsed };
      byId.set(actor.id, activity);
      if (!activity.canMove) release(actor.id);
      if (activity.canMove && !record.eligible) record.availableAt = motionAge + 0.3 + seedUnit(actor.id, "start") * 2;
      record.eligible = activity.canMove;
      if (finished.has(actor.id)) {
        release(actor.id);
        record.availableAt = motionAge + 4 + seedUnit(actor.id, `rest:${record.visits}`) * 5;
      }
    }
    // Every eligible session gets its own agenda; the room's size is never a cap.
    for (const actor of actors) {
      const record = records.get(actor.id)!;
      if (paused || !record.eligible || assignments.has(actor.id) || frozen.has(actor.id) || motionAge < record.availableAt) continue;
      const choices = AGENDAS[actor.state];
      if (choices === undefined) continue;
      const index = (record.visits + Math.floor(seedUnit(actor.id, "agenda") * choices.length)) % choices.length;
      assignments.set(actor.id, { kind: choices[index]!, visit: ++record.visits });
      grants.push(actor.id);
    }
    return { byId, assignments: new Map(assignments), activeIds: [...assignments.keys()], eligibleCount: [...byId.values()].filter((a) => a.canMove).length, grants, released };
  }
  return { update };
}
