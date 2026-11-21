// Office desks, chairs and work tools drawn as separate pieces (the art run's flow-life-v5
// workstation.mjs, with flow-board-v4's tools), so a working colleague sits on a chair behind a thin
// desk top and its paws rest on its tool. Each animal has its own tool, for the look only (nothing is
// told about the session's work): the cat and the fox a laptop, the otter and the hedgehog a
// sketchbook, the bird and the rabbit a notebook, the dog and the panda drawings. A laptop faces its
// colleague and shows the room its matte back lid (back.json: the same crop in a second atlas, same
// keyboard points), never screen contents, with a small flat note beside it; the laptop picture, its
// keyboard points and the paw targets share the inclined base transform; the upright lid,
// occlusion mask and power light share its raised hinge. A paper tool lies flat on the desk top,
// the paws on it and the pen's point on its page. A tool is there only while its colleague sits at the
// desk (scene.ts). Desk and chair are office-v4.png: a cream top with a thin wooden edge on slender
// sage legs (no panel facing the room). Points are room units.
import { loadImage, loadJson } from "./art.ts";
import type { Species } from "./model.ts";
import { COZY } from "./space.ts";
import type { Desk } from "./space.ts";

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Matrix = [number, number, number, number, number, number];
type LaptopStand = {
  ground: Point[];
  top: Point[];
  keyboard: Matrix;
  lidMask: Point[];
  rearLift: number;
  scale: number;
};
type Back = { image: string; rect: Rect };
export type LaptopFrame = { rect: Rect; anchors: { groundBottom: Point }; sourceScreenPolygon: Point[] };
export type OfficeArt = {
  image: string;
  frames: {
    desk: { rect: Rect; displayHeight: number; anchors: { groundBottom: Point }; sourceSurfacePolygon: Point[] };
    chair: { rect: Rect; displayWidth: number; displayHeight: number; anchors: { seat: Point; groundBottom: Point } };
  };
};
export type NoteFrame = { rect: Rect; normalizedAnchors: Record<string, Point> };
/** The measured pieces a station is placed from (parts.json's laptop, office-v2.json, the notepad prop). */
export type StationArt = { laptop: LaptopFrame; office: OfficeArt; note: NoteFrame };

/** The flat note on the desk top: centre, drawn size (lying down) and its anchors, in room units. */
export type Note = { x: number; y: number; width: number; height: number; direction: number; anchors: Record<string, Point> };
/** The chair behind a desk seat: its picture, where a body sits on it and where it stands. */
export type Chair = { sprite: Rect; seat: Point; ground: Point };
export type Tool = "laptop" | "sketch" | "note" | "plans";
/** Each animal's tool (the art run's flow-board-v4): a matter of look, not of what its session does. */
export const TOOL_OF: Record<Species, Tool> = { cat: "laptop", fox: "laptop", otter: "sketch", hedgehog: "sketch", bird: "note", rabbit: "note", dog: "plans", panda: "plans" };
/** One working place: its tool, where the paws go, the laptop and its back-lid light, the note (a paper tool's page) and the chair. */
export type Station = { direction: number; nearHand: Point; farHand: Point; indicator: Point; rearY: number; foregroundY: number; sprite: Rect; screen: Point[]; note: Note; chair: Chair } & (
  | { tool: "laptop"; stand: LaptopStand }
  | { tool: Exclude<Tool, "laptop">; stand: null }
);

export type Workstations = {
  station: (seat: Point, height: number, direction: number, tool?: Tool, species?: Species) => Station;
  drawDesk: (ctx: CanvasRenderingContext2D, desk: Desk, alpha: number) => void;
  drawChair: (ctx: CanvasRenderingContext2D, station: Station, alpha: number) => void;
  /** The tool (the note and the laptop, or a paper tool), under the paws. */
  drawTool: (ctx: CanvasRenderingContext2D, station: Station, alpha: number) => void;
  /** A laptop's upright lid again, over the paws on the keys (nothing for a paper tool). */
  drawLid: (ctx: CanvasRenderingContext2D, station: Station, alpha: number) => void;
};

