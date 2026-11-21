// The office and how it grows, and the waiting room below it. The office is the art run's study (two
// desks for two, a sofa and a coffee corner); wings open on alternating sides, west first, each with
// two desks for two, a coffee corner for two and plants, so work seats, rest seats and greenery grow
// together and nothing is stretched (the art run's flow-life-v5 room, 2026-10-31). The window belongs
// to the rear wall, not to a wing: one arch from side wall to side wall, wider as the room widens. The
// waiting room is a separate room an aisle below the office, joined by a door in the office's front
// wall and a door in its own back wall; its own front door leads out. It holds benches in rows of two,
// four seats a row, and grows downwards by rows. World coordinates of a seat never change once its
// wing or row exists. Each room has its own outline and coordinates; the gap between them is not
// floor (the scene carries a colleague from door to door). Pure: time comes in as `dt`.

export type SeatKind = "desk" | "rest" | "wait";
export type RoomName = "work" | "waiting";
/**
 * Where a seated body rests: the cushion point of a sofa, stool or bench, painted on its furniture. The
 * seat itself (`x`, `y`) is the floor point a colleague walks to; the body is drawn lifted onto `support`.
 */
export type Support = { x: number; y: number; furniture: Furnishing };
/** A desk seat faces its desk's centre (`direction` +1 right, -1 left); a rest or waiting seat has its cushion. */
export type Seat = { id: string; x: number; y: number; kind: SeatKind; desk: string | null; wing: number; direction?: number; support?: Support; waitingRow?: number };
export type Desk = { id: string; x: number; y: number; width: number; wing: number };
export type FurnishingKind = "plant" | "shelf" | "coffee" | "sofa" | "bench" | "coat-rack";
/** `height` overrides the picture's proportion (the sofa is drawn lower); `waitingRow` puts it in the waiting room. */
export type Furnishing = { kind: FurnishingKind; x: number; y: number; width: number; z: number; wing: number; height?: number; waitingRow?: number };

/** The room a seat is in. */
export const roomOfSeat = (seat: Seat): RoomName => (seat.kind === "wait" ? "waiting" : "work");

// --- the art ---------------------------------------------------------------------------------------
/** The folder of the cozy v4 art (the art run's flow-board-v4, 2026-11-05): wall, furniture, desk, views, tools, wall objects. */
export const COZY = "assets-cozy-v4";

// --- the office --------------------------------------------------------------------------------------
const CORE_HALF = 750;
const FIRST_WING = 300;
const WING_STEP = 440;
const GROW_DELAY_S = 0.75;
const SHRINK_DELAY_S = 6;
const TRANSITION_S = 3;
/** Desk seats sit this far either side of their desk's centre, behind it, facing it. */
const SEAT_FROM_CENTRE = 94;
const SEAT_BEHIND = 90;

/** Wing k (1-based) is the n-th wing on its side; odd wings open to the west. */
export function wingSide(k: number): { side: -1 | 1; n: number } {
  return { side: k % 2 === 1 ? -1 : 1, n: Math.ceil(k / 2) };
}

/** World width added on one side by its first `n` wings. */
export function sideWidth(n: number): number {
  return n <= 0 ? 0 : FIRST_WING + WING_STEP * (n - 1);
}

// Furniture source rectangles (assets-space/atlas.json, assets-waiting/reception.json) and the cushion
// points measured on them (source pixels): where a body sits on the sofa, the stools and a bench.
const SOURCE = { sofa: { x: 1074, y: 219, width: 443, height: 283 }, coffee: { x: 22, y: 668, width: 609, height: 271 }, bench: { x: 45, y: 487, width: 1075, height: 409 } } as const;
const CUSHIONS = { sofa: { x: 1350, y: 377 }, sofaGuest: { x: 1205, y: 348 }, leftStool: { x: 151, y: 803 }, rightStool: { x: 495, y: 803 }, benchLeft: { x: 340, y: 665 }, benchRight: { x: 824, y: 665 } } as const;
/** How far in front of its furniture's foot a rest seat's floor point is. */
const APPROACH = 24;

