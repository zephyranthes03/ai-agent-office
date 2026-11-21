// The office canvas. It draws what it is given — already judged sessions with their seats — and owns
// only presentation: the motion clock, each colleague's walk between places (the art run's
// flow-life-v3: stand up, walk around the furniture (paths.ts), turn, settle), their activities (rest, stroll, window,
// chat; life.ts), the small routines once they have arrived (flow-life-v5: typing with paws on the
// laptop's keys, a newspaper or tea at rest, a sip on a stroll; routines.ts), fades and the rooms'
// growth. Furniture is drawn by its depth on the floor: a chair, the colleague on it, the desk, the
// note and laptop, the paws on the keys, the lid; a sofa covers whoever walks behind it, and a coffee
// corner's rug lies on the floor under its table and stools. A resting body sits on its cushion
// (flow-life-v5): lifted onto it as it sits down, kept there until it has stood up, and a state change
// while half seated only finishes that movement. States keep their meaning: a waiting colleague keeps
// its marker and help gesture while it strolls.
//
// Two rooms (flow-life-v5, 2026-10-31): the office, and below it the waiting room, each with its own
// camera. A session only opened sits on a bench there until its first prompt, then walks out through
// the waiting room's back door and in through the office's front door to its desk; a session going
// home walks the other way, sits on a bench a moment, and leaves by the waiting room's front door.
// Between the doors a colleague is carried, unseen: no path crosses the gap. The waiting room can be
// switched off, in which case nobody waits or leaves on screen. Without the preview art it draws the
// same rooms and colleagues as plain shapes, so the scene and its markers keep working.
//
// A frame is two steps. `step` moves everything on by the time given and works out what the frame
// shows: who is where, in which pose, and where each name and hit area goes. It never touches the
// canvas. `paint` draws the frame `step` last worked out. `draw` does both, which is what a page
// showing the scene wants every frame; whoever only needs the scene to move on (many frames at once,
// or frames nobody will see) calls `step` alone. The art comes from scene-art.ts: a scene loads its
// own unless it is handed one that several scenes share. The walls, floors and window are the same
// from frame to frame while the rooms keep their size, so `paint` draws them once on a canvas of
// their own and copies them from there; while a room grows or shrinks it draws them piece by piece.
import type { State } from "@agent-office/core";
import { clamp, createColleagueMotion, distance, DOOR_S, ease, H, heightOf, purposeful, ROUTINE_RELEASE_S, SPEED, supportDuration, workDirection } from "./colleague-motion.ts";
import type { Colleague, Place, Places, SceneActor } from "./colleague-motion.ts";
import type { Identity } from "./identity.ts";
import { createActivityDirector, DEFAULT_WANDER_AFTER_S } from "./life.ts";
import type { Species } from "./model.ts";
import { neutralPose, samplePose } from "./motion.ts";
import type { Behavior } from "./motion.ts";
import { makePath } from "./paths.ts";
import { loadOfficeArt } from "./scene-art.ts";
import type { OfficeArt } from "./scene-art.ts";
import { archAt, cameras, mullionsAt, placeFeet, placesFor } from "./scene-layout.ts";
import type { Arch, Camera, Mullion, OfficeCamera } from "./scene-layout.ts";
import { createScenePainter } from "./scene-paint.ts";
import type { Figure, SpaceArt } from "./scene-paint.ts";
import type { Rigs } from "./rig.ts";
import { sampleRoutine } from "./routines.ts";
import type { RoutineContext, RoutineKind } from "./routines.ts";
import { seedUnit } from "./seed.ts";
import { archSpan, createSpace, createWaitingSpace, geometry, roomAt, roomOfSeat, seatById, WAITING_ROW_DEPTH, waitingGeometry, waitingRoom, waitingRowVisible, waitingSurface, wingOpacity, workSurface } from "./space.ts";
import type { Geometry, Layout, RoomName, Seat } from "./space.ts";
import { survey, TEMPERAMENTS } from "./temperament.ts";
import type { Weather } from "./weather.ts";
import { createWindows } from "./windows.ts";
import type { Scenery, Sky } from "./windows.ts";
import { TOOL_OF } from "./workstation.ts";
import type { Station, Workstations } from "./workstation.ts";

/** States in which a colleague rests: it never sits at a desk. */
const RESTING: readonly State[] = ["idle", "done", "paused"];
const FADE_PER_S = 1.5;
/** A colleague going home sits on a bench this long before it leaves. */
const DEPARTURE_REST_S = 2.4;
/** How long a near paw takes to go up for the owner, or down for a walk. */
const RAISE_S = 0.45;
/** How far down a colleague sits on arriving at a seat: fully on a cushion or a bench, on a chair at a desk. */
const seatSit = (seat: Seat) => (seat.kind === "desk" ? 0.55 : 1);
const WAITING_ACTIVITY = { mode: "rest" as const, canMove: false, needsHelp: false, elapsed: 0 };
/** Depth of what lies flat on the floor (a rug): under everyone. */
const FLOOR_Z = 15;
// The coffee corner's table and its two stools (furnishings-v1.png, source pixels; flow-life-v5).
const COFFEE_TABLE: readonly (readonly [number, number])[] = [[171, 731], [178, 704], [212, 685], [370, 674], [450, 695], [473, 720], [470, 765], [437, 790], [430, 832], [239, 832], [225, 795], [175, 777]];
const COFFEE_STOOLS: readonly (readonly (readonly [number, number])[])[] = [
  [[54, 804], [65, 782], [105, 767], [169, 765], [219, 781], [242, 805], [245, 850], [230, 876], [172, 897], [109, 890], [70, 872], [54, 840]],
  [[405, 810], [420, 787], [461, 768], [513, 767], [552, 782], [575, 805], [578, 846], [560, 873], [516, 889], [458, 883], [420, 865]],
];
/** Phases a held colleague may still finish: they turn or sit in place and never move it away. */
const IN_PLACE: readonly string[] = ["stand", "align-stand", "turn-settle", "turn", "settle", "sip-settle", "sip", "stop-settle", "portal", "exit"];
/** How long a colleague takes to look tired once its turn runs long (and to recover), and its thought cloud to appear or go. */
const FATIGUE_S = 1.4;
const CLOUD_IN_S = 2.6;
/** How long the view outside takes to change to another weather. */
const WEATHER_FADE_S = 3;
const CLOUD_OUT_S = 0.4;
/** The pose values a routine moves (the upper body, the gaze and the eyes); the feet stay with the walk. */
const UPPER_BODY = ["bodyY", "bodyAngle", "headY", "headAngle", "nearArmAngle", "farArmAngle", "lookX", "blink"] as const;