// Points on visible key rows, left of the screen bezel (source pixels).
const KEYS = { nearHand: { x: 900, y: 478 }, farHand: { x: 975, y: 476 } };
// The small power light on the back lid (source pixels, measured on workstation-back-v1.png).
const INDICATOR = { x: 1158, y: 462 };
// Tools follow the painted desktop's depth when the desk height changes. The
// laptop is 112 wide; the chair remains 6 behind and 24 above the seat point.
const ART_HEIGHT = 220;
const LAPTOP_WIDTH = 112;
const HAND = { ahead: 2, depth: 0.46 };
const NOTE = { behind: 45, depth: 0.30, width: 12, flat: 0.42 };
const CHAIR = { behind: 0, up: 24 };
// Source-art footprint (front-left, rear-left, rear-right, front-right) and the
// full lid including its bezel. The approved stand keeps the front low; the
// fox's shorter reach uses a steeper rear support than the cat's.
const LAPTOP_BASE = [{ x: 810, y: 474 }, { x: 985, y: 550 }, { x: 1192, y: 487 }, { x: 1017, y: 411 }];
const LAPTOP_LID = [{ x: 1000, y: 298 }, { x: 1215, y: 248 }, { x: 1190, y: 493 }, { x: 969, y: 550 }];

function transformPoint([a, b, c, d, e, f]: Matrix, p: Point): Point {
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
}

function placeLaptopStand(project: (p: Point) => Point, scale: number, species?: Species): LaptopStand {
  const footprint = LAPTOP_BASE.map(project), [a, b, , d] = footprint;
  const dx = b!.x - a!.x, dy = b!.y - a!.y, wx = d!.x - a!.x, wy = d!.y - a!.y;
  const det = dx * wy - wx * dy, nx = wy / det, ny = -wx / det;
  const frontLift = 6 * scale, rearLift = (species === "fox" ? 36 : 24) * scale, delta = rearLift - frontLift;
  // The same depth projection tilts the keyboard art and its hand anchors.
  // Working in projected room coordinates also handles the mirrored seat.
  const keyboard: Matrix = [1, -delta * nx, 0, 1 - delta * ny, 0, -frontLift + delta * (nx * a!.x + ny * a!.y)];
  // The folding feet sit inside the upper rails, leaving the full support on
  // the shallow desktop. This does not move the laptop or change its incline.
  const center = { x: footprint.reduce((n, p) => n + p.x, 0) / 4, y: footprint.reduce((n, p) => n + p.y, 0) / 4 };
  const ground = footprint.map(p => ({ x: center.x + (p.x - center.x) * .75, y: center.y + (p.y - center.y) * .75 }));
  return { ground, top: footprint.map(p => transformPoint(keyboard, p)), keyboard, lidMask: LAPTOP_LID.map(project), rearLift, scale };
}
// A paper tool at the art's character height: its page 12 ahead of the seat, 112 × 29 lying
// flat; the pen's point 3 back on it, the near paw 7 back and the far one 22 ahead (flow-board-v4).
const PAPER = { ahead: 18, depth: 0.38, width: 100, height: 20, pen: { back: 25, down: 1 }, near: { back: 29, up: 2 }, far: { ahead: 43, up: 8 } };
/** Where each paper tool is on tools-v4.png (source pixels). */
const TOOL_CROPS: Record<Exclude<Tool, "laptop">, Rect> = { note: { x: 52, y: 104, width: 672, height: 391 }, plans: { x: 834, y: 47, width: 651, height: 443 }, sketch: { x: 48, y: 588, width: 673, height: 391 } };