function cushion(f: Furnishing, point: { x: number; y: number }): Support {
  const r = SOURCE[f.kind as keyof typeof SOURCE];
  const height = f.height ?? (f.width * r.height) / r.width;
  return { x: f.x - f.width / 2 + ((point.x - r.x) * f.width) / r.width, y: f.y - height + ((point.y - r.y) * height) / r.height, furniture: f };
}
function restSeat(id: string, f: Furnishing, point: { x: number; y: number }, wing: number): Seat {
  const support = cushion(f, point);
  return { id, x: support.x, y: f.y + APPROACH, kind: "rest", desk: null, wing, support };
}
function deskSeats(desk: Desk, name: string): Seat[] {
  // Seat 0 is the outer one on either side of the room.
  const outer = Math.sign(desk.x);
  return [0, 1].map((index) => {
    const side = index === 0 ? outer : -outer;
    return { id: `${name}:${index}`, x: desk.x + side * SEAT_FROM_CENTRE, y: desk.y - SEAT_BEHIND, kind: "desk" as const, desk: desk.id, wing: desk.wing, direction: -side };
  });
}

const CORE_DESKS: Desk[] = [
  { id: "core-a", x: -220, y: 600, width: 410, wing: 0 },
  { id: "core-b", x: 220, y: 600, width: 410, wing: 0 },
];
// The plants and the shelf stand along the back and side walls, clear of the walk beside the desks;
// the lounge is in front, an aisle away from the desks. The sofa is drawn 210 high (lower than its
// picture's proportion) so it sits on the planks like the coffee corner. The shelf and the plant
// behind it stand in the gap between the core's desks and the first east wing's (425 … 620), so the
// wing's desk and its left chair stay clear of them once it opens.
const CORE_FURNISHINGS: Furnishing[] = [
  { kind: "plant", x: -565, y: 460, width: 150, z: 460, wing: 0 },
  { kind: "shelf", x: 522, y: 590, width: 165, z: 590, wing: 0 },
  { kind: "coffee", x: -355, y: 975, width: 390, z: 975, wing: 0 },
  { kind: "sofa", x: 385, y: 980, width: 410, z: 980, wing: 0, height: 210 },
  { kind: "plant", x: 572, y: 460, width: 125, z: 460, wing: 0 },
];
const coreFurnishing = (kind: FurnishingKind) => CORE_FURNISHINGS.find((f) => f.kind === kind)!;
const CORE_SEATS: Seat[] = [
  ...deskSeats(CORE_DESKS[0]!, "core:desk-a"),
  ...deskSeats(CORE_DESKS[1]!, "core:desk-b"),
  restSeat("core:sofa", coreFurnishing("sofa"), CUSHIONS.sofa, 0),
  restSeat("core:coffee", coreFurnishing("coffee"), CUSHIONS.rightStool, 0),
];
/** Places a resting colleague may visit but nobody owns: the coffee corner's other stool, the sofa's other end. */
export const GUEST_SEATS: readonly Seat[] = [restSeat("core:coffee-guest", coreFurnishing("coffee"), CUSHIONS.leftStool, 0), restSeat("core:sofa-guest", coreFurnishing("sofa"), CUSHIONS.sofaGuest, 0)];

export type Wing = { seats: Seat[]; desks: Desk[]; furnishings: Furnishing[] };

/** The seats, desks and furniture of wing k ≥ 1. */
export function wing(k: number): Wing {
  const { side: s, n } = wingSide(k);
  const cx = s * (800 + WING_STEP * (n - 1));
  const name = `${s < 0 ? "w" : "e"}${n}`;
  const desks: Desk[] = [
    { id: `${name}-a`, x: cx, y: 600, width: 360, wing: k },
    { id: `${name}-b`, x: cx, y: 840, width: 360, wing: k },
  ];
  const coffee: Furnishing = { kind: "coffee", x: cx, y: 1150, width: 390, z: 1150, wing: k };
  const seats: Seat[] = desks.flatMap((desk) => deskSeats(desk, `${name}:${desk.id}`));
  seats.sort((a, b) => a.y - b.y || a.x - b.x);
  // The outer stool is seat 0 on either side.
  const [outerStool, innerStool] = s < 0 ? [CUSHIONS.leftStool, CUSHIONS.rightStool] : [CUSHIONS.rightStool, CUSHIONS.leftStool];
  seats.push(restSeat(`${name}:rest:0`, coffee, outerStool, k), restSeat(`${name}:rest:1`, coffee, innerStool, k));
  const furnishings: Furnishing[] = [coffee, { kind: "plant", x: cx, y: 650, width: 100, z: 650, wing: k }];
  // The first wings each have one more piece on the inner side; outer wings put a shelf at their own
  // edge instead, clear of the previous wing's coffee corner.
  if (n === 1) furnishings.push(s < 0 ? { kind: "plant", x: -570, y: 900, width: 110, z: 900, wing: k } : { kind: "shelf", x: 510, y: 880, width: 120, z: 880, wing: k });
  else furnishings.push({ kind: "shelf", x: cx + s * 280, y: 970, width: 110, z: 970, wing: k });
  return { seats, desks, furnishings };
}

