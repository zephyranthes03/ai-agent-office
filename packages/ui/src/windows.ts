// The window and what is outside it (the design handoff 2026-11-05-arch-window): one arched opening
// filling the rear wall between the high side walls, finished by one thin cream-and-oak frame that
// rises from the low wall's top line along each side and runs over the arch, and divided by thinner
// vertical bars of the same wood into equal panes (scene-layout.ts, mullionsAt) — a warm cottage
// window rather than one sheet of glass; no bottom rail, the low wall's top line is its sill. The view is one picture (a forest or
// the sea, middle and far distance only, no leaves near) laid in the opening at its own proportions
// (scene-layout.ts, viewRect), slid or grown just enough that the moon shows whole in one pane
// (paneViewRect). It is drawn over the room's walls: the frame's sides lie on the side
// walls' inner edges and the view covers the step where each side wall curls into the low wall, so the
// opening's edge is the frame's, not the picture's. Each view has a picture for each weather
// (weather.ts; the handoff 2026-11-10-office-weather), all laid in the same place, so the weather
// changes the sky and the light outside but never moves the hills or the horizon; a change fades from
// one picture to the next. No clock, no service. The pictures are never rewritten.
import { loadImage } from "./art.ts";
import { archTop, paneViewRect, viewRect } from "./scene-layout.ts";
import type { Arch, Mullion, PaneKeep } from "./scene-layout.ts";
import { COZY } from "./space.ts";
import { WEATHERS } from "./weather.ts";
import type { Weather } from "./weather.ts";

export const SCENERIES = ["forest", "ocean"] as const;
export type Scenery = (typeof SCENERIES)[number];

/** The weather outside: `to` shows over `from` at `mix` (0 to 1) while it changes, then alone. */
export type Sky = { from: Weather; to: Weather; mix: number };

export type Windows = {
  /** Draws the window `arch` with its bars and the view in `sky` into the current transform (the office's camera), after the room's walls. */
  draw: (ctx: CanvasRenderingContext2D, arch: Arch, mullions: readonly Mullion[], sky: Sky) => void;
  setScenery: (scenery: Scenery) => void;
  scenery: () => Scenery;
};

/**
 * Starts a path around the opening (room units, in the office's camera): up from the low wall's top
 * line along the left side, over the arch and down the right side; with `glass`, closed along the line.
 */
export function traceArch(ctx: CanvasRenderingContext2D, a: Arch, glass: boolean): void {
  ctx.beginPath();
  ctx.moveTo(a.left.x, a.base);
  ctx.lineTo(a.left.x, a.left.y);
  ctx.save();
  ctx.transform(1, a.slope, 0, 1, a.cx, a.cy);
  ctx.ellipse(0, 0, a.rx, a.ry, 0, Math.PI, 2 * Math.PI);
  ctx.restore();
  ctx.lineTo(a.right.x, a.base);
  if (glass) ctx.closePath();
}

/** The bars: thinner lines of the frame's wood from the arch down to the low wall's top line, their tops under the frame. */
function strokeMullions(ctx: CanvasRenderingContext2D, a: Arch, mullions: readonly Mullion[]): void {
  ctx.save();
  ctx.lineCap = "butt";
  for (const [color, width] of [["#c2a781", 0.55 * a.rim + 1.2 / a.scale], ["#f7ead3", 0.55 * a.rim]] as const)
    for (const m of mullions) {
      ctx.globalAlpha = m.alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(m.x, archTop(a, m.x));
      ctx.lineTo(m.x, a.base);
      ctx.stroke();
    }
  ctx.restore();
}

/** The frame and its bars: a cream line on a slightly wider oak one, the feet cut square on the low wall's top line. */
export function strokeArch(ctx: CanvasRenderingContext2D, a: Arch, mullions: readonly Mullion[]): void {
  strokeMullions(ctx, a, mullions);
  ctx.save();
  traceArch(ctx, a, false);
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#c2a781";
  ctx.lineWidth = a.rim + 1.4 / a.scale;
  ctx.stroke();
  ctx.strokeStyle = "#f7ead3";
  ctx.lineWidth = a.rim;
  ctx.stroke();
  ctx.restore();
}

/** The pictures of the views in each weather, loaded once; every scene's window draws from them. */
export type WindowViews = Record<Scenery, Record<Weather, HTMLImageElement>>;

/** The clear views keep their first names; the others are the same views, painted at the same size. */
const viewFile = (scenery: Scenery, weather: Weather) => `./${COZY}/${weather === "clear" ? scenery : `${scenery}-${weather}`}.png`;

export async function loadWindowViews(): Promise<WindowViews> {
  const pictures = await Promise.all(SCENERIES.flatMap((scenery) => WEATHERS.map(async (weather) => [scenery, weather, await loadImage(viewFile(scenery, weather))] as const)));
  const views = Object.fromEntries(SCENERIES.map((scenery) => [scenery, {}])) as WindowViews;
  for (const [scenery, weather, image] of pictures) views[scenery][weather] = image;
  return views;
}

/** The moon of the weather pictures (both views paint it at the same place), as fractions of a picture: it is kept whole in one pane. */
export const MOON: PaneKeep = { left: 933 / 2172, right: 991 / 2172, top: 325 / 724, bottom: 406 / 724 };

/** A scene's window: which view it looks out on is the scene's own, the pictures are shared. */
export function createWindows(views: WindowViews): Windows {
  let scenery: Scenery = "forest";
  return {
    setScenery(next) {
      scenery = next;
    },
    scenery: () => scenery,
    draw(ctx, arch, mullions, sky) {
      const pictures = views[scenery];
      const r = paneViewRect(arch, mullions, viewRect(arch, pictures.clear.naturalWidth, pictures.clear.naturalHeight), MOON);
      ctx.save();
      traceArch(ctx, arch, true);
      ctx.clip();
      if (sky.mix < 1) ctx.drawImage(pictures[sky.from], r.x, r.y, r.width, r.height);
      if (sky.mix > 0) {
        ctx.globalAlpha = sky.mix;
        ctx.drawImage(pictures[sky.to], r.x, r.y, r.width, r.height);
      }
      ctx.restore();
      strokeArch(ctx, arch, mullions);
    },
  };
}
