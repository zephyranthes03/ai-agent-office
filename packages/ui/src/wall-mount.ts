// Where the wall objects hang and how they are laid on a wall: the two mounting faces on the room's
// diagonal plaster walls, carried into room units, and the CSS perspective transform (a homography of
// the element's box onto the face, through the scene's camera) that puts an element there. No wall is
// painted. Pure apart from reading the element's size and writing its transform.
import type { SceneStats } from "./scene.ts";
import { plateMap, workSurface } from "./space.ts";

export type Point = { x: number; y: number };
type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number };

/** The perspective map of the unit square onto a convex quadrilateral (corners clockwise from top-left). */
export function homography([p0, p1, p2, p3]: readonly Point[]): Matrix {
  const [a, b, c, d] = [p0!, p1!, p2!, p3!];
  const dx1 = b.x - c.x, dx2 = d.x - c.x, dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y, dy2 = d.y - c.y, dy3 = a.y - b.y + c.y - d.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  return { a: b.x - a.x + g * b.x, b: b.y - a.y + g * b.y, c: d.x - a.x + h * d.x, d: d.y - a.y + h * d.y, e: a.x, f: a.y, g, h };
}
export function project(m: Matrix, u: number, v: number): Point {
  const w = m.g * u + m.h * v + 1;
  return { x: (m.a * u + m.c * v + m.e) / w, y: (m.b * u + m.d * v + m.f) / w };
}
const length = (p: Point, q: Point) => Math.hypot(q.x - p.x, q.y - p.y);

/**
 * The two mounting faces on the diagonal plaster walls (source pixels of room-v4.png): from just
 * beside the step down to the rear wall (12 columns from it, clear of where the wall blends into the
 * rear wall) outward, along the wall's slope (101 rows in 215 columns, as
 * the faces measured in 2026-10, art-preview/assets-space/wall-anchors.json), as large as the plaster
 * holds with 10 rows of it left above and below (measured per column on both walls) — the owner's
 * place for them (2026-11-05): nearer the rear wall, larger, never over the skirting. Mirror images
 * of each other. They are carried into room units the way the picture is drawn, side walls and all
 * (`wall`), so they stay on the wall at every room size; `mount` shrinks a face about its centre (on
 * a narrow canvas).
 */
const ANCHORS = {
  board: [[108, 263.5], [354, 147.88], [354, 270.88], [108, 386.5]],
  rewards: [[1420, 147.88], [1666, 263.5], [1666, 386.5], [1420, 270.88]],
} as const;
export function slots(layout: SceneStats["layout"], { wall, mount }: Pick<SceneStats, "wall" | "mount">): { board: Point[]; rewards: Point[] } {
  const map = plateMap(workSurface(layout), wall);
  const face = (corners: readonly (readonly [number, number])[]) => {
    const cx = corners.reduce((sum, p) => sum + p[0], 0) / corners.length;
    const cy = corners.reduce((sum, p) => sum + p[1], 0) / corners.length;
    return corners.map(([x, y]) => map(cx + (x - cx) * mount, cy + (y - cy) * mount));
  };
  return { board: face(ANCHORS.board), rewards: face(ANCHORS.rewards) };
}

/** Sets `element`'s transform so its untransformed box lies, centred and in proportion, on `wall`. */
export function mount(element: HTMLElement, wall: Point[], stats: SceneStats): void {
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const wallWidth = (length(wall[0]!, wall[1]!) + length(wall[3]!, wall[2]!)) / 2;
  const wallHeight = (length(wall[0]!, wall[3]!) + length(wall[1]!, wall[2]!)) / 2;
  const fit = Math.min(wallWidth / width, wallHeight / height);
  const u0 = (1 - (width * fit) / wallWidth) / 2;
  const v0 = (1 - (height * fit) / wallHeight) / 2;
  const surface = homography(wall);
  const { origin, scale } = stats;
  const corners = ([[u0, v0], [1 - u0, v0], [1 - u0, 1 - v0], [u0, 1 - v0]] as const).map(([u, v]) => {
    const p = project(surface, u, v);
    return { x: origin.x + p.x * scale, y: origin.y + p.y * scale };
  });
  const m = homography(corners);
  const matrix = [m.a / width, m.b / width, 0, m.g / width, m.c / height, m.d / height, 0, m.h / height, 0, 0, 1, 0, m.e, m.f, 0, 1];
  const transform = `matrix3d(${matrix.join(", ")})`;
  if (element.style.transform !== transform) element.style.transform = transform;
}