export type { SceneActor, WaitingPhase } from "./colleague-motion.ts";
export type { Camera } from "./scene-layout.ts";
export { cameras, placesFor } from "./scene-layout.ts";
/** `routine`: the routine in progress, if any (routines.ts). */
export type ActorBox = { id: string; room: RoomName; left: number; top: number; width: number; height: number; anchorX: number; anchorY: number; walking: boolean; routine: RoutineKind | null };
/**
 * `origin` and `scale` are the office's camera, `wall` and `mount` how its side walls and what hangs on
 * them are drawn in it (scene-layout.ts), `arch` its rear wall's window as drawn (room units);
 * `waiting` the waiting room's camera, null while it is
 * switched off. `gone`: colleagues whose departure finished this frame (they walked out of the front door).
 */
export type SceneStats = { weather: Weather; level: number; layout: Layout; scale: number; origin: { x: number; y: number }; wall: number; mount: number; arch: Arch; waiting: (Camera & { layout: Geometry; rows: number }) | null; actors: ActorBox[]; walking: number; gone: string[]; art: "loading" | "ready" | "failed" };
/**
 * `instant` settles everything at once (the first full list after (re)connecting is not news);
 * `stateTime` is wall-clock seconds, which run on while motion is paused; `wanderAfterS` is the
 * owner's setting for when waiting and resting colleagues start moving; `waitingRows` how many bench
 * rows the seating needs; `showWaiting` whether the waiting room is drawn at all; `needsYouGlow`
 * whether a colleague waiting for the owner stands in a warm light (scene.needs_you_glow); `covered`
 * how far down the canvas the page's header reaches (CSS pixels), kept clear of the office;
 * `weather` what the window looks out on (weather.ts), clear when left out.
 */
export type DrawOptions = { selectedId: string | null; hoverId: string | null; paused: boolean; reducedMotion: boolean; instant?: boolean; stateTime?: number; wanderAfterS?: number; waitingRows?: number; showWaiting?: boolean; needsYouGlow?: boolean; covered?: number; weather?: Weather };


/** What `step` worked out for `paint`: the rooms as they are drawn in their cameras, the window, and every piece and figure by depth. */
type Frame = { cams: { work: OfficeCamera; waiting: Camera | null }; layout: Layout; waitingLayout: Geometry; arch: Arch; mullions: Mullion[]; sky: Sky; layers: { room: RoomName; z: number; draw: () => void }[] };

