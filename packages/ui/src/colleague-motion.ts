// How a colleague in the office scene moves, one frame at a time: standing up, walking a path
// around the furniture (paths.ts) and through the doors between the rooms, turning, settling onto a
// seat or cushion, a sip on a stroll, and leaving by the waiting room's front door. A walk with a
// destination (to work, to a bench, out of the door) goes straight there; a stroll goes a few steps at
// a time, stopping to look about and stand a moment, now and then with the species' own stretch or
// habit (temperament.ts). The scene decides where each colleague goes and draws it (scene.ts); this
// module plans the way there and advances the body along it. It draws nothing and reads no clock:
// each step is given its time.
import type { State } from "@agent-office/core";
import type { Identity } from "./identity.ts";
import type { ActivityKind, Mode } from "./life.ts";
import type { Species } from "./model.ts";
import { neutralPose, sampleJourney, STRIDE } from "./motion.ts";
import type { Pose } from "./motion.ts";
import { makePath, plannerFor, pointAt, waitingPlannerFor } from "./paths.ts";
import type { Path, Planner, Point } from "./paths.ts";
import { chooseRoutine } from "./routines.ts";
import { TOOL_OF } from "./workstation.ts";
import type { PropKind, RoutineChoice, RoutineContext, RoutineFrame, RoutineKind } from "./routines.ts";
import { seedUnit } from "./seed.ts";
import { geometry, roomDoor, seatById, waitingGeometry, waitingSurface, workSurface } from "./space.ts";
import type { RoomName, Seat, Support } from "./space.ts";
import { boutSteps, planStop, survey, TEMPERAMENTS } from "./temperament.ts";
import type { StopPlan } from "./temperament.ts";

export const H = 220;
export const SPEED = H * 0.17; // room units per second while walking
const WORK_SPEED = SPEED * 1.35; // a colleague whose turn started goes straight back to its desk
const STROLL_SPEED = SPEED * 0.85; // a stroll ambles
/** How long a strolling colleague takes to slow to a stop, and to set its feet once stopped. */
const STOP_BRAKE_S = 0.5;
const STOP_SETTLE_S = 0.55;
/** A stroll stops only this far into its path and this far from its end (room units). */
const STOP_AFTER = 24;
const STOP_BEFORE_END = 70;
/** A routine cut short fades out over this long instead of vanishing. */
export const ROUTINE_RELEASE_S = 0.4;
const TURN = 1.05;
/** A colleague passes a door in this long: fading out at one, fading in at the other. */
export const DOOR_S = 0.35;
export const clamp = (x: number) => Math.max(0, Math.min(1, x));
export const ease = (x: number) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const heightOf = (species: Species) => H * (species === "bird" ? 0.93 : 1);
/** A desk seat faces its desk's centre; a bench faces the room's front. */
export const workDirection = (seat: Seat) => seat.direction ?? (seat.x < 0 ? 1 : -1);
/** How long a body half way onto or off a cushion takes to finish that when its plan is cancelled. */
const SEAT_RECOVERY_S = 0.7;
/** Physical support alone scales an in-place transition; state and activity clocks are unchanged. */
export const supportDuration = (support: Support | null, seconds: number) => seconds * (support === null ? 1 : 1.25);