/** Where two colleagues of wing k meet to talk on its aisle: the core's middle, or 70 inward of a wing's desks (where its window used to be). */
export function conversationX(k: number): number {
  if (k === 0) return 0;
  const { side: s, n } = wingSide(k);
  return s * (800 + WING_STEP * (n - 1) - 70);
}

const wingCache = new Map<number, Wing>();
const cachedWing = (k: number) => {
  let built = wingCache.get(k);
  if (built === undefined) {
    built = wing(k);
    wingCache.set(k, built);
  }
  return built;
};

/** Everything in the office at `level` (the number of open wings), core first, then wings in order. */
export function roomAt(level: number): { seats: Seat[]; desks: Desk[]; furnishings: Furnishing[] } {
  const seats = [...CORE_SEATS];
  const desks = [...CORE_DESKS];
  const furnishings = [...CORE_FURNISHINGS];
  for (let k = 1; k <= level; k++) {
    const w = cachedWing(k);
    seats.push(...w.seats);
    desks.push(...w.desks);
    furnishings.push(...w.furnishings);
  }
  return { seats, desks, furnishings };
}

// --- the waiting room --------------------------------------------------------------------------------
/** The first bench row's foot line, and the depth each further row adds (room units). */
const WAITING_ROW_Y = 1690;
export const WAITING_ROW_DEPTH = 320;
/** Seats a bench row holds: two benches of two. */
export const WAITING_ROW_SEATS = 4;
type WaitingRow = { seats: Seat[]; furnishings: Furnishing[] };
const waitingRowCache = new Map<number, WaitingRow>();
/** Row `row` (0-based) of the waiting room: two benches either side of the aisle; the first row also has the coat rack and a plant. */
export function waitingRow(row: number): WaitingRow {
  let built = waitingRowCache.get(row);
  if (built !== undefined) return built;
  const y = WAITING_ROW_Y + WAITING_ROW_DEPTH * row;
  const seats: Seat[] = [];
  const furnishings: Furnishing[] = [];
  for (const [side, x] of [-320, 320].entries()) {
    const bench: Furnishing = { kind: "bench", x, y, width: 400, z: y, wing: 0, waitingRow: row };
    furnishings.push(bench);
    for (const [index, point] of [CUSHIONS.benchLeft, CUSHIONS.benchRight].entries()) seats.push({ ...restSeat(`waiting:${row}:${side * 2 + index}`, bench, point, 0), kind: "wait", direction: 1, waitingRow: row });
  }
  if (row === 0) furnishings.push({ kind: "coat-rack", x: -600, y: 1700, width: 90, z: 1700, wing: 0, waitingRow: 0 }, { kind: "plant", x: 600, y: 1700, width: 85, z: 1700, wing: 0, waitingRow: 0 });
  built = { seats, furnishings };
  waitingRowCache.set(row, built);
  return built;
}
/** The waiting room with `rows` bench rows (at least one). */
export function waitingRoom(rows: number): WaitingRow {
  const seats: Seat[] = [];
  const furnishings: Furnishing[] = [];
  for (let row = 0; row < Math.max(1, rows); row++) {
    const built = waitingRow(row);
    seats.push(...built.seats);
    furnishings.push(...built.furnishings);
  }
  return { seats, furnishings };
}

/** Seat by id, whichever wing or bench row it belongs to; undefined for an id no layout has. */
export function seatById(id: string): Seat | undefined {
  const core = CORE_SEATS.find((seat) => seat.id === id);
  if (core) return core;
  const waiting = /^waiting:(\d+):[0-3]$/.exec(id);
  if (waiting !== null) {
    const row = Number(waiting[1]);
    return Number.isSafeInteger(row) ? waitingRow(row).seats.find((seat) => seat.id === id) : undefined;
  }
  const match = /^([we])(\d+):/.exec(id);
  if (match === null) return undefined;
  const n = Number(match[2]);
  if (!Number.isInteger(n) || n < 1) return undefined;
  const k = match[1] === "w" ? 2 * n - 1 : 2 * n;
  return cachedWing(k).seats.find((seat) => seat.id === id);
}

