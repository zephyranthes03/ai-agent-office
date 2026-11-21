// Walking paths through a room: the shortest way between two places that keeps a walking body clear
// of every piece of furniture and on the floor (the art run's flow-life-v5 clearance, on the product's
// own rooms). The body is an ellipse at the feet, as wide as the widest walking silhouette; a path
// bends only at the corners of furniture grown by that body. Each room (the office at a level, the
// waiting room with its rows) has its own planner; no path crosses between rooms — a colleague walks
// to a door, and the scene carries it to the other room's door. Pure geometry in room units; no
// clocks and no session state.
import { footprints, geometry, roomAt, waitingGeometry, waitingRoom, waitingSurface, walkingFloor, workSurface } from "./space.ts";
import type { Footprint, RoomName } from "./space.ts";

export type Point = { x: number; y: number };
type Segment = { a: Point; b: Point; start: number; size: number; dx: number; dy: number };
export type Path = { points: Point[]; segments: Segment[]; length: number };

/**
 * Half the width and depth of a walking body at the feet. 112 is the widest walking silhouette of the
 * eight species at the scene's character height (220): the fox's tail reaches 111.4 behind its
 * centre, measured from the rig crops (solid bounds of torso, head, arms and legs at their joints).
 */
export const BODY = { rx: 112, ry: 22 };
const EPS = 1e-7;

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

export function makePath(points: readonly Point[]): Path {
  const clean = points.filter((p, i) => i === 0 || dist(p, points[i - 1]!) > 0.1).map((p) => ({ x: p.x, y: p.y }));
  const segments: Segment[] = [];
  let length = 0;
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1]!;
    const b = clean[i]!;
    const size = dist(a, b);
    segments.push({ a, b, start: length, size, dx: (b.x - a.x) / size, dy: (b.y - a.y) / size });
    length += size;
  }
  return { points: clean, segments, length };
}

/** The point `distance` along the path, with the direction of its segment. */
export function pointAt(path: Path, distance: number): Point & { dx: number; dy: number } {
  if (path.segments.length === 0) return { ...path.points[0]!, dx: 1, dy: 0 };
  const segment = path.segments.find((s) => distance <= s.start + s.size) ?? path.segments.at(-1)!;
  const t = Math.max(0, Math.min(1, (distance - segment.start) / segment.size));
  return { x: segment.a.x + (segment.b.x - segment.a.x) * t, y: segment.a.y + (segment.b.y - segment.a.y) * t, dx: segment.dx, dy: segment.dy };
}

// --- clearance in body units: an ellipse of the body becomes a unit circle --------------------------
const scaled = (p: Point): Point => ({ x: p.x / BODY.rx, y: p.y / BODY.ry });
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function pointSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const q = dx * dx + dy * dy;
  const t = q === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / q));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function segmentGap(a: Point, b: Point, c: Point, d: Point): number {
  const x = cross(a, b, c);
  const y = cross(a, b, d);
  const z = cross(c, d, a);
  const w = cross(c, d, b);
  if (((x > 0 && y < 0) || (x < 0 && y > 0)) && ((z > 0 && w < 0) || (z < 0 && w > 0))) return 0;
  return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
}
function inside(p: Point, polygon: readonly Point[]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
const edges = (polygon: readonly Point[]) => polygon.map((p, i) => [p, polygon[(i + 1) % polygon.length]!] as const);
const corners = (r: Footprint): Point[] => [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }];

export type Planner = {
  room: RoomName;
  /** The office's level, or the waiting room's rows. */
  level: number;
  floor: Point[];
  obstacles: Footprint[];
  /** A body standing at `p` is on the floor and clear of all furniture. */
  isFree: (p: Point) => boolean;
  /** Whether a body walking straight from `a` to `b` stays clear. */
  clear: (a: Point, b: Point) => boolean;
  /**
   * The shortest clear way from `from` to `to`. A colleague caught inside a footprint or off the floor
   * (where it stood when the room changed) first walks straight out of it. Null when there is none.
   */
  route: (from: Point, to: Point) => Path | null;
};

const planners = new Map<string, Planner>();

/** Routes in the finished office of `level` (its furniture and its floor). */
export function plannerFor(level: number): Planner {
  const key = `work:${level}`;
  let planner = planners.get(key);
  if (planner === undefined) {
    const room = roomAt(level);
    planner = createPlanner("work", level, walkingFloor(workSurface(geometry(level))), footprints(room));
    planners.set(key, planner);
  }
  return planner;
}

/** Routes in the waiting room with `rows` bench rows: between its benches and its two doors. */
export function waitingPlannerFor(rows: number): Planner {
  const key = `waiting:${rows}`;
  let planner = planners.get(key);
  if (planner === undefined) {
    planner = createPlanner("waiting", rows, walkingFloor(waitingSurface(waitingGeometry(rows))), footprints({ desks: [], furnishings: waitingRoom(rows).furnishings }));
    planners.set(key, planner);
  }
  return planner;
}