/** Why a colleague is in the waiting room: it only opened (no prompt yet), or it is on its way home. */
export type WaitingPhase = "arrival" | "departure";
/** `elapsed`: seconds in this state when the daemon knows it (its `since` for waits, failures and finished turns). */
/** `waiting`: on a bench in the waiting room (`seat` is a bench): arriving sessions stay until their first prompt, departing ones leave through the front door. */
/** `long`: its turn is on the daemon's `long` list (a turn running long): at its laptop it works on, tired. */
export type SceneActor = { id: string; species: Species; identity: Identity; state: State; lifecycle: "active" | "ended"; seat: string; faded: boolean; waiting?: WaitingPhase; elapsed?: number; long?: boolean };
/** `stay`: at its place without a routine (asking for help, waiting on its own work, failed or quiet); the pose follows its mode. `stop-settle` and `stop`: a stop on a stroll. */
export type Phase = "work" | "stand" | "align-stand" | "travel" | "turn" | "turn-settle" | "settle" | "rest" | "stay" | "window" | "loiter" | "meeting" | "meeting-ready" | "chat" | "sip-settle" | "sip" | "stop-settle" | "stop" | "portal" | "exit" | "gone";
/** A stop on a stroll: slowing down (`age` counts it), then looking about, standing still and maybe a stretch or habit. */
export type Stop = { stage: "brake" | "look" | "still" | "habit"; plan: StopPlan; age: number };
/** Walks with a destination: to work, to a bench, out of the door. Strolls and visits to a place are leisure. */
export const purposeful = (intent: Intent): boolean => intent === "return-work" || intent === "return-wait" || intent === "exit";
export type Place = Point & { id: string; room: RoomName; kind: "rest" | "window" | "chat" | "wander" | "desk" | "wait" | "door"; wing: number; desk?: string | null; lookDir?: number; sill?: Point; support?: Support };
export type Places = { rest: Place[]; window: Place[]; wander: Place[]; groups: { id: string; points: [Place, Place] }[] };
export type Intent = "activity" | "return-work" | "return-wait" | "exit" | null;
/** Passing between the rooms: walking to this room's door, fading out, fading in at the other room's door, then on to `target`. */
export type Portal = { to: RoomName; target: Place; intent: Intent; stage: "approach" | "out" | "in"; age: number };
/** Going home: a moment on the bench, the walk to the front door, fading out, gone. */
export type Departure = { stage: "wait" | "approach" | "out" | "gone"; age: number };
export type Colleague = {
  id: string;
  data: SceneActor;
  room: RoomName;
  x: number;
  y: number;
  time: number;
  phase: Phase;
  phaseTime: number;
  sit: number;
  fromSit: number;
  targetSit: number;
  /** The cushion the body is on or getting onto; kept until it has fully stood up. */
  support: Support | null;
  /** A cancelled plan left the body half way onto or off its cushion: it finishes only that, in place. */
  seatRecovery: { from: number; to: number; age: number } | null;
  direction: number;
  toDirection: number;
  turn: number;
  speed: number;
  visible: number;
  homeSeat: string;
  rawState: State;
  lifecycle: "active" | "ended";
  waitingPhase: WaitingPhase | null;
  mode: Mode;
  needsHelp: boolean;
  /** How far its near paw is up (0 to 1): held up while it waits for the owner, lowered while it walks. */
  raise: number;
  path: (Path & { level: number }) | null;
  intent: Intent;
  portal: Portal | null;
  departure: Departure | null;
  /** A resting colleague getting up from a desk: it does not hold still until it reaches its first place. */
  leaving: boolean;
  target: Place | null;
  spot: Place | null;
  action: ActivityKind | null;
  afterTurn: Phase | null;
  peerId: string | null;
  dwell: number;
  visits: number;
  queueTime: number;
  travelTime: number;
  pathDistance: number;
  gaitDistance: number;
  tangent: Point;
  contacts: Partial<Record<"nearFoot" | "farFoot", Point>>;
  fromPose: Pose | null;
  lastPose: Pose | null;
  /** The routine in progress, its sample this frame and its age in motion time. */
  routine: RoutineChoice | null;
  routineFrame: RoutineFrame | null;
  routineAge: number;
  routineVisit: number;
  previousRoutine: RoutineKind | null;
  /** A cup kept after tea, carried on a stroll until the next rest, work or a stop. */
  heldProp: PropKind | null;
  /** One sip per stroll: slowing down, then picking up speed again after it. */
  sipUsed: boolean;
  sipBrakeTime: number | null;
  resumeTime: number | null;
  /** The stop in progress on a stroll, where the current stretch of walking began (gait distance), its steps, the stops so far, and whether this stroll had its stretch or habit. */
  stop: Stop | null;
  boutFrom: number;
  boutSteps: number;
  stops: number;
  habitUsed: boolean;
  /** A routine cut short (a new turn, a state change): its last frame, fading out over ROUTINE_RELEASE_S. */
  release: { frame: RoutineFrame; age: number } | null;
  /** How tired it looks, 0 to 1: rising while it works in a long turn, easing back after. */
  fatigue: number;
  /** How far its thought cloud has appeared, 0 to 1, while it has no signal. */
  cloud: number;
};