export const capacity = (level: number) => ({ desk: 4 + 4 * level, rest: 2 + 2 * level });

// --- room outlines -----------------------------------------------------------------------------------
export type Geometry = { left: number; right: number; height: number };
/** A room's outline with which room it is: the office's changes with its wings, the waiting room's with its rows. */
export type Surface = Geometry & { room: RoomName };

// A side with open wings draws its wall 80 beyond them, plus up to 100 more as its first wing opens,
// so the diagonal end wall (and what hangs on it) stays clear of the outermost window as in the study.
const drawnSpan = (span: number) => span + 80 + 100 * Math.min(1, span / FIRST_WING);
/** The inverse of `drawnSpan`: how far the wings on a side reach, from how far its wall is out. */
const wingSpan = (drawn: number) => (drawn - 80 <= 400 ? (drawn - 80) * 0.75 : drawn - 180);

/** The office's outline at `level`: the floor is 300 deeper than the study's first room, to hold the lounge. */
export function geometry(level: number): Geometry {
  return { left: -CORE_HALF - drawnSpan(sideWidth(Math.ceil(level / 2))), right: CORE_HALF + drawnSpan(sideWidth(Math.floor(level / 2))), height: (level === 0 ? 1000 : 1180) + 300 };
}
export const workSurface = (layout: Geometry): Surface => ({ left: layout.left, right: layout.right, height: layout.height, room: "work" });

/** The waiting room's outline below the office: as wide as the core room, deeper by a bench row at a time. */
export const WAITING_BASE_HEIGHT = 1990;
export function waitingGeometry(rows: number): Geometry {
  return { left: -830, right: 830, height: WAITING_BASE_HEIGHT + WAITING_ROW_DEPTH * (Math.max(1, rows) - 1) };
}
export const waitingSurface = (layout: Geometry): Surface => ({ left: layout.left, right: layout.right, height: layout.height, room: "waiting" });
/** How many rows a waiting-room outline holds (fractional while it grows). */
export const waitingRowsOf = (layout: Geometry) => 1 + (layout.height - WAITING_BASE_HEIGHT) / WAITING_ROW_DEPTH;
/** Whether row `row` is on the drawn floor of `layout`. */
export const waitingRowVisible = (layout: Geometry, row: number) => waitingRowsOf(layout) >= row + 1 - 0.01;
/** The waiting room's world y where its camera starts: the top of its back wall. */
export const WAITING_TOP = 1230;

// The room plates are the two wall pictures (assets-walls/plaster-south-v2.png for the office,
// plaster-two-doors-v3.png for the waiting room, both 1774 × 887) cut into slices: six columns (the
// outer ones and the door's 320 wide middle keep their drawn width; the two between them stretch
// with the room) and five rows. The rear wall, the corner curves and the front wall keep the outer
// side's pixel scale; only the straight middle band of planks absorbs added depth, and it is drawn
// as staggered plank tiles rather than stretched. Rows 492–494 meet the side rim's vertical tangent
// in both pictures.
//
// The office's two side walls (the outer columns: the diagonal plaster walls with the board and the
// rewards) can be drawn larger than the rest, by a factor `wall` about their inner edge: outwards, and
// upwards from a straight line just under the boards' faces (`sideBase`), blending back to the rear
// wall's scale between columns 360 and 390. The camera picks the factor so they keep their size on
// screen while the room grows (scene-layout.ts, the art run's wall-layout study of 2026-11-05). What
// lies under the line — the skirting, the floor, the corner where the side wall meets the rear wall —
// stays as the picture draws it, only widened, so the rear wall's skirting runs straight on into the
// side walls'; the wall's slopes flatten as it widens, as in the art run's flow-board-v4. Colleagues
// walk the picture's floor at its own scale (walkingFloor), so the wider strip is never walked on.
export const SHELL = { width: 1774, height: 887 };
/** A side wall's drawn width at its own scale (room units): the picture's outer 22 %. */
export const SIDE_WALL = 320;
/**
 * The source row a side wall drawn larger grows upward from, at source column `local` counted from
 * its outer edge (either wall): a straight line at the wall's slope 4 rows under the boards' faces
 * (wall-mount.ts), above the whole skirting and every floor point colleagues walk on, so a face stays
 * flat on its wall while it grows and nothing below the line moves.
 */
