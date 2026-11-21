// How the office scene paints its parts on the canvas: a room's walls and floor, a piece of furniture,
// a working laptop's light and a colleague's figure (in a warm light while it waits for the owner),
// each from the preview art once it has loaded, or as plain shapes without it (so the scene and its
// markers keep working when the art is missing).
import type { SceneActor } from "./colleague-motion.ts";
import type { Drawn, Rigs } from "./rig.ts";
import type { Arch, Mullion } from "./scene-layout.ts";
import { plateMap, SHELL, shellSlices, SIDE_BLEND, sideBase, sourceYAt } from "./space.ts";
import type { FurnishingKind, Surface } from "./space.ts";
import { strokeArch, traceArch } from "./windows.ts";
import type { Windows } from "./windows.ts";
import type { Station } from "./workstation.ts";

export type Frame = { x: number; y: number; width: number; height: number };
export type SpaceArt = { image: HTMLImageElement; shell: HTMLImageElement; waitingShell: HTMLImageElement; reception: HTMLImageElement; frames: Record<FurnishingKind | "desk", Frame>; windows: Windows };

/** A colleague as `figure` draws it: the rig's options, its height as `h`. */
export type Figure = Omit<Parameters<Rigs["draw"]>[1], "species" | "appearance" | "height"> & { h: number };