export type MotionDeps = {
  /** Everyone in the scene: a free strolling place keeps away from them. */
  colleagues: ReadonlyMap<string, Colleague>;
  /** The colleagues whose activity ended this frame (the scene tells the activity director next frame). */
  finished: () => Set<string>;
  /** How many bench rows the waiting room is drawn with now. */
  shownRows: () => number;
};

/** Each colleague's plan and step, for the scene that holds `colleagues`. */
export function createColleagueMotion({ colleagues, finished, shownRows }: MotionDeps) {
  const homeOf = (c: Colleague): Seat => {
    const seat = seatById(c.homeSeat);
    if (seat === undefined) throw new Error(`Missing seat ${c.homeSeat} for ${c.id}`);
    return seat;
  };
  const deskPlace = (seat: Seat): Place => ({ ...seat, room: "work", kind: "desk" });
  const benchPlace = (seat: Seat): Place => ({ ...seat, room: "waiting", kind: "wait" });
  const basePhase = (c: Colleague): Phase => (c.mode === "work" ? "work" : (c.mode === "rest" || c.mode === "departed") && !c.needsHelp ? "rest" : "stay");
  function resetRoutine(c: Colleague): void {
    // Cut short, a routine lets go of the pose and the paws over a moment; the new plan starts at once.
    if (c.routineFrame !== null && !c.routineFrame.done) c.release = { frame: c.routineFrame, age: 0 };
    c.routine = null;
    c.routineFrame = null;
    c.routineAge = 0;
  }
  function clearPlan(c: Colleague): void {
    // A cancelled plan stops at once, but a body half way onto or off its cushion still needs it:
    // only that movement is finished, in place.
    if (c.support !== null && c.sit > 0 && c.sit < 1 && c.seatRecovery === null) c.seatRecovery = { from: c.sit, to: c.phase === "settle" ? 1 : 0, age: 0 };
    resetRoutine(c);
    c.sipBrakeTime = null;
    c.resumeTime = null;
    c.stop = null;
    c.path = null;
    c.target = null;
    c.peerId = null;
    c.action = null;
    c.afterTurn = null;
    // A colleague half way through a door finishes passing it; one already leaving stays gone.
    if (c.portal !== null && c.portal.stage === "approach") c.portal = null;
    if (c.departure !== null && c.departure.stage !== "out" && c.departure.stage !== "gone") c.departure = null;
    c.phase = c.portal !== null ? "portal" : c.departure?.stage === "out" ? "exit" : c.departure?.stage === "gone" ? "gone" : basePhase(c);
    c.phaseTime = 0;
    c.turn = 0;
    c.speed = 0;
    c.contacts = {};
  }
  function finish(c: Colleague): void {
    finished().add(c.id);
    clearPlan(c);
  }
  function startTravel(c: Colleague, path: Path & { level: number }, intent: Intent): void {
    c.seatRecovery = null;
    resetRoutine(c);
    c.sipUsed = false;
    c.sipBrakeTime = null;
    c.resumeTime = null;
    if (intent === "return-work" || intent === "exit") c.heldProp = null;
    c.fromPose = c.lastPose ?? neutralPose();
    const start = pointAt(path, 0);
    c.tangent = { x: start.dx, y: start.dy };
    c.path = path;
    c.intent = intent;
    c.speed = 0;
    c.travelTime = 0;
    c.pathDistance = 0;
    c.phaseTime = 0;
    c.fromSit = c.sit;
    c.phase = "stand";
    c.afterTurn = null;
    c.contacts = {};
    c.gaitDistance = (0.07 - seedUnit(c.id, "gait")) * 0.22;
    c.stop = null;
    c.stops = 0;
    c.habitUsed = false;
    c.boutFrom = c.gaitDistance;
    c.boutSteps = boutSteps(c.data.species, strollSeed(c), 0);
  }
  /** Each stroll plans its stops anew. */
  const strollSeed = (c: Colleague) => `${c.id}:stroll:${c.visits}`;
  /** After a stop: the feet get ready, then the walk picks up its route again for a few more steps. */
  function walkOn(c: Colleague): void {
    resetRoutine(c);
    c.fromPose = c.lastPose ?? neutralPose();
    c.fromSit = 0;
    c.stop = null;
    c.turn = 0;
    c.phase = "stand";
    c.phaseTime = 0;
    c.resumeTime = 0;
    c.contacts = {};
    c.boutFrom = c.gaitDistance;
    c.boutSteps = boutSteps(c.data.species, strollSeed(c), c.stops);
  }
  function face(c: Colleague, direction: number, after: Phase): void {
    c.phaseTime = 0;
    c.contacts = {};
    c.speed = 0;
    if (direction === c.direction) {
      c.phase = after;
      return;
    }
    c.phase = "turn";
    c.turn = 0;
    c.toDirection = direction;
    c.afterTurn = after;
  }
  /** Already at its desk when work starts: stand, face the laptop, sit down to it. */
  function alignWork(c: Colleague): void {
    c.seatRecovery = null;
    resetRoutine(c);
    c.heldProp = null;
    c.intent = "return-work";
    c.fromPose = c.lastPose ?? neutralPose();
    c.targetSit = 0.55;
    c.fromSit = c.sit;
    c.phase = "align-stand";
    c.phaseTime = 0;
    c.contacts = {};
  }
  function enterRoutine(c: Colleague, context: RoutineContext, only: readonly RoutineKind[] | null = null): void {
    const choice = chooseRoutine({ context, seed: c.id, visit: c.routineVisit++, previousKind: c.previousRoutine, needsHelp: c.needsHelp, hasCup: c.heldProp === "cup", only, onPaper: context === "work" && TOOL_OF[c.data.species] !== "laptop" });
    if (choice === null) return;
    c.routine = choice;
    c.routineAge = 0;
    c.previousRoutine = choice.kind;
    if (choice.kind === "rest-tea") c.heldProp = "cup";
  }
  /** The planner of a room as it is drawn now. */
  const plannerOf = (room: RoomName, level: number): Planner => (room === "waiting" ? waitingPlannerFor(shownRows()) : plannerFor(level));
  /** The door a colleague leaves `room` by on its way to the other room. */
  const doorOut = (room: RoomName, level: number) => (room === "work" ? roomDoor(workSurface(geometry(level)), "south") : roomDoor(waitingSurface(waitingGeometry(shownRows())), "north"));
  /** The door a colleague enters `room` by, coming from the other room. */
  const doorIn = (room: RoomName, level: number) => doorOut(room, level);
  const doorPlace = (room: RoomName, side: "north" | "south", level: number): Place => {
    const door = room === "work" ? roomDoor(workSurface(geometry(level)), side) : roomDoor(waitingSurface(waitingGeometry(shownRows())), side);
    return { id: `door:${room}:${side}`, room, kind: "door", wing: 0, ...door.approach };
  };
  /**
   * The way to `target` that keeps the walking body clear of the furniture. Every place has one (the
   * places are checked against the room); a colleague the room changed around walks straight to it.
   * A target in the other room: the way to this room's door, and a note to go on from the other door.
   */
  function pathFor(c: Colleague, target: Place, level: number, intent: Intent): Path & { level: number } {
    const planner = plannerOf(c.room, level);
    if (target.room === c.room) {
      c.portal = null;
      return { ...(planner.route(c, target) ?? makePath([c, target])), level };
    }
    const door = doorOut(c.room, level).approach;
    c.portal = { to: target.room, target, intent, stage: "approach", age: 0 };
    return { ...(planner.route(c, door) ?? makePath([c, door])), level };
  }
  /** Through the door: fading out at this room's door, appearing at the other room's, then on to the target. */
  function advancePortal(c: Colleague, dt: number, level: number): void {
    const portal = c.portal!;
    portal.age += dt;
    if (portal.stage === "out" && portal.age >= DOOR_S) {
      const gate = doorIn(portal.to, level).approach;
      c.room = portal.to;
      c.x = gate.x;
      c.y = gate.y;
      c.sit = 0;
      c.support = null;
      c.contacts = {};
      c.speed = 0;
      c.turn = 0;
      c.direction = portal.to === "work" ? (portal.target.x < gate.x ? -1 : 1) : 1;
      c.fromPose = neutralPose();
      portal.stage = "in";
      portal.age = 0;
      return;
    }
    if (portal.stage === "in" && portal.age >= DOOR_S) {
      const { target, intent } = portal;
      c.portal = null;
      if (distance(c, target) < 0.5) {
        c.phase = basePhase(c);
        c.phaseTime = 0;
        return;
      }
      startTravel(c, pathFor(c, target, level, intent), intent);
    }
  }
  /** Going home: from the bench to the waiting room's front door. */
  function planExit(c: Colleague, level: number): void {
    c.departure = { stage: "approach", age: 0 };
    c.heldProp = null;
    startTravel(c, pathFor(c, doorPlace("waiting", "south", level), level, "exit"), "exit");
  }
  function advance(c: Colleague, dt: number): void {
    c.phaseTime += dt;
    if (c.seatRecovery !== null) {
      const recovery = c.seatRecovery;
      const duration = supportDuration(c.support, SEAT_RECOVERY_S);
      recovery.age += dt;
      c.sit = recovery.from + (recovery.to - recovery.from) * ease(recovery.age / duration);
      if (recovery.age >= duration) {
        c.sit = recovery.to;
        if (c.sit === 0) c.support = null;
        c.seatRecovery = null;
      }
      return;
    }
    if (c.phase === "portal" || c.phase === "exit" || c.phase === "gone") return;
    if (c.phase === "stand") {
      const duration = supportDuration(c.support, 0.7);
      c.sit = c.fromSit * (1 - ease(c.phaseTime / duration));
      if (c.phaseTime >= duration) {
        c.sit = 0;
        c.support = null;
        c.phase = "travel";
        c.phaseTime = 0;
      }
      return;
    }
    if (c.phase === "align-stand") {
      const duration = supportDuration(c.support, 0.7);
      c.sit = c.fromSit * (1 - ease(c.phaseTime / duration));
      if (c.phaseTime >= duration) {
        c.sit = 0;
        c.fromSit = 0;
        c.support = null;
        c.fromPose = neutralPose();
        face(c, workDirection(homeOf(c)), "settle");
      }
      return;
    }
    if (c.phase === "sip-settle") {
      if (c.phaseTime >= 0.55) {
        c.phase = "sip";
        c.phaseTime = 0;
        enterRoutine(c, "stroll-stop");
      }
      return;
    }
    if (c.phase === "sip") {
      // After the sip, the feet get ready again before the walk picks up its route.
      if (c.routine === null || c.routineAge >= c.routine.duration) {
        c.fromPose = c.lastPose ?? neutralPose();
        c.fromSit = 0;
        resetRoutine(c);
        c.phase = "stand";
        c.phaseTime = 0;
        c.resumeTime = 0;
        c.contacts = {};
      }
      return;
    }
    if (c.phase === "stop-settle") {
      if (c.phaseTime >= STOP_SETTLE_S) {
        c.phase = "stop";
        c.phaseTime = 0;
      }
      return;
    }
    if (c.phase === "stop") {
      // Look about, stand a moment, sometimes its own stretch or habit, then walk on.
      const stop = c.stop!;
      if (stop.stage === "look") {
        // A colleague asking for help keeps its raised paw in view: it looks about without turning to the viewer.
        c.turn = survey(c.data.species, c.phaseTime, !c.needsHelp).turn;
        if (c.phaseTime >= stop.plan.look) {
          c.turn = 0;
          stop.stage = "still";
          c.phaseTime = 0;
        }
        return;
      }
      if (stop.stage === "still") {
        if (c.phaseTime < stop.plan.still) return;
        if (stop.plan.habit) {
          c.habitUsed = true;
          const own = TEMPERAMENTS[c.data.species].habit && seedUnit(strollSeed(c), `habit-kind:${c.stops}`) < 0.5;
          enterRoutine(c, "stroll-stop", own ? ["stroll-habit"] : ["stroll-stretch"]);
          if (c.routine !== null) {
            stop.stage = "habit";
            c.phaseTime = 0;
            return;
          }
        }
        walkOn(c);
        return;
      }
      if (c.routine === null || c.routineAge >= c.routine.duration) walkOn(c);
      return;
    }
    if (c.phase === "turn-settle") {
      if (c.phaseTime >= 0.35) {
        c.phase = "turn";
        c.phaseTime = 0;
        c.turn = 0;
      }
      return;
    }
    if (c.phase === "turn") {
      c.turn = clamp(c.phaseTime / TURN);
      if (c.phaseTime >= TURN) {
        c.direction = c.toDirection;
        c.turn = 0;
        c.phase = c.afterTurn ?? "stand";
        c.afterTurn = null;
        c.phaseTime = 0;
        c.speed = 0;
        c.fromSit = 0;
        c.fromPose = neutralPose();
        c.contacts = {};
        c.gaitDistance = (0.07 - seedUnit(c.id, "gait")) * 0.22;
      }
      return;
    }
    if (c.phase === "settle") {
      // From where it is to the place's seat: on a rest seat or a bench the cushion takes the body,
      // and an already seated body reassigned the same seat stays seated.
      if (c.intent === "return-wait") c.support = homeOf(c).support ?? c.support;
      else if (c.intent !== "return-work" && c.action === "rest") c.support = c.target?.support ?? c.support;
      const duration = supportDuration(c.support, 0.85);
      c.sit = c.fromSit + (c.targetSit - c.fromSit) * ease(c.phaseTime / duration);
      if (c.phaseTime >= duration) {
        c.phaseTime = 0;
        c.path = null;
        c.leaving = false;
        if (c.intent === "return-work" || c.intent === "return-wait") c.phase = basePhase(c);
        else {
          if (c.action === "rest") c.heldProp = null;
          c.spot = c.target;
          c.phase = c.action === "chat" ? "meeting" : c.action === "wander" ? "loiter" : c.action === "window" ? "window" : "rest";
          if (c.action === "window" && c.target?.lookDir !== undefined) face(c, c.target.lookDir, "window");
        }
      }
      return;
    }
    if (c.phase !== "travel" || c.path === null) {
      // An activity ends after its stay at the place it went to, and its routine; one still choosing
      // a place (a chat waiting for a partner) has not started yet.
      if (c.action !== null && c.target !== null && ["rest", "window", "loiter", "chat"].includes(c.phase) && c.phaseTime >= c.dwell && (c.routine === null || c.routineAge >= c.routine.duration)) finish(c);
      return;
    }
    // A carried cup may be sipped once, well inside a stroll (never on the way to work).
    if (!c.sipUsed && c.sipBrakeTime === null && c.stop === null && c.heldProp === "cup" && c.intent === "activity" && c.pathDistance > 90 && c.path.length - c.pathDistance > 100) {
      c.sipUsed = true;
      c.sipBrakeTime = 0;
    }
    // A stroll goes a few steps at a time, then stops (never on the way to work, a bench or the door,
    // through a door, or within reach of its start or end). On the way to a chat too: the chat starts
    // only once both have arrived.
    const stride = STRIDE * TEMPERAMENTS[c.data.species].stroll.stride;
    if (c.intent === "activity" && c.portal === null && c.stop === null && c.sipBrakeTime === null && c.resumeTime === null && c.pathDistance > STOP_AFTER && c.path.length - c.pathDistance > STOP_BEFORE_END && (c.gaitDistance - c.boutFrom) / (stride / 2) >= c.boutSteps)
      c.stop = { stage: "brake", plan: planStop(c.data.species, strollSeed(c), c.stops++, !c.habitUsed), age: 0 };
    let rate = 1;
    if (c.sipBrakeTime !== null) {
      c.sipBrakeTime += dt;
      rate = 1 - ease(c.sipBrakeTime / 0.7);
    } else if (c.stop !== null) {
      c.stop.age += dt;
      rate = 1 - ease(c.stop.age / STOP_BRAKE_S);
    } else if (c.resumeTime !== null) {
      c.resumeTime += dt;
      rate = ease(c.resumeTime / 0.7);
      if (c.resumeTime >= 0.7) c.resumeTime = null;
    }
    const travelStep = dt * rate;
    const journey = sampleJourney(c.travelTime + travelStep, { distance: c.path.length, speed: c.intent === "return-work" ? WORK_SPEED : c.intent === "activity" ? STROLL_SPEED : SPEED, dwell: 0, ramp: 0.7, turn: TURN });
    const at = pointAt(c.path, journey.position);
    const nextDirection = Math.abs(at.dx) > 0.1 ? Math.sign(at.dx) : c.direction;
    if (nextDirection !== c.direction) {
      c.fromPose = c.lastPose ?? neutralPose();
      c.tangent = { x: at.dx, y: at.dy };
      c.phase = "turn-settle";
      c.phaseTime = 0;
      c.turn = 0;
      c.toDirection = nextDirection;
      c.contacts = {};
      return;
    }
    const travelled = Math.max(0, journey.position - c.pathDistance);
    c.travelTime += travelStep;
    c.gaitDistance += travelled / heightOf(c.data.species);
    c.pathDistance = journey.position;
    c.x = at.x;
    c.y = at.y;
    c.tangent = { x: at.dx, y: at.dy };
    c.speed = journey.speed * rate;
    if (c.sipBrakeTime !== null && c.sipBrakeTime >= 0.7) {
      c.sipBrakeTime = null;
      c.speed = 0;
      c.fromPose = c.lastPose ?? neutralPose();
      c.phase = "sip-settle";
      c.phaseTime = 0;
      c.contacts = {};
      return;
    }
    if (c.stop !== null && c.stop.age >= STOP_BRAKE_S) {
      c.speed = 0;
      c.fromPose = c.lastPose ?? neutralPose();
      c.stop = { ...c.stop, stage: "look", age: 0 };
      c.phase = "stop-settle";
      c.phaseTime = 0;
      c.contacts = {};
      return;
    }
    if (journey.phase !== "walk") {
      const end = c.path.points.at(-1)!;
      c.x = end.x;
      c.y = end.y;
      c.speed = 0;
      c.contacts = {};
      c.fromPose = c.lastPose ?? neutralPose();
      c.path = null;
      // At a door: through it (the other room continues the walk), or out of the house.
      if (c.portal !== null && c.portal.stage === "approach") {
        c.portal.stage = "out";
        c.portal.age = 0;
        c.phase = "portal";
        c.phaseTime = 0;
        return;
      }
      if (c.intent === "exit") {
        c.departure = { stage: "out", age: 0 };
        c.phase = "exit";
        c.phaseTime = 0;
        return;
      }
      c.fromSit = c.sit;
      c.phase = "settle";
      c.phaseTime = 0;
      c.targetSit = c.intent === "return-work" ? 0.55 : c.action === "rest" || c.intent === "return-wait" ? 1 : 0;
      // Back at the desk, it turns to the laptop before sitting down; on a bench it faces the room's front.
      const facing = c.intent === "return-work" ? workDirection(homeOf(c)) : c.intent === "return-wait" ? 1 : c.direction;
      if (c.direction !== facing) {
        c.toDirection = facing;
        c.afterTurn = "settle";
        c.phase = "turn-settle";
      }
    }
  }

  /** A free strolling place, away from everyone else, for a resting colleague with no rest seat. */
  function standingSpot(c: Colleague, spots: Places): Place | null {
    const others = [...colleagues.values()].filter((other) => other !== c && other.room === "work");
    const free = spots.wander.filter((p) => others.every((other) => distance(p, other) > 100 && (other.target === null || distance(p, other.target) > 100)));
    return free.length === 0 ? null : free[Math.floor(seedUnit(c.id, "standing") * free.length)]!;
  }

  return { homeOf, deskPlace, benchPlace, basePhase, resetRoutine, clearPlan, finish, startTravel, face, alignWork, enterRoutine, plannerOf, doorPlace, pathFor, advancePortal, planExit, advance, standingSpot };
}