export const sideBase = (local: number) => 441.26 - (local * 101.05) / 215;
/** From this source column inward (and its mirror) a side wall drawn larger blends back to the rear wall's scale. */
export const SIDE_BLEND = 360;
const SHELL_SCALE = SIDE_WALL / (SHELL.width * 0.22);
const SOURCE_COLUMNS = [0, 0.22, 730 / 1774, 1044 / 1774, 0.78, 1];
const SOURCE_ROWS = [120 / 887, 0.36, 492 / 887, 494 / 887, 0.73, 0.875];
const DOOR_HALF = 160;
export type Slices = {
  columns: { source: number[]; target: number[] };
  rows: { source: number[]; target: number[] };
  /** The band of plain planks (row index), its tile height in room units, and the tile's source rows (fractions of the picture). */
  floorTileRow: number;
  floorTileHeight: number;
  floorTileSource: [number, number];
};

/** Where the picture's source columns and rows land in `surface` (room units). */
export function shellSlices(surface: Surface): Slices {
  const back = surface.room === "waiting" ? 1390 : 300;
  const s = SOURCE_ROWS as [number, number, number, number, number, number];
  const unit = SHELL.height * SHELL_SCALE;
  const centre = (surface.left + surface.right) / 2;
  return {
    columns: { source: SOURCE_COLUMNS.map((v) => v * SHELL.width), target: [surface.left, surface.left + SIDE_WALL, centre - DOOR_HALF, centre + DOOR_HALF, surface.right - SIDE_WALL, surface.right] },
    rows: { source: SOURCE_ROWS.map((v) => v * SHELL.height), target: [back + (s[0] - s[1]) * unit, back, back + (s[2] - s[1]) * unit, surface.height - (s[5] - s[3]) * unit, surface.height - (s[5] - s[4]) * unit, surface.height] },
    floorTileRow: 2,
    floorTileHeight: 74 * SHELL_SCALE,
    floorTileSource: [438 / 887, 512 / 887],
  };
}

function piecewise(value: number, source: readonly number[], target: readonly number[]): number {
  let i = 0;
  while (i < source.length - 2 && value > source[i + 1]!) i++;
  return target[i]! + ((value - source[i]!) / (source[i + 1]! - source[i]!)) * (target[i + 1]! - target[i]!);
}
/** The room y of a picture row `sourceY` (source pixels) in `surface`. */
export const sourceYAt = (surface: Surface, sourceY: number) => {
  const { rows } = shellSlices(surface);
  return piecewise(sourceY, rows.source, rows.target);
};
/**
 * Where the picture's pixels land in `surface` (room units) with its side walls drawn `wall` times
 * their own scale (1 in the waiting room and wherever colleagues walk); also where what hangs on the
 * walls goes.
 */
export function plateMap(surface: Surface, wall = 1): (sx: number, sy: number) => { x: number; y: number } {
  const { columns, rows } = shellSlices(surface);
  const extra = SIDE_WALL * (wall - 1);
  const west = columns.source[1]!;
  const east = columns.source[4]!;
  return (sx, sy) => {
    const x = sx <= west ? mix(surface.left - extra, columns.target[1]!, sx / west) : sx >= east ? mix(columns.target[4]!, surface.right + extra, (sx - east) / (SHELL.width - east)) : piecewise(sx, columns.source, columns.target);
    let y = piecewise(sy, rows.source, rows.target);
    const local = sx < west ? sx : SHELL.width - sx;
    if (wall !== 1 && (sx < west || sx > east) && sy < sideBase(local)) {
      const pivot = piecewise(sideBase(local), rows.source, rows.target);
      const blend = Math.max(0, Math.min(1, (west - local) / (west - SIDE_BLEND)));
      y = pivot + (y - pivot) * (1 + (wall - 1) * blend);
    }
    return { x, y };
  };
}

// --- the window on the rear wall -------------------------------------------------------------------
/** The top line of the office's low rear wall (source row of the office picture, its opaque plaster): the window's glass stands on it. */
export const REAR_WALL_TOP = 227;
/** The unit the window's height is measured in, where the room is at its smallest (room units): the art run's window at its 0.44 scale (flow-board-v4, 2026-11-05). */
export const WINDOW_HEIGHT = 208;
/**
 * Where the arched window springs from the high side walls (source pixels of room-v4.png): the inner
 * edges of their opaque shoulders, measured on the picture (the design handoff 2026-11-05-arch-window),
 * a pixel or two inside the outlined edge, so the window's frame rising from the low wall there lies
 * on the edge and covers its outline.
 */