/** The pure placement of one station: seat point, character height, the direction it faces and its tool. */
export function placeStation(art: StationArt, seat: Point, height: number, direction: number, tool: Tool = "laptop", species?: Species): Station {
  const k = height / ART_HEIGHT;
  const { laptop, office, note: noteFrame } = art;
  const deskFrame = office.frames.desk;
  const sourceDepth = deskFrame.sourceSurfacePolygon.map(p => p.y);
  const rearY = seat.y + (90 + (Math.min(...sourceDepth) - deskFrame.anchors.groundBottom.y) * deskFrame.displayHeight / deskFrame.rect.height) * k;
  const foregroundY = seat.y + (90 + (Math.max(...sourceDepth) - deskFrame.anchors.groundBottom.y) * deskFrame.displayHeight / deskFrame.rect.height) * k;
  const onTop = (depth: number) => rearY + (foregroundY - rearY) * depth;
  const scale = (LAPTOP_WIDTH / laptop.rect.width) * k;
  const anchor = { x: seat.x + HAND.ahead * k * direction, y: onTop(HAND.depth) };
  const project = (p: Point) => ({ x: anchor.x + (p.x - KEYS.nearHand.x) * scale * direction, y: anchor.y + (p.y - KEYS.nearHand.y) * scale });
  const corner = project(laptop.rect);
  const width = NOTE.width * (height / 110);
  const note: Note = { x: seat.x - NOTE.behind * k * direction, y: onTop(NOTE.depth), width, height: ((width * noteFrame.rect.height) / noteFrame.rect.width) * NOTE.flat, direction, anchors: {} };
  for (const [key, a] of Object.entries(noteFrame.normalizedAnchors)) note.anchors[key] = { x: note.x + (a.x - 0.5) * note.width * direction, y: note.y + (a.y - 0.5) * note.height };
  const c = office.frames.chair;
  const cw = c.displayWidth * k;
  const ch = c.displayHeight * k;
  const sitOn = { x: seat.x - CHAIR.behind * k * direction, y: seat.y - CHAIR.up * k };
  const chair: Chair = {
    sprite: { x: sitOn.x - ((c.anchors.seat.x - c.rect.x) * cw * direction) / c.rect.width, y: sitOn.y - ((c.anchors.seat.y - c.rect.y) * ch) / c.rect.height, width: cw, height: ch },
    seat: sitOn,
    ground: { x: sitOn.x + ((c.anchors.groundBottom.x - c.anchors.seat.x) * cw * direction) / c.rect.width, y: sitOn.y + ((c.anchors.groundBottom.y - c.anchors.seat.y) * ch) / c.rect.height },
  };
  const station = { direction, rearY, foregroundY, nearHand: project(KEYS.nearHand), farHand: project(KEYS.farHand), indicator: project(INDICATOR), sprite: { x: corner.x, y: corner.y, width: laptop.rect.width * scale, height: laptop.rect.height * scale }, screen: laptop.sourceScreenPolygon.map(project), note, chair };
  if (tool === "laptop") {
    const stand = placeLaptopStand(project, k, species);
    const raise = (p: Point) => ({ x: p.x, y: p.y - stand.rearLift });
    return { ...station, tool, stand, nearHand: transformPoint(stand.keyboard, station.nearHand), farHand: transformPoint(stand.keyboard, station.farHand), screen: station.screen.map(raise), indicator: raise(station.indicator) };
  }
  // A paper tool lies where the laptop would be; the paws and the pen go on it.
  const page: Note = { x: seat.x + PAPER.ahead * k * direction, y: onTop(PAPER.depth), width: PAPER.width * k, height: PAPER.height * k, direction, anchors: {} };
  page.anchors["writingSurface"] = { x: page.x - PAPER.pen.back * k * direction, y: page.y + PAPER.pen.down * k };
  page.anchors["pageCenter"] = { x: page.x, y: page.y };
  page.anchors["leftGrip"] = { x: page.x-PAPER.far.ahead*k*direction, y:page.y-PAPER.far.up*k };
  page.anchors["rightGrip"] = { x: page.x+PAPER.far.ahead*k*direction, y:page.y-PAPER.far.up*k };
  return { ...station, tool, stand: null, note: page, nearHand: { x: page.x - PAPER.near.back * k * direction, y: page.y - PAPER.near.up * k }, farHand: { x: page.x + PAPER.far.ahead * k * direction, y: page.y - PAPER.far.up * k } };
}

/** Where a desk's picture goes for `desk`: x stretches to the desk's width, the height is the art's. */
function deskPlacement(office: OfficeArt, desk: Desk) {
  const f = office.frames.desk;
  const sx = desk.width / f.rect.width;
  const sy = f.displayHeight / f.rect.height;
  return { sx, sy, x: desk.x - (f.anchors.groundBottom.x - f.rect.x) * sx, y: desk.y - (f.anchors.groundBottom.y - f.rect.y) * sy };
}

/** The desk top as drawn (its four corners, room units): where laptops and notes must lie. */
export function deskTop(office: OfficeArt, desk: Desk): Point[] {
  const f = office.frames.desk;
  const p = deskPlacement(office, desk);
  return f.sourceSurfacePolygon.map((q) => ({ x: p.x + (q.x - f.rect.x) * p.sx, y: p.y + (q.y - f.rect.y) * p.sy }));
}