function createPlanner(room: RoomName, level: number, floor: Point[], obstacles: Footprint[]): Planner {
  const floorEdges = edges(floor.map(scaled));
  const floorPolygon = floor.map(scaled);
  const shapes = obstacles.map((o) => corners(o).map(scaled));
  const onFloor = (u: Point, v: Point) => inside(u, floorPolygon) && inside(v, floorPolygon) && floorEdges.every(([c, d]) => segmentGap(u, v, c, d) >= 1 - EPS);
  const offFurniture = (u: Point, v: Point, ignored: ReadonlySet<number>) => shapes.every((poly, i) => ignored.has(i) || (!inside(u, poly) && !inside(v, poly) && edges(poly).every(([c, d]) => segmentGap(u, v, c, d) >= 1 - EPS)));
  const clearWith = (a: Point, b: Point, ignored: ReadonlySet<number> = new Set(), ignoreFloor = false) => {
    const u = scaled(a);
    const v = scaled(b);
    return (ignoreFloor || onFloor(u, v)) && offFurniture(u, v, ignored);
  };
  const clear = (a: Point, b: Point) => clearWith(a, b);
  const isFree = (p: Point) => clear(p, p);
  // Way points: every footprint's corners grown by the body, and the floor's corners moved inwards.
  const nodes: Point[] = [];
  for (const o of obstacles)
    for (const x of [o.x - BODY.rx - 1, o.x + o.width + BODY.rx + 1])
      for (const y of [o.y - BODY.ry - 1, o.y + o.height + BODY.ry + 1]) if (isFree({ x, y })) nodes.push({ x, y });
  const cx = floor.reduce((sum, p) => sum + p.x, 0) / floor.length;
  const cy = floor.reduce((sum, p) => sum + p.y, 0) / floor.length;
  for (const p of floor)
    for (let t = 0.05; t < 0.6; t += 0.05) {
      const q = { x: p.x + (cx - p.x) * t, y: p.y + (cy - p.y) * t };
      if (isFree(q)) {
        nodes.push(q);
        break;
      }
    }
  // The doors' openings are narrow: a way point in each, on the room's middle line.
  const xs = floor.map((p) => p.x);
  const middle = (Math.min(...xs) + Math.max(...xs)) / 2;
  const ys = floor.map((p) => p.y);
  for (const y of [Math.min(...ys) + BODY.ry + 1, Math.max(...ys) - BODY.ry - 1]) for (const dy of [0, 40, 80, 120]) {
    const q = { x: middle, y: y + (y < cy ? dy : -dy) };
    if (isFree(q)) {
      nodes.push(q);
      break;
    }
  }
  const links = nodes.map((a) => nodes.map((b, j) => (a !== b && clear(a, b) ? j : -1)).filter((j) => j >= 0));

  /** What a start or end inside a footprint, or off the floor, may ignore on its first or last leg. */
  const escape = (p: Point) => {
    const u = scaled(p);
    const ignored = new Set(shapes.flatMap((poly, i) => (inside(u, poly) || edges(poly).some(([c, d]) => pointSegment(u, c, d) < 1 - EPS) ? [i] : [])));
    return { ignored, ignoreFloor: !onFloor(u, u) };
  };

  function route(from: Point, to: Point): Path | null {
    if (dist(from, to) < EPS) return makePath([from]);
    const start = escape(from);
    const end = escape(to);
    const direct = clearWith(from, to, new Set([...start.ignored, ...end.ignored]), start.ignoreFloor || end.ignoreFloor);
    if (direct) return makePath([from, to]);
    const first = nodes.map((n, i) => (clearWith(from, n, start.ignored, start.ignoreFloor) ? i : -1)).filter((i) => i >= 0);
    const last = new Set(nodes.map((n, i) => (clearWith(n, to, end.ignored, end.ignoreFloor) ? i : -1)).filter((i) => i >= 0));
    // Dijkstra over the way points (a few dozen per room).
    const cost = nodes.map(() => Infinity);
    const previous = nodes.map(() => -1);
    const done = nodes.map(() => false);
    for (const i of first) cost[i] = dist(from, nodes[i]!);
    let best = Infinity;
    let goal = -1;
    for (;;) {
      let i = -1;
      for (let j = 0; j < nodes.length; j++) if (!done[j] && cost[j]! < Infinity && (i < 0 || cost[j]! < cost[i]!)) i = j;
      if (i < 0 || cost[i]! >= best) break;
      done[i] = true;
      if (last.has(i) && cost[i]! + dist(nodes[i]!, to) < best) {
        best = cost[i]! + dist(nodes[i]!, to);
        goal = i;
      }
      for (const j of links[i]!) {
        const next = cost[i]! + dist(nodes[i]!, nodes[j]!);
        if (next < cost[j]!) {
          cost[j] = next;
          previous[j] = i;
        }
      }
    }
    if (goal < 0) return null;
    const chain: Point[] = [];
    for (let i = goal; i >= 0; i = previous[i]!) chain.unshift(nodes[i]!);
    return makePath([from, ...chain, to]);
  }

  return { room, level, floor, obstacles, isFree, clear, route };
}