export const ARCH_ENDS = { left: [368, 148], right: [1404, 145] } as const;
/** The arch's ends and the low wall's top line under its glass (room units), its side walls drawn `wall` times their scale (plateMap). */
export type ArchSpan = { left: { x: number; y: number }; right: { x: number; y: number }; base: number };
export function archSpan(surface: Surface, wall = 1): ArchSpan {
  const map = plateMap(surface, wall);
  return { left: map(...ARCH_ENDS.left), right: map(...ARCH_ENDS.right), base: sourceYAt(surface, REAR_WALL_TOP) };
}
/** How many wings an office outline has opened (the largest room size it is as wide as). */
function wingsOf(layout: Geometry): number {
  const across = layout.right - layout.left;
  let level = 0;
  while (level < 64 && geometry(level + 1).right - geometry(level + 1).left <= across + 1e-6) level++;
  return level;
}
/** How many pairs of places to look out from an office outline has: one more for every second wing (one, two from one wing, three from three, four from five), as many as the row of windows had. */
export const viewPairs = (layout: Geometry) => 1 + Math.ceil(wingsOf(layout) / 2);

export type Door = { room: RoomName; side: "north" | "south"; x: number; front: number; base: number; threshold: number; left: number; right: number; approach: { x: number; y: number } };
/**
 * A room's door: the office's is in its front wall; the waiting room has one in its back wall (to the
 * office) and one in its front wall (out). `approach` is the floor point a colleague walks to before
 * passing through; `threshold` the end of its floor in the opening.
 */
export function roomDoor(surface: Surface, side: "north" | "south" = surface.room === "waiting" ? "north" : "south"): Door {
  const x = (surface.left + surface.right) / 2;
  if (side === "north") {
    const front = sourceYAt(surface, 354);
    const threshold = front - 34;
    return { room: surface.room, side, x, front, base: front, threshold, left: x - 125, right: x + 125, approach: { x, y: threshold + 34 } };
  }
  const front = sourceYAt(surface, 594);
  return { room: surface.room, side, x, front, base: sourceYAt(surface, 755), threshold: sourceYAt(surface, 724), left: x - 130, right: x + 130, approach: { x, y: sourceYAt(surface, 724) - 34 } };
}

