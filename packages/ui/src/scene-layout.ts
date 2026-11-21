// The office scene's pure geometry: where activities go in a room (placesFor), the two rooms'
// cameras in a canvas with how the walls and the window are drawn in them (cameras, archAt) and how
// feet move between two poses (placeFeet). No canvas here.
import { distance, ease } from "./colleague-motion.ts";
import type { Place, Places } from "./colleague-motion.ts";
import type { Foot, Pose } from "./motion.ts";
import { plannerFor } from "./paths.ts";
import type { Point } from "./paths.ts";
import { archSpan, conversationX, geometry, GUEST_SEATS, plateMap, REAR_WALL_TOP, roomAt, SIDE_WALL, sourceYAt, viewPairs, WAITING_TOP, waitingGeometry, WINDOW_HEIGHT, workSurface } from "./space.ts";
import type { ArchSpan, Geometry, Layout } from "./space.ts";

/** A room point p is at origin + p × scale in canvas CSS pixels. */
export type Camera = { origin: { x: number; y: number }; scale: number };
/**
 * The office's camera and how its walls are drawn in it: `wall` is the side walls' factor (space.ts,
 * plateMap), `mount` the share of its face the board and the rewards hang at, `window.height` the unit
 * the window's height is measured in (room units; the arch rises ARCH_RISE of it).
 */
export type OfficeCamera = Camera & { wall: number; mount: number; window: { height: number } };
type Room = ReturnType<typeof roomAt>;

/** Moves both feet from one pose to another, one after the other, the lifted one first. */
export function placeFeet(pose: Pose, from: Pose, to: Pose, progress: number, height: number): void {
  const order: ("nearFoot" | "farFoot")[] = from.farFoot.lift > from.nearFoot.lift ? ["farFoot", "nearFoot"] : ["nearFoot", "farFoot"];
  for (const [index, key] of order.entries()) {
    const t = ease(progress * 2 - index);
    const a = from[key];
    const b = to[key];
    const foot: Foot = { x: a.x + (b.x - a.x) * t, groundY: (a.groundY ?? 0) + ((b.groundY ?? 0) - (a.groundY ?? 0)) * t, lift: a.lift + (b.lift - a.lift) * t + height * Math.sin(Math.PI * t) ** 2, angle: a.angle + (b.angle - a.angle) * t };
    pose[key] = foot;
  }
}

/** The places activities go to: rest seats and guest seats, window spots, conversation pairs, strolling spots — each where a body stands clear of the furniture. All in the office. */
export function placesFor(room: Room, level: number, span: ArchSpan = archSpan(workSurface(geometry(level)))): Places {
  const bounds = geometry(level);
  const planner = plannerFor(level);
  const used: Point[] = [];
  const take = (p: Point) => {
    if (!planner.isFree(p) || used.some((q) => distance(p, q) < 120)) return false;
    used.push(p);
    return true;
  };
  const rest: Place[] = [...room.seats, ...GUEST_SEATS].filter((s) => s.kind === "rest").map((s) => ({ ...s, room: "work" as const, kind: "rest" as const }));
  for (const p of rest) used.push(p);
  const window: Place[] = [];
  const groups: Places["groups"] = [];
  // The aisle between the desks and the lounge, in the core and in the wings.
  const aisle = (wing: number) => (wing === 0 ? 745 : 945);
  // Pairs of spots before the window, spread evenly along its glass, each pair looking in at its middle
  // with a paw on the low wall's top line, where the glass stands: as close to the rear wall as the
  // floor allows, so the paw reaches it.
  const pairs = viewPairs(bounds);
  for (let i = 0; i < pairs; i++) {
    const middle = span.left.x + ((span.right.x - span.left.x) * (i + 0.5)) / pairs;
    for (const side of [-1, 1]) {
      const spot = { x: middle + side * 75, y: 360 };
      if (take(spot)) window.push({ id: `window:${i}:${side}`, ...spot, room: "work", kind: "window", wing: 0, lookDir: -side, sill: { x: spot.x - side * 64, y: span.base } });
    }
  }
  for (let wing = 0; wing <= level; wing++) {
    const cx = conversationX(wing);
    const pair: [Place, Place] = [{ id: `chat:${wing}:left`, x: cx - 80, y: aisle(wing), room: "work", kind: "chat", wing }, { id: `chat:${wing}:right`, x: cx + 80, y: aisle(wing), room: "work", kind: "chat", wing }];
    if (pair.every((p) => planner.isFree(p) && !used.some((q) => distance(p, q) < 120))) {
      used.push(...pair);
      groups.push({ id: `conversation:${wing}`, points: pair });
    }
  }
  const wander: Place[] = [];
  for (const y of level === 0 ? [aisle(0)] : [aisle(0), aisle(1)])
    for (let x = bounds.left + 140, i = 0; x <= bounds.right - 140; x += 160, i++) if (take({ x, y })) wander.push({ id: `stroll:${y}:${i}`, x, y, room: "work", kind: "wander", wing: 0 });
  return { rest, window, wander, groups };
}