/** The painter draws into `ctx` with whatever art and rigs `state` holds at the time of each call. */
export function createScenePainter(ctx: CanvasRenderingContext2D, state: { art: () => SpaceArt | null; rigs: () => Rigs | null }) {
  // A colleague in the warm light is drawn here first, so its rim follows the whole outline; made
  // when the first one needs it.
  let glow: { layer: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  /**
   * A room's plate (walls and floor) from its picture: the rear wall, corner curves and front wall at
   * the picture's own scale, the straight band between as staggered plank tiles, the side walls `wall`
   * times their scale above their base line (space.ts, plateMap); drawn to device-pixel edges so no seam
   * opens between slices.
   */
  function roomPlate(surface: Surface, wall = 1): void {
    const art = state.art();
    const map = plateMap(surface, wall);
    if (art === null) {
      const back = surface.room === "waiting" ? 1390 : 300;
      const left = map(0, 0).x;
      const dw = map(SHELL.width, 0).x - left;
      ctx.fillStyle = "#ece6d4";
      ctx.fillRect(left, back - 170, dw, surface.height - back + 170);
      ctx.fillStyle = "#f6f1e3";
      ctx.fillRect(left, back - 170, dw, 170);
      return;
    }
    const shell = surface.room === "waiting" ? art.waitingShell : art.shell;
    const m = ctx.getTransform();
    const px = (v: number) => (Math.round(v * m.a + m.e) - m.e) / m.a;
    const py = (v: number) => (Math.round(v * m.d + m.f) - m.f) / m.d;
    const patch = (sx: number, sy: number, sw: number, sh: number, x: number, y: number, w: number, h: number) => ctx.drawImage(shell, sx, sy, sw, sh, px(x), py(y), px(x + w) - px(x), py(y + h) - py(y));
    const s = shellSlices(surface);
    // Larger side walls are cut once more where they start to blend into the rear wall.
    const sx = wall === 1 ? s.columns.source : [...s.columns.source, SIDE_BLEND, SHELL.width - SIDE_BLEND].sort((a, b) => a - b);
    const sy = s.rows.source;
    const west = s.columns.source[1]!;
    const east = s.columns.source[4]!;
    const tileRow = s.rows.source[s.floorTileRow]!;
    const [floorStart, floorEnd] = s.floorTileSource.map((v) => v * shell.height) as [number, number];
    // Where a side wall is drawn larger, its picture first goes down flat (only widened), then the part
    // above its base line once more, raised: one sheared copy per cell of the side wall itself, and
    // vertical strips about a device pixel wide where it blends into the rear wall (its height changes
    // across those). The raised copy meets the flat one exactly along the line, so no seam opens there.
    const flatY = (y: number) => sourceYAt(surface, y);
    const rowsA = (flatY(tileRow) - flatY(sy[0]!)) / (tileRow - sy[0]!);
    const rowsB = flatY(sy[0]!) - rowsA * sy[0]!;
    const slope = 101.05 / 215;
    function raisedCell(cellX0: number, cellX1: number, y0: number, y1: number): void {
      const eastSide = cellX0 >= east;
      // Into the blend strips by a pixel and a half, so the device-pixel strips there leave no gap at its edge.
      const x0 = eastSide ? cellX0 - 1.5 : cellX0;
      const x1 = eastSide ? cellX1 : cellX1 + 1.5;
      // The base line as a function of the source column: row = k0 + k1 · x.
      const k1 = eastSide ? slope : -slope;
      const k0 = sideBase(0) - k1 * (eastSide ? SHELL.width : 0);
      const below = (x: number, y: number) => y >= k0 + k1 * x;
      const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      if (corners.every(([x, y]) => below(x, y))) return;
      // The cell's part above the line (the rectangle clipped by it).
      const above: [number, number][] = [];
      for (const [i, p] of corners.entries()) {
        const q = corners[(i + 1) % 4]!;
        if (!below(...p)) above.push(p);
        if (below(...p) !== below(...q)) {
          const fp = p[1] - k0 - k1 * p[0];
          const fq = q[1] - k0 - k1 * q[0];
          const t = fp / (fp - fq);
          above.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
      }
      const ax = (map(x1, y0).x - map(x0, y0).x) / (x1 - x0);
      const bx = map(x0, y0).x - ax * x0;
      ctx.save();
      ctx.transform(ax, (1 - wall) * rowsA * k1, 0, wall * rowsA, bx, rowsB + (1 - wall) * rowsA * k0);
      ctx.beginPath();
      for (const [i, [x, y]] of above.entries()) if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(shell, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    }
    for (let row = 0; row < sy.length - 1; row++)
      for (let col = 0; col < sx.length - 1; col++) {
        const x0 = sx[col]!;
        const x1 = sx[col + 1]!;
        const y0 = sy[row]!;
        const y1 = sy[row + 1]!;
        if (y0 !== tileRow) {
          const side = wall !== 1 && (x1 <= west || x0 >= east);
          if (!side) {
            const corners = [map(x0, y0), map(x1, y0), map(x1, y1), map(x0, y1)] as const;
            patch(x0, y0, x1 - x0, y1 - y0, corners[0].x, corners[0].y, corners[2].x - corners[0].x, corners[2].y - corners[0].y);
          } else if (x0 === SIDE_BLEND || x1 === SHELL.width - SIDE_BLEND) {
            const strips = Math.max(1, Math.ceil((map(x1, y0).x - map(x0, y0).x) * m.a));
            for (let i = 0; i < strips; i++) {
              const a = x0 + ((x1 - x0) * i) / strips;
              const b = x0 + ((x1 - x0) * (i + 1)) / strips;
              const middle = (a + b) / 2;
              const left = map(a, y0).x;
              const w = map(b, y0).x - left;
              const base = Math.max(y0, Math.min(y1, sideBase(middle < west ? middle : SHELL.width - middle)));
              if (base > y0) {
                const raised = map(middle, y0).y;
                patch(a, y0, b - a, base - y0, left, raised, w, flatY(base) - raised);
              }
              if (base < y1) patch(a, base, b - a, y1 - base, left, flatY(base), w, flatY(y1) - flatY(base));
            }
          } else {
            patch(x0, y0, x1 - x0, y1 - y0, map(x0, y0).x, flatY(y0), map(x1, y0).x - map(x0, y0).x, flatY(y1) - flatY(y0));
            raisedCell(x0, x1, y0, y1);
          }
          continue;
        }
        // The outer columns keep a 140-pixel strip of the rim's cross-section unscaled; the rest of the band is plank tiles.
        const strip = 140;
        const top = map(x0, y0).y;
        const bottom = map(x0, y1).y;
        const ratio = (map(x1, y0).x - map(x0, y0).x) / (x1 - x0);
        const outer = col === 0 || col === sx.length - 2;
        if (outer) {
          const start = col === 0 ? 0 : shell.width - strip;
          patch(start, y0, strip, y1 - y0, map(start, y0).x, top, strip * ratio, bottom - top);
        }
        const from = x0 + (col === 0 ? strip : 0);
        const to = x1 - (col === sx.length - 2 ? strip : 0);
        const dest = map(from, y0).x;
        for (let at = top; at < bottom - 0.001; at += s.floorTileHeight) {
          const h = Math.min(s.floorTileHeight, bottom - at);
          const sourceHeight = ((floorEnd - floorStart) * h) / s.floorTileHeight;
          patch(from, floorEnd - sourceHeight, to - from, sourceHeight, dest, at, (to - from) * ratio, h);
        }
      }
  }

  /** The window without its view (before the art has loaded, or without it): pale glass and its frame, over the plain walls. */
  function plainArch(arch: Arch, mullions: readonly Mullion[]): void {
    ctx.save();
    traceArch(ctx, arch, true);
    ctx.fillStyle = "#dfe8e4";
    ctx.fill();
    ctx.restore();
    strokeArch(ctx, arch, mullions);
  }

  const SHAPES: Record<FurnishingKind | "desk", { color: string; ratio: number }> = {
    desk: { color: "#cdb48c", ratio: 0.5 },
    sofa: { color: "#b9c4a8", ratio: 0.6 },
    coffee: { color: "#d4c3a5", ratio: 0.45 },
    plant: { color: "#8ea877", ratio: 1.1 },
    shelf: { color: "#c9b292", ratio: 1.1 },
    bench: { color: "#d6b98e", ratio: 0.38 },
    "coat-rack": { color: "#b08d62", ratio: 2.8 },
  };
  /** A piece of furniture standing at (x, y), `w` wide; `clip` (source pixels) draws only that part of its picture. */
  function prop(kind: FurnishingKind | "desk", x: number, y: number, w: number, alpha: number, clip: readonly (readonly [number, number])[] | null = null, fixedHeight: number | null = null): void {
    if (alpha <= 0) return;
    const art = state.art();
    ctx.save();
    ctx.globalAlpha = alpha;
    if (art === null) {
      if (clip !== null) {
        ctx.restore();
        return;
      }
      const shape = SHAPES[kind];
      const h = fixedHeight ?? w * shape.ratio;
      ctx.fillStyle = shape.color;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h, w, h, 18);
      ctx.fill();
    } else {
      const r = art.frames[kind];
      const h = fixedHeight ?? (w * r.height) / r.width;
      if (clip !== null) {
        ctx.beginPath();
        for (const [i, [sx, sy]] of clip.entries()) {
          const px = x - w / 2 + ((sx - r.x) * w) / r.width;
          const py = y - h + ((sy - r.y) * h) / r.height;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.clip();
      }
      ctx.drawImage(kind === "bench" || kind === "coat-rack" ? art.reception : art.image, r.x, r.y, r.width, r.height, x - w / 2, y - h, w, h);
    }
    ctx.restore();
  }

  /**
   * A working colleague's laptop is on: the small power light on its back lid glows softly (the room
   * sees the lid, never a screen). Only work turns a laptop on, so a lit laptop always means a turn in
   * progress (a resting colleague may still sit at a desk when the rest seats are full).
   */
  function laptopLight(station: Station, time: number, alpha: number): void {
    const { indicator, sprite } = station;
    const reach = sprite.width * 0.05;
    ctx.save();
    ctx.globalAlpha = alpha * (0.75 + 0.25 * Math.sin(time * 1.3));
    ctx.globalCompositeOperation = "lighter";
    const glow = ctx.createRadialGradient(indicator.x, indicator.y, 0, indicator.x, indicator.y, reach);
    glow.addColorStop(0, "rgba(255, 214, 140, 0.55)");
    glow.addColorStop(1, "rgba(255, 214, 140, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(indicator.x, indicator.y, reach, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Plain shapes: the body's lowest point (0.02 h above its floor line) rests on the cushion. */
  const plainLift = ({ h, y, sit = 0, support = null }: Figure): number => (support !== null && sit > 0 ? sit * (support.y - y + h * 0.02) : 0);

  /**
   * The seated figure's translation (room units), shared with the renderer,
   * so its name and hit area can be placed before
   * anything is drawn.
   */
  function placement(data: SceneActor, drawn: Figure): { x: number; y: number } {
    const rigs = state.rigs();
    if (rigs === null) return { x: 0, y: plainLift(drawn) };
    const { h, ...options } = drawn;
    return rigs.placement({ species: data.species, appearance: data.identity, height: h, ...options });
  }

  /** Draws a colleague; returns where its body went (lifted onto a cushion while it sits on one). */
  function figure(data: SceneActor, drawn: Figure): Drawn {
    const { h, ...options } = drawn;
    const rigs = state.rigs();
    if (rigs !== null) return rigs.draw(ctx, { species: data.species, appearance: data.identity, height: h, ...options });
    const { x, pose, alpha = 1 } = options;
    const renderOffsetY = plainLift(drawn);
    const y = options.y + renderOffsetY;
    if (options.layer === "hands") return { visualX: x, visualY: y, renderOffsetX: 0, renderOffsetY };
    // Plain shapes: a round body in the identity colour, ears or crest by species.
    ctx.save();
    ctx.globalAlpha = alpha;
    const r = h * 0.2;
    const cy = y - h * 0.32 + pose.bodyY * h;
    ctx.fillStyle = data.identity.color;
    ctx.beginPath();
    ctx.ellipse(x, cy, r, h * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    const hy = y - h * 0.72 + pose.headY * h;
    ctx.fillStyle = data.species === "cat" ? "#d9b48a" : data.species === "otter" ? "#a88462" : "#e2c46f";
    ctx.beginPath();
    ctx.arc(x, hy, h * 0.17, 0, Math.PI * 2);
    ctx.fill();
    if (data.species === "cat") {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(x + side * h * 0.05, hy - h * 0.13);
        ctx.lineTo(x + side * h * 0.15, hy - h * 0.25);
        ctx.lineTo(x + side * h * 0.17, hy - h * 0.08);
        ctx.fill();
      }
    }
    ctx.restore();
    return { visualX: x, visualY: y, renderOffsetX: 0, renderOffsetY };
  }

  /**
   * A colleague waiting for the owner, in a still, warm light (flow-attention-v1): an amber glow
   * behind its head and shoulders, and a pale rim around its outline so the amber holds on the
   * yellow floor. Nothing in it moves. The plain shapes drawn before the art loads have no light.
   */
  function glowingFigure(data: SceneActor, { h, ...options }: Figure): Drawn {
    const rigs = state.rigs();
    if (rigs === null) return figure(data, { h, ...options });
    if (glow === null) {
      const layer = document.createElement("canvas");
      const maybe = layer.getContext("2d");
      if (maybe === null) throw new Error("Canvas 2D is not available");
      glow = { layer, ctx: maybe };
    }
    const { layer: glowLayer, ctx: glowCtx } = glow;
    const { x, y, alpha = 1 } = options;
    const m = ctx.getTransform();
    // The figure's box with a raised paw, a tail and a seat's lift, in canvas pixels.
    const left = Math.floor(m.a * (x - h) + m.e), top = Math.floor(m.d * (y - h * 1.7) + m.f);
    const width = Math.ceil(m.a * h * 2), height = Math.ceil(m.d * h * 2);
    if (glowLayer.width < width || glowLayer.height < height) {
      glowLayer.width = Math.max(glowLayer.width, width);
      glowLayer.height = Math.max(glowLayer.height, height);
    }
    glowCtx.setTransform(1, 0, 0, 1, 0, 0);
    glowCtx.clearRect(0, 0, width, height);
    glowCtx.setTransform(m.a, 0, 0, m.d, m.e - left, m.f - top);
    const drawn = rigs.draw(glowCtx, { species: data.species, appearance: data.identity, height: h, ...options });
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(drawn.visualX, drawn.visualY - h * 0.68);
    ctx.scale(h * 0.7, h * 0.66);
    const light = ctx.createRadialGradient(0, 0, 0.12, 0, 0, 1);
    light.addColorStop(0, "rgba(246, 185, 61, 0.54)");
    light.addColorStop(0.48, "rgba(246, 185, 61, 0.35)");
    light.addColorStop(0.8, "rgba(246, 185, 61, 0.14)");
    light.addColorStop(1, "rgba(246, 185, 61, 0)");
    ctx.fillStyle = light;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.shadowColor = "rgba(255, 251, 222, 0.98)";
    ctx.shadowBlur = Math.max(3, h * 0.075 * m.a);
    ctx.drawImage(glowLayer, 0, 0, width, height, left, top, width, height);
    ctx.restore();
    return drawn;
  }

  /**
   * A small, empty thought cloud beside the head of a colleague with no signal: two dots, then the cloud,
   * appearing slowly (`amount` 0 to 1) and hardly drifting (`drift` -1 to 1). Never a word, a picture or a
   * symbol inside: it shows that nothing is observed, not that something is going on. `side` is where the
   * colleague faces; `floorY` the floor line its body was drawn on.
   */
  function thoughtCloud(x: number, floorY: number, h: number, side: number, amount: number, alpha: number, drift: number): void {
    const m = ctx.getTransform();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    // At least 15 CSS pixels wide, so it still reads on a phone. In front of the brow, below the band
    // where the markers sit, so a neighbour's marker does not cover it.
    const w = Math.max(h * 0.28, (15 * dpr) / m.a);
    const cx = x + side * (h * 0.36 + w * 0.5), cy = floorY - h * 0.88 + drift * h * 0.006;
    const head = { x: x + side * h * 0.3, y: floorY - h * 0.74 }, edge = { x: cx - side * w * 0.36, y: cy + w * 0.18 };
    const stage = (from: number, length: number) => Math.max(0, Math.min(1, (amount - from) / length));
    const smooth = (t: number) => t * t * (3 - 2 * t);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = "rgba(255, 251, 243, 0.96)";
    ctx.strokeStyle = "rgba(118, 102, 84, 0.6)";
    const line = Math.max(w * 0.035, dpr / m.a);
    const blob = (circles: readonly (readonly [number, number, number])[], opacity: number) => {
      if (opacity <= 0) return;
      ctx.save();
      ctx.globalAlpha *= opacity;
      ctx.beginPath();
      for (const [px, py, r] of circles) {
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, Math.PI * 2);
      }
      // The outline of the union: a wide stroke under the fill.
      ctx.lineWidth = line * 2;
      ctx.stroke();
      ctx.fill();
      ctx.restore();
    };
    const along = (t: number) => ({ x: head.x + (edge.x - head.x) * t, y: head.y + (edge.y - head.y) * t });
    const d1 = along(0.35), d2 = along(0.72);
    blob([[d1.x, d1.y, w * 0.045]], smooth(stage(0, 0.25)));
    blob([[d2.x, d2.y, w * 0.075]], smooth(stage(0.2, 0.3)));
    const grow = smooth(stage(0.45, 0.55)), k = w * (0.75 + 0.25 * grow);
    const puffs: readonly (readonly [number, number, number])[] = [[-0.3, 0.06, 0.2], [-0.12, -0.1, 0.24], [0.12, -0.12, 0.25], [0.32, 0.02, 0.2], [0.08, 0.12, 0.22], [-0.14, 0.12, 0.18]];
    blob(puffs.map(([px, py, r]) => [cx + side * px * k, cy + py * k, r * k] as const), grow);
    ctx.restore();
  }

  return { roomPlate, plainArch, prop, laptopLight, placement, figure, glowingFigure, thoughtCloud };
}