// The plank surface of the pictures (source pixels, inside the rim; from the art run's flow-life-v5
// navigation). Its front scallop moves sideways as wings open, so the front is capped by a straight
// line behind every scallop.
const SOURCE_FLOOR: readonly [number, number][] = [[110, 465], [150, 430], [185, 410], [230, 390], [280, 375], [330, 362], [390, 354], [1385, 354], [1450, 365], [1485, 375], [1540, 395], [1575, 414], [1610, 435], [1650, 470], [1670, 502], [1645, 538], [1590, 574], [1485, 608], [1380, 630], [1260, 632], [1120, 613], [1000, 595], [880, 594], [760, 602], [650, 625], [510, 632], [380, 630], [260, 605], [170, 570], [115, 530], [98, 500]];
const FRONT_CAP = 594;
const WALKING_FLOOR: [number, number][] = [];
for (const [i, a] of SOURCE_FLOOR.entries()) {
  const b = SOURCE_FLOOR[(i + 1) % SOURCE_FLOOR.length]!;
  if (a[1] <= FRONT_CAP) WALKING_FLOOR.push(a);
  if ((a[1] < FRONT_CAP && b[1] > FRONT_CAP) || (a[1] > FRONT_CAP && b[1] < FRONT_CAP)) WALKING_FLOOR.push([a[0] + ((b[0] - a[0]) * (FRONT_CAP - a[1])) / (b[1] - a[1]), FRONT_CAP]);
}
type Point = { x: number; y: number };
const EPS = 1e-7;
/** The floor polygon projected the way the picture is drawn: an edge crossing a slice boundary bends there too. */
function projectedFloor(surface: Surface): Point[] {
  const { columns, rows } = shellSlices(surface);
  const split: [number, number][] = [];
  for (const [i, a] of WALKING_FLOOR.entries()) {
    const b = WALKING_FLOOR[(i + 1) % WALKING_FLOOR.length]!;
    const ts = [0];
    for (const [axis, cuts] of [[0, columns.source], [1, rows.source]] as const)
      if (b[axis] !== a[axis])
        for (const cut of cuts) {
          const t = (cut - a[axis]) / (b[axis] - a[axis]);
          if (t > 1e-9 && t < 1 - 1e-9) ts.push(t);
        }
    for (const t of [...new Set(ts)].sort((p, q) => p - q)) split.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return split.map(([x, y]) => ({ x: piecewise(x, columns.source, columns.target), y: piecewise(y, rows.source, rows.target) }));
}
/** Cuts the door's opening into the straight edge at `y`, so the polygon runs out through it. */
function openDoor(polygon: Point[], y: number, left: number, right: number): Point[] {
  const expanded: Point[] = [];
  for (const [i, a] of polygon.entries()) {
    const b = polygon[(i + 1) % polygon.length]!;
    expanded.push(a);
    if (Math.abs(a.y - y) > EPS || Math.abs(b.y - y) > EPS || Math.abs(a.x - b.x) < EPS) continue;
    const cuts = [left, right].map((x) => ({ x, y, t: (x - a.x) / (b.x - a.x) })).filter((p) => p.t > EPS && p.t < 1 - EPS).sort((p, q) => p.t - q.t);
    expanded.push(...cuts.map(({ x, y: cy }) => ({ x, y: cy })));
  }
  const first = expanded.findIndex((p) => Math.abs(p.x - left) < EPS && Math.abs(p.y - y) < EPS);
  const last = expanded.findIndex((p) => Math.abs(p.x - right) < EPS && Math.abs(p.y - y) < EPS);
  if (first < 0 || last < 0) throw new Error("The doorway must fit the room's straight edge");
  const trace = (step: number) => {
    const result: Point[] = [];
    for (let i = first; ; i = (i + step + expanded.length) % expanded.length) {
      result.push(expanded[i]!);
      if (i === last) break;
    }
    return result;
  };
  const forward = trace(1);
  return forward.some((p) => Math.abs(p.y - y) > EPS) ? forward : trace(-1);
}
/**
 * The floor colleagues may stand on in a room, as a polygon in room units: the planks, running out
 * through each door's opening to its threshold.
 */
export function walkingFloor(surface: Surface): Point[] {
  let floor = projectedFloor(surface);
  const south = roomDoor(surface, "south");
  const cap = Math.max(...floor.map((p) => p.y));
  floor = [...openDoor(floor, cap, south.left, south.right), { x: south.right, y: south.threshold }, { x: south.left, y: south.threshold }];
  if (surface.room === "waiting") {
    const north = roomDoor(surface, "north");
    const top = Math.min(...floor.map((p) => p.y));
    floor = [...openDoor(floor, top, north.left, north.right), { x: north.right, y: north.threshold }, { x: north.left, y: north.threshold }];
  }
  return floor;
}

export type Footprint = { id: string; x: number; y: number; width: number; height: number };
/**
 * Where furniture meets the floor (room units): what walking colleagues keep clear of. A plant's
 * footprint is as wide as its leaves; a coffee corner is its table and two stools, its rug is floor.
 */
export function footprints(room: { desks: readonly Desk[]; furnishings: readonly Furnishing[] }): Footprint[] {
  const out: Footprint[] = [];
  const add = (id: string, x: number, y: number, width: number, height: number) => out.push({ id, x, y, width, height });
  for (const d of room.desks) add(`desk:${d.id}`, d.x - d.width * 0.46, d.y - 64, d.width * 0.92, 62);
  for (const f of room.furnishings) {
    const id = `${f.kind}:${f.wing}:${f.x}:${f.y}`;
    if (f.kind === "coffee") {
      add(`${id}:table`, f.x - 96, f.y - 98, 184, 36);
      add(`${id}:left`, f.x - 162, f.y - 61, 104, 50);
      add(`${id}:right`, f.x + 53, f.y - 63, 104, 50);
    } else if (f.kind === "sofa") add(id, f.x - f.width * 0.44, f.y - 90, f.width * 0.88, 85);
    else if (f.kind === "bench") add(id, f.x - f.width * 0.48, f.y - 65, f.width * 0.96, 65);
    else if (f.kind === "coat-rack") add(id, f.x - f.width * 0.475, f.y - 40, f.width * 0.95, 40);
    else if (f.kind === "plant") add(id, f.x - f.width * 0.47, f.y - 45, f.width * 0.94, 43);
    else if (f.kind === "shelf") add(id, f.x - f.width * 0.43, f.y - 43, f.width * 0.86, 41);
  }
  return out;
}

/** `from` and `to`: the outlines of the transition in progress (both the current one when settled); `progress` how far it is (eased, 0 … 1). */
export type Layout = Geometry & { level: number; wanted: number; transitioning: boolean; pendingShrink: boolean; from: Geometry; to: Geometry; progress: number };

/** How visible wing k is in `layout` (0 closed … 1 open), from how far its side has opened. */
export function wingOpacity(layout: Geometry, k: number): number {
  if (k === 0) return 1;
  const { side, n } = wingSide(k);
  const width = wingSpan(side < 0 ? -CORE_HALF - layout.left : layout.right - CORE_HALF);
  const before = sideWidth(n - 1);
  return Math.max(0, Math.min(1, (width - before) / (sideWidth(n) - before)));
}

const ease = (x: number) => x * x * (3 - 2 * x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The office's animated outline. Growing waits 0.75 s and shrinking 6 s before a 3 s transition
 * (the study's values); a target that changes mid-way continues from what is drawn. `instant`
 * (paused, reduced motion) jumps to the target.
 */
export function createSpace(initialLevel = 0) {
  checkLevel(initialLevel);
  let level = initialLevel;
  let wanted = initialLevel;
  let pending = 0;
  let elapsed = TRANSITION_S;
  let current: Geometry = geometry(level);
  let from: Geometry = { ...current };
  let to: Geometry = { ...current };
  const advance = (dt: number) => {
    elapsed = Math.min(TRANSITION_S, elapsed + dt);
    const t = ease(elapsed / TRANSITION_S);
    current = { left: mix(from.left, to.left, t), right: mix(from.right, to.right, t), height: mix(from.height, to.height, t) };
  };
  const commit = (instant: boolean) => {
    level = wanted;
    from = { ...current };
    to = geometry(level);
    elapsed = instant ? TRANSITION_S : 0;
    pending = 0;
  };
  return {
    update(requested: number, dt: number, { instant = false }: { instant?: boolean } = {}): Layout {
      checkLevel(requested);
      if (!Number.isFinite(dt) || dt < 0) throw new RangeError("Visual delta must be nonnegative");
      if (requested !== wanted) {
        wanted = requested;
        pending = 0;
      }
      if (instant) {
        commit(true);
        advance(0);
      } else if (wanted !== level) {
        const delay = wanted > level ? GROW_DELAY_S : SHRINK_DELAY_S;
        const waiting = Math.min(dt, Math.max(0, delay - pending));
        advance(waiting);
        pending += waiting;
        if (pending >= delay) commit(false);
        advance(dt - waiting);
      } else {
        pending = 0;
        advance(dt);
      }
      const transitioning = elapsed < TRANSITION_S;
      return { ...current, level, wanted, transitioning, pendingShrink: wanted < level, from: transitioning ? { ...from } : { ...current }, to: transitioning ? { ...to } : { ...current }, progress: transitioning ? ease(elapsed / TRANSITION_S) : 1 };
    },
  };
}

/** The waiting room's animated depth: it grows and shrinks by rows at 220 room units a second, never below one row. */
export function createWaitingSpace(initialRows = 1) {
  let height = waitingGeometry(initialRows).height;
  return {
    update(rows: number, dt: number, { instant = false }: { instant?: boolean } = {}): Geometry & { rows: number; transitioning: boolean } {
      if (!Number.isInteger(rows) || rows < 1) throw new RangeError("Waiting rows must be a positive integer");
      if (!Number.isFinite(dt) || dt < 0) throw new RangeError("Visual delta must be nonnegative");
      const target = waitingGeometry(rows).height;
      height = instant ? target : height + Math.sign(target - height) * Math.min(Math.abs(target - height), dt * 220);
      return { ...waitingGeometry(rows), height, rows, transitioning: Math.abs(height - target) > 0.01 };
    },
  };
}

function checkLevel(level: number): void {
  if (!Number.isInteger(level) || level < 0) throw new RangeError("Room level must be a nonnegative integer");
}