export async function createWorkstations(): Promise<Workstations> {
  const [atlas, back, office, props, toolImage] = await Promise.all([
    loadJson<{ image: string; frames: { laptop: LaptopFrame } }>("./assets-workstation/parts.json"),
    loadJson<Back>("./assets-workstation/back.json"),
    loadJson<OfficeArt>(`./${COZY}/office.json`),
    loadJson<{ image: string; frames: { notepad: NoteFrame } }>("./assets-interaction/parts.json"),
    loadImage(`./${COZY}/tools-v4.png`),
  ]);
  const [backImage, officeImage, propImage] = await Promise.all([loadImage(`./assets-workstation/${back.image}`), loadImage(`./${COZY}/${office.image}`), loadImage(`./assets-interaction/${props.image}`)]);
  const art: StationArt = { laptop: atlas.frames.laptop, office, note: props.frames.notepad };

  const polygon = (points: readonly Point[]) => {
    const path = new Path2D();
    points.forEach((p, i) => i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y));
    path.closePath();
    return path;
  };

  function drawStand(ctx: CanvasRenderingContext2D, stand: LaptopStand): void {
    const { ground, top, scale } = stand;
    const stroke = (points: Point[], color: string, width: number) => {
      ctx.beginPath();
      points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.strokeStyle = color;ctx.lineWidth = width * scale;
      ctx.lineCap = "round";ctx.lineJoin = "round";ctx.stroke();
    };
    ctx.fillStyle = "rgba(60,67,60,.1)";
    ctx.fill(polygon(ground.map(p => ({ x: p.x, y: p.y + 2 * scale }))));
    for (const [front, back] of [[0, 1], [3, 2]] as const) {
      const foot = ground[front]!, heel = ground[back]!, low = top[front]!, high = top[back]!;
      stroke([foot, heel, high, low], "#747d75", 3.5);
      stroke([low, high], "#b7bdb4", 4.5);
      stroke([low, { x: low.x, y: low.y - 3 * scale }], "#5d6860", 3);
      stroke([{ x: foot.x - 2 * scale, y: foot.y + scale }, { x: foot.x + 2 * scale, y: foot.y + scale }], "#677167", 2.5);
    }
    stroke([ground[1]!, ground[2]!], "#959f92", 2.5);
  }

  function drawLaptop(ctx: CanvasRenderingContext2D, s: Station & { tool: "laptop" }, lidOnly: boolean): void {
    const { stand, sprite, direction } = s, r = back.rect;
    const lid = polygon(stand.lidMask);
    const paint = () => {
      ctx.save();ctx.translate(sprite.x, sprite.y);ctx.scale(direction, 1);
      ctx.drawImage(backImage, r.x, r.y, r.width, r.height, 0, 0, sprite.width, sprite.height);
      ctx.restore();
    };
    if (!lidOnly) {
      // Split the existing artwork into the inclined keyboard and the upright
      // lid. Both passes use the same split, so no flat duplicate is left behind.
      const outside = new Path2D();
      outside.rect(Math.min(sprite.x, sprite.x + sprite.width * direction), sprite.y, sprite.width, sprite.height);
      outside.addPath(lid);
      ctx.save();ctx.transform(...stand.keyboard);ctx.clip(outside, "evenodd");paint();ctx.restore();
    }
    ctx.save();ctx.translate(0, -stand.rearLift);ctx.clip(lid);paint();ctx.restore();
  }

  function drawTool(ctx: CanvasRenderingContext2D, s: Station, alpha: number): void {
    if (alpha <= 0) return;
    const n = s.note;
    if (s.tool !== "laptop") {
      const r = TOOL_CROPS[s.tool];
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(n.x, n.y);
      ctx.scale(n.direction, 1);
      ctx.drawImage(toolImage, r.x, r.y, r.width, r.height, -n.width / 2, -n.height / 2, n.width, n.height);
      ctx.restore();
      return;
    }
    ctx.save();ctx.globalAlpha = alpha;drawStand(ctx, s.stand);ctx.restore();
    const nr = art.note.rect;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(n.x, n.y);
    ctx.scale(n.direction, 1);
    ctx.drawImage(propImage, nr.x, nr.y, nr.width, nr.height, -n.width / 2, -n.height / 2, n.width, n.height);
    ctx.restore();
    ctx.save();ctx.globalAlpha = alpha;drawLaptop(ctx, s, false);ctx.restore();
  }

  function drawLid(ctx: CanvasRenderingContext2D, s: Station, alpha: number): void {
    if (s.tool !== "laptop" || alpha <= 0) return;
    ctx.save();ctx.globalAlpha = alpha;drawLaptop(ctx, s, true);ctx.restore();
  }

  function drawDesk(ctx: CanvasRenderingContext2D, desk: Desk, alpha: number): void {
    const r = office.frames.desk.rect;
    const p = deskPlacement(office, desk);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(officeImage, r.x, r.y, r.width, r.height, p.x, p.y, r.width * p.sx, r.height * p.sy);
    ctx.restore();
  }

  function drawChair(ctx: CanvasRenderingContext2D, s: Station, alpha: number): void {
    const r = office.frames.chair.rect;
    const c = s.chair.sprite;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(c.x, c.y);
    ctx.scale(s.direction, 1);
    ctx.drawImage(officeImage, r.x, r.y, r.width, r.height, 0, 0, c.width, c.height);
    ctx.restore();
  }

  return { station: (seat, height, direction, tool, species) => placeStation(art, seat, height, direction, tool, species), drawDesk, drawChair, drawTool, drawLid };
}
