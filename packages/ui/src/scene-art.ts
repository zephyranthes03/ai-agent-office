// The office scene's art, loaded apart from the scene that draws with it: the two rooms' walls, the
// furniture sheets with their frames, the views outside the window, the characters' rigs and the
// desks' workstations. A scene loads its own unless it is given one, so a page that draws several
// scenes reads and measures the pictures once.
import { loadImage, loadJson } from "./art.ts";
import { createRigs } from "./rig.ts";
import type { Rigs } from "./rig.ts";
import type { Frame, SpaceArt } from "./scene-paint.ts";
import { COZY } from "./space.ts";
import type { FurnishingKind } from "./space.ts";
import { loadWindowViews } from "./windows.ts";
import type { WindowViews } from "./windows.ts";
import { createWorkstations } from "./workstation.ts";
import type { Workstations } from "./workstation.ts";

/** Everything a scene draws from; nothing in it belongs to one scene (which view a window shows is the scene's own). */
export type OfficeArt = Omit<SpaceArt, "windows"> & { views: WindowViews; rigs: Rigs; workstations: Workstations };

export async function loadOfficeArt(): Promise<OfficeArt> {
  const atlas = await loadJson<{ image: string; shell: string; frames: Record<Exclude<FurnishingKind, "bench" | "coat-rack"> | "desk", Frame> }>("./assets-space/atlas.json");
  const reception = await loadJson<{ image: string; frames: { bench: Frame; "coat-rack": Frame } }>("./assets-waiting/reception.json");
  // The cozy v4 pictures (assets-cozy-v4) are edits of the earlier sheets at the same size and layout:
  // the office's wall, the lounge's and the waiting room's furniture keep their measured frames.
  const [shell, waitingShell, image, receptionImage, views, rigs, workstations] = await Promise.all([loadImage(`./${COZY}/room-v4.png`), loadImage("./assets-walls/plaster-two-doors-v3.png"), loadImage(`./${COZY}/lounge-v4.png`), loadImage(`./${COZY}/waiting-v4.png`), loadWindowViews(), createRigs(), createWorkstations()]);
  return { image, shell, waitingShell, reception: receptionImage, frames: { ...atlas.frames, ...reception.frames }, views, rigs, workstations };
}