/** `loaded`: the art to draw with; left out, the scene loads its own (scene-art.ts). */
export function createOfficeScene(canvas: HTMLCanvasElement, loaded: Promise<OfficeArt> = loadOfficeArt()) {
  const maybe = canvas.getContext("2d");
  if (maybe === null) throw new Error("Canvas 2D is not available");
  const ctx: CanvasRenderingContext2D = maybe;
  const space = createSpace(0);
  const waitingSpace = createWaitingSpace(1);
  const director = createActivityDirector();
  const colleagues = new Map<string, Colleague>();
  let rigs: Rigs | null = null;
  let art: SpaceArt | null = null;
  let workstations: Workstations | null = null;
  let artState: SceneStats["art"] = "loading";
  let width = 0;
  let height = 0;
  let lastTime: number | null = null;
  let lastStateTime: number | null = null;
  let finished = new Set<string>();
  let lastStats: SceneStats | null = null;
  /** The frame `step` last worked out, for `paint`. */
  let frame: Frame | null = null;
  /** The places of the room size and window last asked for: placesFor is pure, and the room seldom changes. */
  let places: { key: string; value: Places } | null = null;
  /**
   * The rooms' walls and floors with the window, kept on a canvas of their own as large as the scene's
   * (made when first needed): a frame copies them from there instead of drawing some hundreds of
   * pieces again, for as long as `key` — the canvas's size, the cameras, the rooms' sizes, the window,
   * its view and the weather — stays what they were drawn for. Only with the art.
   */
  let backdrop: { layer: HTMLCanvasElement; ctx: CanvasRenderingContext2D; roomPlate: (typeof painter)["roomPlate"]; key: string | null } | null = null;
  /** What the frame before this one needed its walls drawn for: they are kept once two frames in a row need the same, so rooms that are changing their size are drawn piece by piece as ever. */
  let lastBackdropKey: string | null = null;
  let scenery: Scenery = "forest";
  /** The weather outside, fading from one to the next when it changes. */
  let sky: Sky = { from: "clear", to: "clear", mix: 1 };

  const ready = (async () => {
    const { views, rigs: characters, workstations: stations, ...space } = await loaded;
    const windows = createWindows(views);
    windows.setScenery(scenery);
    art = { ...space, windows };
    rigs = characters;
    workstations = stations;
    artState = "ready";
  })().catch((error: unknown) => {
    artState = "failed";
    throw error;
  });

  function resize(): void {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    width = r.width;
    height = r.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  const painterState = { art: () => art, rigs: () => rigs };
  const painter = createScenePainter(ctx, painterState);
  const { roomPlate, plainArch, prop, laptopLight, placement, figure, glowingFigure, thoughtCloud } = painter;

  // --- each colleague's plan (colleague-motion.ts) -------------------------------------------------
  /** How many bench rows the waiting room is drawn with now (each frame sets it). */
  let shownRows = 1;
  const { homeOf, deskPlace, benchPlace, basePhase, resetRoutine, clearPlan, finish, startTravel, face, alignWork, enterRoutine, plannerOf, doorPlace, pathFor, advancePortal, planExit, advance, standingSpot } = createColleagueMotion({ colleagues, finished: () => finished, shownRows: () => shownRows });

  /**
   * Moves the scene on to `time` and works out the frame to show; nothing is drawn. Null while the
   * canvas has no size.
   */
  function step(time: number, cast: readonly SceneActor[], level: number, { selectedId, hoverId, paused, reducedMotion, instant = false, stateTime = time, wanderAfterS = DEFAULT_WANDER_AFTER_S, waitingRows = 1, showWaiting = true, needsYouGlow = true, covered = 0, weather = "clear" }: DrawOptions): SceneStats | null {
    if (!width || !height) return null;
    const dt = lastTime === null ? 0 : Math.max(0, Math.min(time - lastTime, 0.05));
    const elapsedDt = lastStateTime === null ? 0 : Math.max(0, stateTime - lastStateTime);
    lastTime = time;
    lastStateTime = stateTime;
    const still = paused || reducedMotion || instant;
    const step = still ? 0 : dt;
    // A new weather fades in over the one shown most; held still, it is there at once.
    if (weather !== sky.to) sky = { from: sky.mix < 0.5 ? sky.from : sky.to, to: weather, mix: 0 };
    sky = { ...sky, mix: still ? 1 : Math.min(1, sky.mix + step / WEATHER_FADE_S) };
    const room = roomAt(level);
    // Without the waiting room nobody waits or leaves on screen.
    const wantedCast = showWaiting ? cast : cast.filter((actor) => actor.waiting === undefined);
    const wanted = new Set(wantedCast.map((actor) => actor.id));
    const gone: string[] = [];
    // The colleague under the pointer, and the one whose card is open, hold still.
    // A colleague going to its desk to work, or a resting one getting up from a desk, keeps moving:
    // desks hold only work, so neither stops at or near one.
    const mustMove = (id: string): boolean => {
      const c = colleagues.get(id);
      const actor = wantedCast.find((a) => a.id === id);
      if (c === undefined || actor === undefined) return false;
      const seat = seatById(actor.seat);
      if (seat?.kind === "desk" && RESTING.includes(actor.state) && distance(c, seat) < 12) c.leaving = true;
      return c.intent === "return-work" || c.leaving;
    };
    const held = new Set([hoverId, selectedId].filter((id): id is string => id !== null && !mustMove(id)));
    // A colleague still out in a wing keeps that wing open until it is back; one still on a far bench row keeps that row.
    // One on its way out of the front door (past its last sit on the bench) asks for no row: the door is below the last
    // row's threshold, and a room that grew for the walk would shrink the picture for a moment (owner, 2026-11-01).
    let visibleLevel = level;
    const outside = (c: Colleague, b: Geometry) => c.x < b.left || c.x > b.right || c.y > b.height;
    while ([...colleagues.values()].some((c) => wanted.has(c.id) && c.room === "work" && c.departure?.stage !== "gone" && outside(c, geometry(visibleLevel)))) visibleLevel++;
    const rowsNeeded = (y: number) => 1 + Math.max(0, Math.ceil((y - (waitingGeometry(1).height - 77)) / WAITING_ROW_DEPTH));
    const visibleRows = Math.max(waitingRows, ...[...colleagues.values()].filter((c) => wanted.has(c.id) && c.room === "waiting" && (c.departure === null || c.departure.stage === "wait")).map((c) => rowsNeeded(c.y)));
    const layout = space.update(visibleLevel, step, { instant: still });
    const waitingLayout = waitingSpace.update(visibleRows, step, { instant: still });
    shownRows = Math.max(visibleRows, Math.ceil(1 + (waitingLayout.height - waitingGeometry(1).height) / WAITING_ROW_DEPTH - 0.01));
    const shown = roomAt(Math.max(visibleLevel, layout.level, layout.wanted));
    const shownWaiting = waitingRoom(shownRows);
    const cams = cameras(width, height, layout, showWaiting ? waitingLayout : null, covered);
    const status = director.update({ dt: step, elapsedDt, actors: wantedCast.filter((actor) => actor.waiting === undefined).map(({ id, state, lifecycle, elapsed, seat }) => ({ id, state, lifecycle, atDesk: seatById(seat)?.kind === "desk", ...(elapsed === undefined ? {} : { elapsed }) })), frozenIds: [...held], paused: still, completed: [...finished], wanderAfterS });
    finished = new Set();
    // The window spots stand before the window the room has at its seating's size, in this camera.
    const span = archSpan(workSurface(geometry(level)), cams.work.wall);
    const placesKey = `${level} ${span.left.x} ${span.left.y} ${span.right.x} ${span.right.y} ${span.base}`;
    if (places?.key !== placesKey) places = { key: placesKey, value: placesFor(room, level, span) };
    const spots = places.value;

    for (const actor of wantedCast) {
      const home = seatById(actor.seat);
      if (home === undefined) throw new Error(`Missing seat ${actor.seat} for ${actor.id}`);
      // A waiting colleague has no agenda: it keeps its bench, like a resting one that may not move.
      const activity = status.byId.get(actor.id) ?? WAITING_ACTIVITY;
      let c = colleagues.get(actor.id);
      const fresh = c === undefined;
      if (c === undefined) {
        c = { id: actor.id, data: actor, room: roomOfSeat(home), x: home.x, y: home.y, time: 0, phase: "rest", phaseTime: 0, sit: seatSit(home), fromSit: 0, targetSit: 0, support: home.support ?? null, seatRecovery: null, direction: home.kind === "desk" ? workDirection(home) : 1, toDirection: 1, turn: 0, speed: 0, visible: still ? 1 : 0, homeSeat: actor.seat, rawState: actor.state, lifecycle: actor.lifecycle, waitingPhase: actor.waiting ?? null, mode: activity.mode, needsHelp: activity.needsHelp, raise: still && activity.needsHelp ? 1 : 0, path: null, intent: null, portal: null, departure: null, leaving: false, target: null, spot: null, action: null, afterTurn: null, peerId: null, dwell: 0, visits: 0, queueTime: 0, travelTime: 0, pathDistance: 0, gaitDistance: 0, tangent: { x: 1, y: 0 }, contacts: {}, fromPose: null, lastPose: null, routine: null, routineFrame: null, routineAge: 0, routineVisit: 0, previousRoutine: null, heldProp: null, sipUsed: false, sipBrakeTime: null, resumeTime: null, stop: null, boutFrom: 0, boutSteps: 0, stops: 0, habitUsed: false, release: null, fatigue: 0, cloud: 0 };
        c.phase = basePhase(c);
        colleagues.set(actor.id, c);
      }
      const changed = c.rawState !== actor.state || c.lifecycle !== actor.lifecycle || c.homeSeat !== actor.seat || c.waitingPhase !== (actor.waiting ?? null);
      // A new species (chosen on the card) fades in where the old one was.
      if (c.data.species !== actor.species && !still) c.visible = 0;
      c.data = actor;
      c.homeSeat = actor.seat;
      c.rawState = actor.state;
      c.lifecycle = actor.lifecycle;
      c.waitingPhase = actor.waiting ?? null;
      c.mode = activity.mode;
      c.needsHelp = activity.needsHelp;
      const atWork = c.mode === "work" || c.mode === "dependency-wait";
      // A resting colleague whose seat is a desk (the rest seats are full) never starts there.
      const standing = !atWork && c.waitingPhase === null && RESTING.includes(actor.state) && home.kind === "desk" && (instant || fresh) ? standingSpot(c, spots) : null;
      if (instant || standing !== null) {
        // Settling after (re)connecting: everyone is simply at their seat, or standing in the room.
        clearPlan(c);
        c.portal = null;
        c.departure = null;
        c.phase = basePhase(c);
        c.seatRecovery = null;
        c.heldProp = null;
        c.room = roomOfSeat(home);
        c.x = standing?.x ?? home.x;
        c.y = standing?.y ?? home.y;
        c.sit = standing !== null ? 0 : seatSit(home);
        c.support = standing === null ? (home.support ?? null) : null;
        if (standing === null) c.direction = home.kind === "desk" ? workDirection(home) : home.kind === "wait" ? 1 : c.direction;
      } else if (changed) {
        clearPlan(c);
        c.leaving = false;
        if (atWork || c.mode === "unknown" || actor.state === "error") c.heldProp = null;
        if (atWork && c.portal === null) {
          if (c.room !== "work" || distance(c, home) > 10) startTravel(c, pathFor(c, deskPlace(home), level, "return-work"), "return-work");
          else if (c.direction !== workDirection(home) || Math.abs(c.sit - 0.55) > 0.01) alignWork(c);
          else c.phase = basePhase(c);
        }
      }
      // Given a bench (only opened, or on its way home) a colleague walks there from wherever it is,
      // through the door when it is in the office, and sits facing the front. One going home sits a
      // moment, then walks out of the front door.
      if (home.kind === "wait" && c.waitingPhase !== null && c.departure === null && c.portal === null && c.path === null && c.phase !== "settle" && c.phase !== "stand" && c.phase !== "turn" && c.phase !== "turn-settle" && (c.room !== "waiting" || distance(c, home) > 0.5)) {
        if (still) {
          clearPlan(c);
          c.room = "waiting";
          c.x = home.x;
          c.y = home.y;
          c.sit = 1;
          c.support = home.support ?? null;
          c.direction = 1;
        } else startTravel(c, pathFor(c, benchPlace(home), level, "return-wait"), "return-wait");
      }
      if (home.kind === "wait" && c.waitingPhase === "departure" && c.room === "waiting" && c.departure === null && c.portal === null && c.path === null && c.phase === "rest" && c.sit >= 0.999 && distance(c, home) < 0.5) c.departure = { stage: "wait", age: 0 };
      if (c.departure?.stage === "wait") {
        c.departure.age += step;
        if (c.departure.age >= DEPARTURE_REST_S && !held.has(c.id)) planExit(c, level);
      }
    }
    for (const id of status.released) {
      const c = colleagues.get(id);
      if (c?.action) clearPlan(c);
    }
    for (const c of [...colleagues.values()])
      if (!wanted.has(c.id) || c.mode === "departed" || c.departure?.stage === "gone") {
        resetRoutine(c);
        c.heldProp = null;
        c.visible = still || c.departure?.stage === "gone" ? 0 : Math.max(0, c.visible - dt * FADE_PER_S);
        if (c.visible === 0 && (!wanted.has(c.id) || c.departure?.stage !== "gone")) colleagues.delete(c.id);
      } else c.visible = still ? 1 : Math.min(1, c.visible + dt * FADE_PER_S);

    const active = () => [...colleagues.values()].filter((c) => wanted.has(c.id) && status.assignments.has(c.id) && !finished.has(c.id) && c.portal === null && c.departure === null);
    const currentSpots = new Map([...spots.rest, ...spots.window, ...spots.wander, ...spots.groups.flatMap((g) => g.points)].map((p) => [p.id, p]));
    // Where a paw rests follows the window as the canvas changes its size; the spot before it does not move.
    const sillOf = (place: Place | null) => (place === null ? null : (currentSpots.get(place.id)?.sill ?? place.sill ?? null));
    const cleanPairs = () => {
      for (const c of colleagues.values())
        if (c.peerId !== null) {
          const peer = colleagues.get(c.peerId);
          if (!wanted.has(c.peerId) || !status.assignments.has(c.peerId) || finished.has(c.peerId) || peer?.peerId !== c.id || peer.action !== "chat") finish(c);
        }
    };
    cleanPairs();
    // A place is taken when someone is heading there, standing there, or it is their own rest seat.
    const blocked = (spot: Place, except: Set<string>) => [...colleagues.values()].some((other) => wanted.has(other.id) && !except.has(other.id) && ((other.target !== null && other.target.room === spot.room && distance(spot, other.target) < 125) || (other.path === null && other.room === spot.room && distance(spot, other) < 100) || (homeOf(other).kind !== "desk" && other.homeSeat === spot.id)));
    const assign = (c: Colleague, target: Place) => {
      c.target = target;
      c.dwell = (c.action === "rest" ? 10 : c.action === "chat" ? 8 : 5) + seedUnit(c.id, `dwell:${c.visits}`) * 5;
      c.queueTime = 0;
      if (c.room !== target.room || distance(c, target) >= 0.5) {
        startTravel(c, pathFor(c, target, level, "activity"), "activity");
        return;
      }
      // Already there (its own rest seat again): it settles from where it is, never standing up first.
      resetRoutine(c);
      c.seatRecovery = null;
      c.path = null;
      c.intent = "activity";
      c.fromPose = c.lastPose ?? neutralPose();
      c.fromSit = c.sit;
      c.targetSit = c.action === "rest" ? 1 : 0;
      c.phase = "settle";
      c.phaseTime = 0;
      c.contacts = {};
    };
    for (const c of active()) {
      if (c.action === null) {
        const assignment = status.assignments.get(c.id)!;
        c.action = assignment.kind;
        c.visits = assignment.visit;
        c.queueTime = 0;
      }
      c.queueTime += held.has(c.id) ? 0 : step;
      if (c.target !== null && (!currentSpots.has(c.target.id) || distance(c.target, currentSpots.get(c.target.id)!) > 0.01 || blocked(c.target, new Set([c.id, ...(c.peerId === null ? [] : [c.peerId])])))) {
        if (c.peerId !== null) {
          finish(c);
          continue;
        }
        c.path = null;
        c.target = null;
        c.phase = basePhase(c);
        c.contacts = {};
      }
    }
    const candidates = active().filter((c) => c.target === null && !held.has(c.id));
    for (const c of candidates) {
      if (c.target !== null || finished.has(c.id)) continue;
      if (c.action === "chat") {
        // A conversation needs a free pair of spots and a second colleague who also wants to chat.
        const peer = candidates.find((other) => other !== c && other.target === null && !finished.has(other.id) && other.action === "chat");
        if (peer !== undefined) {
          const except = new Set([c.id, peer.id]);
          const group = [...spots.groups].sort((a, b) => distance(c, a.points[0]) + distance(peer, a.points[1]) - distance(c, b.points[0]) - distance(peer, b.points[1])).find((g) => g.points.every((p) => !blocked(p, except)));
          if (group !== undefined) {
            c.peerId = peer.id;
            peer.peerId = c.id;
            assign(c, group.points[0]);
            assign(peer, group.points[1]);
            continue;
          }
        }
        if (c.queueTime < 2.5) continue;
        c.action = "wander";
      }
      const choices = c.action === "rest" ? spots.rest : c.action === "window" ? spots.window : spots.wander;
      const available = choices.filter((p) => !blocked(p, new Set([c.id]))).sort((a, b) => distance(c, a) - distance(c, b));
      const target = c.action === "wander" ? (available.find((p) => distance(c, p) > 140) ?? available[0]) : available[0];
      if (target !== undefined) assign(c, target);
      else if (c.action !== "wander") {
        c.action = "wander";
        c.queueTime = 0;
      }
    }
    // A room change moves the aisle too, even when the destination stays.
    for (const c of colleagues.values())
      if (wanted.has(c.id) && c.path !== null && c.path.level !== level && c.room === "work") {
        const home = homeOf(c);
        const target = c.portal !== null ? doorPlace("work", "south", level) : c.intent === "return-work" ? deskPlace(home) : c.target;
        if (target !== null) {
          const portal = c.portal;
          startTravel(c, { ...(plannerOf("work", level).route(c, target) ?? makePath([c, target])), level }, c.intent);
          c.portal = portal;
        }
      }
    for (const c of colleagues.values())
      if (wanted.has(c.id) && c.mode !== "departed") {
        // A held colleague keeps its gestures and may finish turning or sitting where it is; it
        // only does not move away.
        c.time += step;
        if (c.routine !== null) c.routineAge += step;
        if (step > 0 && (!held.has(c.id) || IN_PLACE.includes(c.phase) || c.seatRecovery !== null)) advance(c, step);
        if (step > 0 && c.portal !== null && c.portal.stage !== "approach") advancePortal(c, step, level);
        if (step > 0 && c.departure?.stage === "out") {
          c.departure.age += step;
          if (c.departure.age >= DOOR_S) {
            c.departure = { stage: "gone", age: 0 };
            c.phase = "gone";
            resetRoutine(c);
            gone.push(c.id);
          }
        }
      }
    cleanPairs();
    for (const c of active())
      if (c.peerId !== null) {
        const peer = colleagues.get(c.peerId)!;
        if (c.phase === "meeting" && peer.phase === "meeting") {
          face(c, c.x < peer.x ? 1 : -1, "meeting-ready");
          face(peer, peer.x < c.x ? 1 : -1, "meeting-ready");
        }
        if (c.phase === "meeting-ready" && peer.phase === "meeting-ready") {
          c.phase = "chat";
          peer.phase = "chat";
          c.phaseTime = 0;
          peer.phaseTime = 0;
        }
      }
    // Routines start only once a colleague has arrived, faced its place and sat down, and end with
    // the place: at the laptop, a rest seat or a bench, the window, a conversation both have joined, a stop.
    for (const c of colleagues.values()) {
      if (!wanted.has(c.id) || c.mode === "departed") continue;
      const home = homeOf(c);
      const peer = c.peerId === null ? undefined : colleagues.get(c.peerId);
      const onBench = home.kind === "wait" && c.waitingPhase !== null && c.room === "waiting" && c.departure === null;
      // In a long turn the work routines are the tired ones. A session with no signal takes none, even
      // on a bench (where the waiting room seats it as resting): it only stares far off.
      const context: RoutineContext | null =
        c.data.state === "unknown" ? null : c.phase === "work" && distance(c, home) < 0.5 ? (c.data.long === true ? "work-tired" : "work") : c.phase === "rest" && c.sit > 0.7 && (c.spot?.kind === "rest" || home.kind === "rest" || onBench) ? "rest" : c.phase === "window" ? "window" : c.phase === "chat" && peer?.phase === "chat" ? "chat" : c.phase === "sip" || (c.phase === "stop" && c.stop?.stage === "habit") ? "stroll-stop" : null;
      if (context === null) {
        resetRoutine(c);
        continue;
      }
      if (c.routine !== null && c.routine.context !== context) resetRoutine(c);
      if (c.routine !== null && c.routineAge >= c.routine.duration && context !== "stroll-stop") resetRoutine(c);
      // Settled on its own rest seat or bench, a colleague moves in place there without any visit dwell;
      // leaving the seat still waits for scene.wander_after_s.
      const atOwnRestSeat = context === "rest" && c.target === null && (home.kind === "rest" || onBench) && distance(c, home) < 0.5;
      if (c.routine === null && context !== "stroll-stop" && (context === "work" || context === "work-tired" || atOwnRestSeat || c.phaseTime < c.dwell)) enterRoutine(c, context);
      const speaking = context === "chat" && peer !== undefined && Math.floor(c.phaseTime / 2) % 2 === (c.id < peer.id ? 0 : 1);
      c.routineFrame = c.routine === null ? null : sampleRoutine({ kind: c.routine.kind, seed: c.routine.seed, age: c.routineAge, speaking, species: c.data.species });
    }

    // --- what the frame shows (drawn by `paint`) ---------------------------------------------------
    const arch = archAt(layout, cams.work, width);
    const mullions = mullionsAt(layout, cams.work, width);
    const layers: Frame["layers"] = [];
    for (const item of shown.furnishings) {
      const paint = (clip: readonly (readonly [number, number])[] | null = null) => prop(item.kind, item.x, item.y, item.width, wingOpacity(layout, item.wing), clip, item.height ?? null);
      if (item.kind === "coffee") {
        // The rug is floor; the table and the two stools each cover only what is behind them.
        layers.push({ room: "work", z: FLOOR_Z, draw: () => paint() });
        layers.push({ room: "work", z: item.y - 65, draw: () => paint(COFFEE_TABLE) });
        for (const stool of COFFEE_STOOLS) layers.push({ room: "work", z: item.y - 20, draw: () => paint(stool) });
      } else layers.push({ room: "work", z: item.z, draw: () => paint() });
    }
    for (const item of shownWaiting.furnishings) layers.push({ room: "waiting", z: item.z, draw: () => prop(item.kind, item.x, item.y, item.width, waitingRowVisible(waitingLayout, item.waitingRow ?? 0) ? 1 : 0, null, item.height ?? null) });
    // Desks, chairs and work tools are separate pieces, so a working colleague sits on a chair behind
    // the desk top and its paws can go on its tool. A desk's tool is its sitting colleague's: it comes
    // as the colleague sits down and goes as it gets up, walks off or fades, so an empty desk has none.
    const stations = new Map<string, Station>();
    const sitters = new Map<string, Colleague>();
    for (const c of colleagues.values()) {
      const home = homeOf(c);
      if (home.kind === "desk" && c.room === "work" && c.departure?.stage !== "gone" && distance(c, home) < 0.5) sitters.set(home.id, c);
    }
    /** How much of a desk's tool shows (each colleague's drawn opacity is set below, before any layer is drawn). */
    const toolAlpha = new Map<string, number>();
    for (const desk of shown.desks) layers.push({ room: "work", z: desk.y, draw: () => (workstations === null ? prop("desk", desk.x, desk.y, desk.width, wingOpacity(layout, desk.wing)) : workstations.drawDesk(ctx, desk, wingOpacity(layout, desk.wing))) });
    if (workstations !== null)
      for (const seat of shown.seats.filter((s) => s.kind === "desk")) {
        const desk = shown.desks.find((d) => d.id === seat.desk)!;
        const sitter = sitters.get(seat.id);
        const station = workstations.station(seat, H, workDirection(seat), sitter === undefined ? "laptop" : TOOL_OF[sitter.data.species], sitter?.data.species);
        stations.set(seat.id, station);
        layers.push({ room: "work", z: station.chair.ground.y, draw: () => workstations!.drawChair(ctx, station, wingOpacity(layout, seat.wing)) });
        layers.push({ room: "work", z: desk.y + 0.2, draw: () => workstations!.drawTool(ctx, station, (toolAlpha.get(seat.id) ?? 0) * wingOpacity(layout, seat.wing)) });
      }
    const boxes: ActorBox[] = [];
    let walking = 0;
    for (const c of colleagues.values()) {
      const cam = c.room === "waiting" ? cams.waiting : cams.work;
      if (cam === null || c.departure?.stage === "gone") continue;
      const actor = c.data;
      const home = homeOf(c);
      const h = heightOf(actor.species);
      const walkingNow = c.phase === "travel" && c.path !== null;
      const peer = c.peerId === null ? undefined : colleagues.get(c.peerId);
      const conversation = c.phase === "chat" && peer?.phase === "chat";
      // Paws go on the keys only once it sits at its own laptop; on the way it is not typing.
      const workingPose = c.phase === "work" && distance(c, home) < 0.5 && c.room === "work";
      let behavior: Behavior = workingPose ? "work" : c.mode === "work" ? "wait" : c.phase === "window" ? "window" : conversation ? "chat" : c.needsHelp ? "help" : c.mode === "unknown" ? "unknown" : c.phase === "loiter" || c.phase === "meeting" || c.phase === "meeting-ready" ? "look" : "rest";
      if (walkingNow) behavior = "walk";
      const speaking = conversation && peer !== undefined && Math.floor(c.phaseTime / 2) % 2 === (c.id < peer.id ? 0 : 1);
      const temperament = TEMPERAMENTS[actor.species];
      // A walk with a destination leans toward it in long steps; a stroll ambles upright in short ones.
      const gait = purposeful(c.intent) ? temperament.purpose : temperament.stroll;
      let pose = samplePose({ time: c.time, seed: c.id, behavior, speaking, distance: c.gaitDistance, movement: walkingNow ? clamp(c.speed / SPEED) : 1, gait });
      // A routine replaces the behaviour's upper-body motion; the feet stay as they are. One cut short
      // (a new turn, a state change) fades out instead, while the new plan already runs.
      if (c.release !== null && (step === 0 || c.routineFrame !== null)) c.release = null;
      let routine = c.routineFrame;
      if (c.routineFrame !== null) for (const key of UPPER_BODY) pose[key] = 0;
      else if (c.release !== null) {
        const hold = 1 - ease(c.release.age / ROUTINE_RELEASE_S), frame = c.release.frame;
        for (const key of UPPER_BODY) pose[key] *= 1 - hold;
        const poseDelta = { ...frame.poseDelta };
        for (const key of UPPER_BODY) poseDelta[key] *= hold;
        // A carried cup lowers with the releasing arm. A plan that removes the
        // cup still removes it immediately; releasing must never resurrect it.
        const prop = frame.prop?.kind === "cup"
          ? c.heldProp === "cup" ? { ...frame.prop, lift: frame.prop.lift * hold, tilt: frame.prop.tilt * hold } : null
          : frame.prop;
        routine = { ...frame, poseDelta, handMix: frame.handMix * hold, progress: Math.max(frame.progress, 1 - 0.12 * hold), prop };
        c.release.age += step;
        if (c.release.age >= ROUTINE_RELEASE_S) c.release = null;
      }
      if (c.phase === "stop" && c.stop?.stage === "look") {
        // Looking about on a stroll; a colleague holding its paw up looks ahead instead of turning to the viewer.
        const glance = survey(actor.species, c.phaseTime, !c.needsHelp);
        pose.headAngle += glance.headAngle;
        pose.lookX += glance.lookX;
      }
      // A long turn keeps its authored body posture. A readable speech bubble
      // outside the character carries fatigue; the face remains its normal one.
      const tiredTo = actor.long === true && workingPose ? 1 : 0;
      c.fatigue = step === 0 ? tiredTo : tiredTo > c.fatigue ? Math.min(tiredTo, c.fatigue + step / FATIGUE_S) : Math.max(tiredTo, c.fatigue - step / FATIGUE_S);
      const fatigue = ease(c.fatigue);
      if (fatigue > 0) {
        const t = temperament.tired;
        pose.bodyAngle += t.body * fatigue;
        pose.headAngle += t.head * fatigue;
        pose.headY += t.drop * fatigue;
        pose.bodyY += t.sink * fatigue;
      }
      // A colleague that needs the owner holds a paw up wherever it stands or sits, a still pose rather
      // than a signal in motion, and lowers it to walk; a still scene shows it at once.
      const raiseTo = c.needsHelp && !walkingNow ? 1 : 0;
      c.raise = step === 0 ? raiseTo : raiseTo > c.raise ? Math.min(raiseTo, c.raise + step / RAISE_S) : Math.max(raiseTo, c.raise - step / RAISE_S);
      if (walkingNow) {
        walking++;
        rigs?.projectGait(pose, actor.species, c.tangent, c.direction);
        for (const key of ["nearFoot", "farFoot"] as const) {
          // A planted paw stays where it touched the floor while the body moves over it.
          const foot = pose[key];
          const hip = rigs === null ? 0 : rigs.footBase(actor.species, key === "nearFoot" ? "nearLeg" : "farLeg") / 110;
          if (rigs === null) {
            const along = foot.x;
            foot.x = (along * c.tangent.x) / c.direction;
            foot.groundY = along * c.tangent.y;
          }
          if (foot.stance) {
            const contact = (c.contacts[key] ??= { x: c.x + c.direction * (hip + foot.x) * h, y: c.y + (foot.groundY ?? 0) * h });
            foot.x = (contact.x - c.x) / (h * c.direction) - hip;
            foot.groundY = (contact.y - c.y) / h;
          } else delete c.contacts[key];
        }
      } else if (c.phase === "stand") {
        const duration = supportDuration(c.support, 0.7);
        const prepared = samplePose({ time: c.time, seed: c.id, behavior: "walk", distance: c.gaitDistance, movement: 0, gait });
        if (rigs !== null) rigs.projectGait(prepared, actor.species, c.tangent, c.direction);
        else for (const key of ["nearFoot", "farFoot"] as const) {
          const along = prepared[key].x;
          prepared[key].x = (along * c.tangent.x) / c.direction;
          prepared[key].groundY = along * c.tangent.y;
        }
        placeFeet(pose, c.fromPose ?? neutralPose(), prepared, c.phaseTime / duration, 0.025);
      } else if (c.phase === "turn") pose = neutralPose();
      else if (c.phase === "turn-settle") placeFeet(pose, c.fromPose ?? neutralPose(), neutralPose(), c.phaseTime / 0.35, 0.018);
      else if (c.phase === "settle" || c.phase === "align-stand") {
        const duration = supportDuration(c.support, 0.55);
        placeFeet(pose, c.fromPose ?? neutralPose(), neutralPose(), c.phaseTime / duration, 0.025);
      } else if (c.phase === "sip-settle" || c.phase === "stop-settle") placeFeet(pose, c.fromPose ?? neutralPose(), neutralPose(), c.phaseTime / 0.55, 0.025);
      else if (c.phase === "portal" || c.phase === "exit") pose = neutralPose();
      // No signal: still where it stays or sits (a bench seats it as resting), eyes open and gone far off
      // (never asleep), the arms loose; nothing breathes or blinks. On its way to the bench it walks like
      // anyone, feet planted.
      const blank = actor.state === "unknown" && (c.phase === "stay" || c.phase === "rest") && c.path === null;
      if (blank) {
        const b = temperament.blank;
        pose = neutralPose();
        pose.headAngle = b.head;
        pose.lookX = b.look;
        pose.bodyAngle = b.body;
        pose.nearArmAngle = b.arms;
        pose.farArmAngle = b.arms * 0.8;
      }
      const cloudTo = blank ? 1 : 0;
      c.cloud = step === 0 ? cloudTo : cloudTo > c.cloud ? Math.min(1, c.cloud + step / CLOUD_IN_S) : Math.max(0, c.cloud - step / CLOUD_OUT_S);
      c.lastPose = pose;
      const zone = c.room === "work" ? wingOpacity(layout, home.kind === "wait" ? 0 : home.wing) : 1;
      // Through a door: fading out at one side, in at the other; out of the front door: fading away.
      const doorAlpha = c.portal === null || c.portal.stage === "approach" ? 1 : c.portal.stage === "out" ? 1 - ease(c.portal.age / DOOR_S) : ease(c.portal.age / DOOR_S);
      const exitAlpha = c.departure?.stage === "out" ? 1 - ease(c.departure.age / DOOR_S) : 1;
      const visibleAlpha = ease((zone - 0.2) / 0.8) * c.visible * doorAlpha * exitAlpha;
      // A session with no signal is drawn in full: its blank stare and empty cloud (with the "?" marker)
      // say it now; a fade made that face unreadable. Other faded figures (a scheduled task's stand-in) stay faded.
      const alpha = visibleAlpha * (actor.faded && actor.state !== "unknown" ? 0.55 : 1);
      if (sitters.get(home.id) === c) toolAlpha.set(home.id, ease(c.sit / seatSit(home)) * alpha);
      const atDesk = home.kind === "desk" && c.room === "work" && distance(c, home) <= 8;
      const { origin, scale } = cam;
      const screenX = origin.x + c.x * scale;
      const screenY = origin.y + c.y * scale;
      const headWidth = Math.max(23, h * 0.56 * scale);
      const hitHeight = atDesk ? h * 0.54 * scale : h * 0.92 * scale;
      const box: ActorBox | null = alpha > 0.08 && wanted.has(c.id) && c.mode !== "departed" ? { id: c.id, room: c.room, left: screenX - headWidth / 2, top: screenY - h * scale, width: headWidth, height: hitHeight, anchorX: screenX, anchorY: origin.y + (c.y - h - 8) * scale, walking: walkingNow, routine: c.routineFrame?.kind ?? null } : null;
      if (box !== null) boxes.push(box);
      const station = workingPose ? stations.get(home.id) : undefined;
      // A physical seat outlasts the work state. Keep its placement through
      // settle/stand, including a reassignment to a rest seat while getting up.
      const physicalDesk = c.room === "work" && c.sit > 0 && c.support === null
        ? shown.seats.find(seat => seat.kind === "desk" && distance(c, seat) < .5)
        : undefined;
      const deskSeat = physicalDesk === undefined || workstations === null ? null : workstations.station(physicalDesk, H, workDirection(physicalDesk), TOOL_OF[actor.species], actor.species);
      const face = cloudTo === 1 ? "blank" : null;
      const options: Figure = { h, x: c.x, y: c.y, pose, direction: c.direction, turn: c.turn, sit: c.sit, work: behavior === "work", alpha, shadow: !atDesk, routine, heldProp: c.heldProp, reserveNearHand: c.needsHelp, raisedHand: ease(c.raise), support: c.support, deskSeat, windowSill: c.phase === "window" ? sillOf(c.target) ?? sillOf(c.spot) : null, workstation: station === undefined ? null : { ...station, contactMix: ease(c.phaseTime / 0.8) }, face, shoulderDrop: temperament.tired.shoulder * fatigue };
      // The name, markers and hit area share the body's seated translation.
      if (box !== null) {
        const offset = placement(actor, options);
        box.left += offset.x * scale;
        box.anchorX += offset.x * scale;
        box.top += offset.y * scale;
        box.anchorY += offset.y * scale;
      }
      const desk = home.kind === "desk" ? shown.desks.find((d) => d.id === home.desk) : undefined;
      if (station !== undefined && desk !== undefined) {
        // At the laptop: chair, body, desk, note and laptop, the paws on the keys, the lid over them.
        layers.push({ room: "work", z: station.chair.ground.y + 0.1, draw: () => figure(actor, { ...options, layer: "body" }) });
        layers.push({ room: "work", z: desk.y + 0.3, draw: () => figure(actor, { ...options, layer: "hands", shadow: false }) });
        layers.push({ room: "work", z: desk.y + 0.4, draw: () => workstations?.drawLid(ctx, station, alpha * wingOpacity(layout, desk.wing)) });
      } else {
        const glowing = needsYouGlow && c.needsHelp;
        const thought = c.cloud, drift = still ? 0 : Math.sin(c.time * 0.35);
        layers.push({
          room: c.room,
          z: c.y,
          draw: () => {
            const drawn = glowing ? glowingFigure(actor, options) : figure(actor, options);
            if (thought > 0) thoughtCloud(drawn.visualX, drawn.visualY, h, c.direction, thought, visibleAlpha, drift);
          },
        });
      }
      // A laptop is on for the whole turn, as long as it is there (while its colleague sits at it); a paper tool has no light.
      const lit = (c.mode === "work" || c.mode === "dependency-wait") && desk !== undefined ? stations.get(home.id) : undefined;
      if (lit !== undefined && lit.tool === "laptop" && desk !== undefined) {
        const lightTime = c.time;
        layers.push({ room: "work", z: desk.y + 0.5, draw: () => laptopLight(lit, lightTime, (toolAlpha.get(home.id) ?? 0) * wingOpacity(layout, desk.wing)) });
      }
    }
    layers.sort((a, b) => a.z - b.z);
    frame = { cams, layout, waitingLayout, arch, mullions, sky, layers };
    lastStats = { weather: sky.to, level: layout.level, layout, scale: cams.work.scale, origin: cams.work.origin, wall: cams.work.wall, mount: cams.work.mount, arch, waiting: cams.waiting === null ? null : { ...cams.waiting, layout: waitingLayout, rows: waitingLayout.rows }, actors: boxes, walking, gone, art: artState };
    return lastStats;
  }

  /** Draws the frame `step` last worked out: the rooms' walls and floors, the window over them, then every piece and figure from the back to the front. */
  function paint(): void {
    if (frame === null || !width || !height) return;
    const { cams, layout, waitingLayout, arch, mullions, sky: shownSky, layers } = frame;
    const dpr = canvas.width / width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const inRoom = (target: CanvasRenderingContext2D, name: RoomName, work: () => void) => {
      const cam = name === "waiting" ? cams.waiting : cams.work;
      if (cam === null) return;
      target.save();
      target.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.origin.x, dpr * cam.origin.y);
      work();
      target.restore();
    };
    /** Both rooms' walls and floors into `target`, with the painter of that canvas; the window over the office's walls, so its frame finishes the opening along the side walls' edges. */
    const rooms = (target: CanvasRenderingContext2D, plate: typeof roomPlate) => {
      inRoom(target, "work", () => {
        plate(workSurface(layout), cams.work.wall);
        if (art === null) plainArch(arch, mullions);
        else art.windows.draw(target, arch, mullions, shownSky);
      });
      inRoom(target, "waiting", () => plate(waitingSurface(waitingLayout)));
    };
    if (art === null) rooms(ctx, roomPlate);
    else {
      const key = JSON.stringify([canvas.width, canvas.height, width, height, cams, layout.left, layout.right, layout.height, waitingLayout.left, waitingLayout.right, waitingLayout.height, arch, mullions, art.windows.scenery(), shownSky]);
      if (backdrop?.key !== key && key === lastBackdropKey) keepBackdrop(key, rooms);
      lastBackdropKey = key;
      if (backdrop?.key === key) {
        // The kept canvas has the scene's size and was drawn with the same transforms, so this is a copy pixel by pixel.
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(backdrop.layer, 0, 0);
        ctx.restore();
      } else rooms(ctx, roomPlate);
    }
    for (const name of ["work", "waiting"] as const) inRoom(ctx, name, () => layers.filter((layer) => layer.room === name).forEach((layer) => layer.draw()));
  }

  /** Draws the walls, floors and window on the canvas they are kept on (`rooms` draws them into a context with its painter), to be copied from there while `key` holds. */
  function keepBackdrop(key: string, rooms: (target: CanvasRenderingContext2D, plate: typeof roomPlate) => void): void {
    if (backdrop === null) {
      const layer = document.createElement("canvas");
      const maybe = layer.getContext("2d");
      if (maybe === null) throw new Error("Canvas 2D is not available");
      backdrop = { layer, ctx: maybe, roomPlate: createScenePainter(maybe, painterState).roomPlate, key: null };
    }
    const { layer, ctx: kept } = backdrop;
    // Not kept for anything until it is drawn in full.
    backdrop.key = null;
    if (layer.width !== canvas.width || layer.height !== canvas.height) {
      layer.width = canvas.width;
      layer.height = canvas.height;
    } else {
      kept.setTransform(1, 0, 0, 1, 0, 0);
      kept.clearRect(0, 0, layer.width, layer.height);
    }
    kept.imageSmoothingEnabled = true;
    kept.imageSmoothingQuality = "high";
    rooms(kept, backdrop.roomPlate);
    backdrop.key = key;
  }

  /** One frame of a scene on screen: `step`, then `paint`. */
  function draw(time: number, cast: readonly SceneActor[], level: number, options: DrawOptions): SceneStats | null {
    const stats = step(time, cast, level, options);
    if (stats !== null) paint();
    return stats;
  }

  const portraitPose = neutralPose();
  resize();
  return {
    ready,
    resize,
    step,
    paint,
    draw,
    stats: () => lastStats,
    /** What the windows look out on (windows.ts); kept until the art is ready. */
    setScenery(next: Scenery): void {
      scenery = next;
      art?.windows.setScenery(next);
    },
    scenery: () => scenery,
    /** A portrait image URL for the list and cards, or null until the art is ready. */
    portrait: (species: Species, identity: Identity) => (rigs === null ? null : rigs.portrait(species, identity, portraitPose)),
  };
}