const PADDING = 28;
const GAP = 36;
/** With the waiting room below it the office's view starts at least this high (room units); alone, at 0. */
const WORK_TOP = -95;
/** The side walls are drawn at least 15 % larger than the picture (the art run's wall-layout study, 2026-11-05) … */
const WALL_MIN = 1.15;
/** … and together take at most this share of the canvas's width, so a narrow canvas gets a smaller board rather than a smaller room. */
const WALL_SHARE = 0.27;
/** The highest point of a side wall's outline (source pixels of the office picture, room-v4.png). */
const SIDE_TOP = [339, 130] as const;
/** The arched window's crown above the low wall's top line, in window heights (the design handoff 2026-11-05-arch-window). */
const ARCH_RISE = 1.3;
/** Kept clear above the window and the side walls: 12 CSS pixels (zoomed with the office beside a larger waiting room), at most 100 room units (on a tiny canvas). */
const headroom = (scale: number, zoom: number) => Math.min((12 * zoom) / scale, 100);

/** The largest x in (0, hi] with grows(x) ≤ budget, for `grows` increasing. */
function largest(hi: number, budget: number, grows: (x: number) => number): number {
  if (grows(hi) <= budget) return hi;
  let lo = 0;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (grows(mid) <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** How the office fits beside a waiting room: the waiting room's factor, and the share of the canvas's width and the height (CSS pixels) the office may take. */
type Fit = { zoom: number; share: number; room: number };

/**
 * Both rooms' cameras with the side walls `screenWall` CSS pixels per room unit on screen (never less
 * than their smallest factor) and the window's height unit `windowHeight(scale)` room units. With the waiting room
 * and no `fit`, both shrink by one factor when together they are taller than the canvas.
 */
function frame(width: number, height: number, layout: Geometry, waiting: Geometry | null, screenWall: number, windowHeight: (scale: number) => number, fit?: Fit): { work: Camera & { wall: number }; waiting: Camera | null; zoom: number; room: number } {
  const available = width - PADDING * 2;
  const across = layout.right - layout.left;
  // The side walls take their own width on screen; the rest of the room shares what is left.
  const wideIn = (room: number) => Math.min(room / (across + 2 * SIDE_WALL * (WALL_MIN - 1)), (room - 2 * SIDE_WALL * screenWall) / (across - 2 * SIDE_WALL));
  const wide = wideIn(available);
  const surface = workSurface(layout);
  const rearTop = sourceYAt(surface, REAR_WALL_TOP);
  const wallAt = (scale: number) => Math.max(WALL_MIN, screenWall / scale);
  // The view reaches up to the window's crown and the side walls' highest plaster.
  const clear = fit?.share ?? 1;
  const top = (scale: number, start: number) => Math.min(start, rearTop - ARCH_RISE * windowHeight(scale) - headroom(scale, clear), plateMap(surface, wallAt(scale))(...SIDE_TOP).y - headroom(scale, clear));
  const centre = (layout.left + layout.right) / 2;
  if (waiting === null) {
    const span = (scale: number) => layout.height + 50 - top(scale, 0);
    const scale = largest(wide, height - 60, (s) => s * span(s));
    return { work: { origin: { x: width / 2 - centre * scale, y: (height - span(scale) * scale) / 2 + 18 - top(scale, 0) * scale }, scale, wall: wallAt(scale) }, waiting: null, zoom: 1, room: height - 60 };
  }
  const waitWide = available / (waiting.right - waiting.left);
  const workWorld = (scale: number) => layout.height - top(scale, WORK_TOP);
  const waitWorld = waiting.height - WAITING_TOP;
  const budget = height - PADDING * 2 - GAP;
  const shrink = fit?.zoom ?? largest(1, budget, (f) => f * wide * workWorld(f * wide) + f * waitWide * waitWorld);
  const waitScale = shrink * waitWide;
  const room = budget - waitWorld * waitScale;
  const workScale = largest(fit === undefined ? shrink * wide : wideIn(fit.share * available), Math.min(room, fit?.room ?? room), (s) => s * workWorld(s));
  const workHeight = workWorld(workScale) * workScale;
  const spare = Math.max(0, room - workHeight) / 2;
  const start = PADDING + spare;
  return {
    work: { origin: { x: width / 2 - centre * workScale, y: start - top(workScale, WORK_TOP) * workScale }, scale: workScale, wall: wallAt(workScale) },
    waiting: { origin: { x: width / 2 - ((waiting.left + waiting.right) * waitScale) / 2, y: start + workHeight + GAP - WAITING_TOP * waitScale }, scale: waitScale },
    zoom: shrink,
    room,
  };
}

/**
 * The two rooms' cameras in a canvas of `width` × `height` CSS pixels: the office above, the waiting
 * room below it. Without the waiting room the office alone fills the canvas as before.
 *
 * With it, the waiting room's scale is set by the smallest office (no wing, one bench row): both as
 * wide as they may be, shrunk by one factor when together they are taller than the canvas. The office
 * growing never changes it; the office takes the canvas's width and the height left beside a one-row
 * waiting room. A larger waiting room zooms the whole office out by as much as the waiting room
 * shrinks, board and windows included, so the office keeps its proportions.
 *
 * The board, the rewards and the windows keep their size on screen while the office grows: it is the
 * size the smallest office has on this canvas beside this waiting room, so only the canvas and the
 * waiting room change it. The side walls are drawn that much larger as the camera shrinks (`wall`); on
 * a narrow canvas they take at most 27 % of its width (beside a one-row waiting room, and zoomed with a
 * larger one) and the board hangs smaller on them (`mount`). The window's height unit is 208 room
 * units in the smallest room.
 *
 * `covered`: how far down the canvas the page's header over it reaches (CSS pixels). Where it reaches
 * past the top margin, both rooms are fitted to the canvas below it, so the header never sits on the
 * window's crown or the side walls.
 */
export function cameras(width: number, height: number, layout: Geometry, waiting: Geometry | null, covered = 0): { work: OfficeCamera; waiting: Camera | null } {
  const drop = Math.max(0, covered - PADDING);
  if (drop === 0) return fitted(width, height, layout, waiting);
  const { work, waiting: below } = fitted(width, height - drop, layout, waiting);
  const lower = <C extends Camera>(cam: C): C => ({ ...cam, origin: { x: cam.origin.x, y: cam.origin.y + drop } });
  return { work: lower(work), waiting: below === null ? null : lower(below) };
}
function fitted(width: number, height: number, layout: Geometry, waiting: Geometry | null): { work: OfficeCamera; waiting: Camera | null } {
  const oneRow = frame(width, height, geometry(0), waiting === null ? null : waitingGeometry(1), 0, () => WINDOW_HEIGHT);
  const base = waiting === null ? oneRow : frame(width, height, geometry(0), waiting, 0, () => WINDOW_HEIGHT);
  const share = base.zoom / oneRow.zoom;
  const smallest = base.work.scale;
  const screenWall = Math.min(WALL_MIN * smallest, (WALL_SHARE * share * (width - PADDING * 2)) / (2 * SIDE_WALL));
  const windowHeight = WINDOW_HEIGHT * smallest;
  const { work, waiting: below } = frame(width, height, layout, waiting, screenWall, (s) => windowHeight / s, { zoom: base.zoom, share, room: share * oneRow.room });
  return { work: { ...work, mount: screenWall / (work.scale * work.wall), window: { height: windowHeight / work.scale } }, waiting: below };
}

/**
 * The office's window as drawn (room units): one arched opening filling the rear wall from the inner
 * edge of one high side wall to the other's (space.ts, ARCH_ENDS, where the side walls are drawn in
 * this camera), standing on the low wall's top line (`base`). Its sides rise straight from the line to
 * the ends, where the arch springs: the upper half of an ellipse through both ends and the crown,
 * `rx` × `ry`, sheared by `slope` since the ends are not quite level, so it leaves the sides without a
 * bend. The crown is ARCH_RISE window heights above the line — one height on screen whatever the room's
 * size, so a wider room has a flatter arch. Its frame (`rim` wide) is as thick on screen at every room
 * size: 0.6 % of the canvas's width, 2.4 to 6 CSS pixels.
 */
export type Arch = ArchSpan & { cx: number; cy: number; rx: number; ry: number; slope: number; crown: number; rim: number; scale: number };
export function archAt(layout: Geometry, camera: OfficeCamera, canvasWidth: number): Arch {
  const span = archSpan(workSurface(layout), camera.wall);
  const { left, right, base } = span;
  const crown = base - ARCH_RISE * camera.window.height;
  const cx = (left.x + right.x) / 2;
  const cy = (left.y + right.y) / 2;
  const rim = Math.max(2.4, Math.min(6, canvasWidth * 0.006)) / camera.scale;
  const arch = { ...span, cx, cy, rx: (right.x - left.x) / 2, ry: cy - crown, slope: (right.y - left.y) / (right.x - left.x), crown, rim, scale: camera.scale };
  if (!(arch.rx > 0 && arch.ry > 0 && Number.isFinite(rim))) throw new Error("The window needs a positive span, rise and camera scale");
  return arch;
}
/** The arch's frame line at x (room units), between its ends. */
export const archTop = (a: Arch, x: number) => a.cy + a.slope * (x - a.cx) - a.ry * Math.sqrt(Math.max(0, 1 - ((x - a.cx) / a.rx) ** 2));
/** About how wide a pane is, as a share of the arch's height (the wall's top line to the crown): small panes, as in a cottage window. */
const PANE = 0.62;
/** How many equal panes the arch's bars divide it into: as many as fit at about PANE of its height, at least two. */
export const paneCount = (a: Arch) => Math.max(2, Math.round((a.right.x - a.left.x) / (PANE * (a.base - a.crown))));
/** A vertical bar of the window (room units across), with its opacity while the room's size changes. */
export type Mullion = { x: number; alpha: number };
/**
 * The window's vertical bars: they divide the opening into equal panes, about one size on screen at
 * every room size, so a wider window has more of them. While the room grows or shrinks the bars move
 * with its sides; if the pane count changes on the way, the old bars fade out as the new ones fade in.
 */
export function mullionsAt(layout: Layout, camera: OfficeCamera, canvasWidth: number): Mullion[] {
  const arch = archAt(layout, camera, canvasWidth);
  const bars = (count: number, alpha: number) => Array.from({ length: count - 1 }, (_, k) => ({ x: arch.left.x + ((arch.right.x - arch.left.x) * (k + 1)) / count, alpha }));
  const from = paneCount(archAt(layout.from, camera, canvasWidth));
  const to = paneCount(archAt(layout.to, camera, canvasWidth));
  if (from === to || !layout.transitioning) return bars(layout.transitioning ? to : paneCount(arch), 1);
  return [...bars(from, 1 - layout.progress), ...bars(to, layout.progress)].filter((m) => m.alpha > 0);
}
/**
 * Where the view's picture (`width` × `height`) lies behind the window (room units): as large as it
 * must be to cover the opening, never stretched or repeated, centred across and 54 % of the way down
 * (the handoff's focus), so it changes smoothly as the room widens.
 */
export function viewRect(a: Arch, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const across = a.right.x - a.left.x;
  const tall = a.base - a.crown;
  const fit = Math.max(across / width, tall / height);
  return { x: a.cx - (width * fit) / 2, y: a.crown + tall * 0.54 - height * fit * 0.54, width: width * fit, height: height * fit };
}
/** A part of a view's picture that must show whole in one pane, as fractions of the picture. */
export type PaneKeep = { left: number; right: number; top: number; bottom: number };
/**
 * Where the view lies when `keep` (the moon of the weather pictures) must show whole between two bars,
 * clear of the frame (the handoff's weather-framing.mjs): `viewRect`'s place when it already does;
 * otherwise the picture slides across within the opening and grows only as much as it must, stays
 * 54 % of the way down where it can, and keeps 2 CSS pixels clear of the painted frame. The same for
 * every weather of a view, so changing the weather never moves the hills or the horizon.
 */
export function paneViewRect(a: Arch, mullions: readonly Mullion[], normal: { x: number; y: number; width: number; height: number }, keep: PaneKeep): { x: number; y: number; width: number; height: number } {
  const left = a.left.x;
  const right = a.right.x;
  const pad = (a.rim + 1.4 / a.scale) / 2 + 2 / a.scale;
  const edges = [left, ...mullions.filter((m) => m.alpha > 0).map((m) => m.x).sort((p, q) => p - q), right];
  let best: { width: number; x: number; travel: number } | null = null;
  for (let i = 1; i < edges.length; i++) {
    const start = edges[i - 1]! + pad;
    const end = edges[i]! - pad;
    const width = Math.max(normal.width, (start - left) / keep.left, (right - end) / (1 - keep.right));
    const low = Math.max(right - width, start - keep.left * width);
    const high = Math.min(left, end - keep.right * width);
    if (low > high + 1e-7) continue;
    const centred = a.cx - width / 2;
    const x = Math.max(low, Math.min(centred, high));
    const travel = Math.abs(x - centred);
    if (best === null || width < best.width || (width === best.width && travel < best.travel)) best = { width, x, travel };
  }
  if (best === null) return normal;
  const { width, x } = best;
  const height = (normal.height * width) / normal.width;
  const ceiling = Math.max(archTop(a, x + keep.left * width), archTop(a, x + keep.right * width)) + pad;
  const low = Math.max(a.base - height, ceiling - keep.top * height);
  const high = Math.min(a.crown, a.base - pad - keep.bottom * height);
  const focus = a.crown + (a.base - a.crown - height) * 0.54;
  return { x, y: low <= high ? Math.max(low, Math.min(focus, high)) : normal.y, width, height };
}
