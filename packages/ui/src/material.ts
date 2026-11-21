// Clothing colour for the preview art: the clothing mask, intersected with the original garment's
// own colour range, is tinted with the identity colour, and the garment's details (wardrobe.ts) are
// drawn into that same selection with the garment's own shading. The original images are never
// rewritten; small per-crop caches keep it off the frame budget. Bounds are specific to these source drawings.
import { drawGarmentDetails } from "./wardrobe.ts";

type Rect = { x: number; y: number; width: number; height: number };
export type Painted = { source: CanvasImageSource; rect: Rect };

const rise = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function clothingWeight(species: string, r: number, g: number, b: number): number {
  const top = Math.max(r, g, b);
  const bottom = Math.min(r, g, b);
  const delta = top - bottom;
  const saturation = top === 0 ? 0 : delta / top;
  const hue = delta === 0 ? 0 : (((top === r ? (g - b) / delta : top === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60) + 360) % 360;
  if (species === "otter") return rise(43, 52, hue) * (1 - rise(80, 95, hue)) * rise(0.12, 0.18, saturation);
  if (species === "cat") return rise(0.61, 0.69, saturation) * (1 - rise(0.84, 0.9, top / 255)) * rise(24, 29, hue) * (1 - rise(42, 49, hue));
  if (species === "bird") return rise(8, 14, hue) * (1 - rise(24, 30, hue)) * rise(0.36, 0.47, saturation);
  if (species === "dog") return rise(49, 52, hue) * (1 - rise(100, 113, hue)) * rise(0.08, 0.16, saturation);
  if (species === "rabbit") return rise(245, 258, hue) * (1 - rise(297, 310, hue)) * rise(0.08, 0.16, saturation);
  if (species === "fox") return rise(160, 175, hue) * (1 - rise(210, 225, hue)) * rise(0.08, 0.15, saturation);
  if (species === "panda") return rise(19, 24, hue) * (1 - rise(42, 50, hue)) * rise(0.25, 0.38, saturation);
  if (species === "hedgehog") return rise(3, 9, hue) * (1 - rise(22, 28, hue)) * rise(0.3, 0.45, saturation);
  throw new Error(`Unknown garment material: ${species}`);
}

function expandedAlpha(data: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const horizontal = new Uint8ClampedArray(width * height);
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let dx = Math.max(0, x - radius); dx <= Math.min(width - 1, x + radius); dx++) value = Math.max(value, data[(y * width + dx) * 4 + 3]!);
      horizontal[y * width + x] = value;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let dy = Math.max(0, y - radius); dy <= Math.min(height - 1, y + radius); dy++) value = Math.max(value, horizontal[dy * width + x]!);
      out[y * width + x] = value;
    }
  return out;
}

const context = (canvas: HTMLCanvasElement) => {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) throw new Error("Canvas 2D is not available");
  return ctx;
};

export function createMaterialPainter() {
  const frames = new Map<string, Painted>();
  const selections = new Map<string, Uint8ClampedArray>();
  function paint(source: CanvasImageSource, mask: CanvasImageSource, rect: Rect, color: string, key: string, species: string, { edgeReach = 0 }: { edgeReach?: number } = {}): Painted {
    // The dog and rabbit masks sit a few source pixels off their garments (maskAccepted: false in
    // their parts.json); a wider reach, still cut to the garment colour below, covers the edge.
    const alignedEdgeReach = Math.max(edgeReach, species === "dog" || species === "rabbit" ? 7 : 0);
    const selectionKey = `${key}:${alignedEdgeReach}`;
    const cacheKey = `${selectionKey}:${color}`;
    const cached = frames.get(cacheKey);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    const layer = document.createElement("canvas");
    canvas.width = layer.width = rect.width;
    canvas.height = layer.height = rect.height;
    const ctx = context(canvas);
    const coat = context(layer);
    const crop = (image: CanvasImageSource) => [image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height] as const;
    ctx.drawImage(...crop(source));
    coat.drawImage(...crop(mask));
    // Generated masks are approximate: intersect with the original material colour, so a selected
    // paw or cream sleeve does not take the clothing hue.
    const original = ctx.getImageData(0, 0, rect.width, rect.height);
    const selection = coat.getImageData(0, 0, rect.width, rect.height);
    let selected = selections.get(selectionKey);
    if (!selected) {
      selected = expandedAlpha(selection.data, rect.width, rect.height, alignedEdgeReach);
      for (let pixel = 0; pixel < selected.length; pixel++) {
        const i = pixel * 4;
        selected[pixel] = Math.round(selected[pixel]! * clothingWeight(species, original.data[i]!, original.data[i + 1]!, original.data[i + 2]!));
      }
      selections.set(selectionKey, selected);
    }
    for (let i = 0; i < selection.data.length; i += 4) selection.data[i + 3] = selected[i / 4]!;
    coat.putImageData(selection, 0, 0);
    coat.globalCompositeOperation = "source-in";
    coat.fillStyle = color;
    coat.fillRect(0, 0, rect.width, rect.height);
    // A mask never adds pixels outside the original silhouette.
    coat.globalCompositeOperation = "destination-in";
    coat.drawImage(...crop(source));
    ctx.globalCompositeOperation = "color";
    ctx.drawImage(layer, 0, 0);
    const colored = ctx.getImageData(0, 0, rect.width, rect.height);
    // The garment's details go over the tinted cloth only (the selection cut to opaque source pixels),
    // shaded by the cloth's own light and dark, so pockets and patterns move with the body.
    let left = rect.width;
    let top = rect.height;
    let right = -1;
    let bottom = -1;
    let weight = 0;
    const primary: [number, number, number] = [0, 0, 0];
    for (let p = 0; p < selected.length; p++)
      if (selected[p]! >= 128 && original.data[p * 4 + 3]! >= 128) {
        const x = p % rect.width;
        const y = Math.floor(p / rect.width);
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        const w = selected[p]! / 255;
        weight += w;
        for (let c = 0; c < 3; c++) primary[c]! += colored.data[p * 4 + c]! * w;
      }
    if (weight > 0) {
      for (let c = 0; c < 3; c++) primary[c]! /= weight;
      coat.setTransform(1, 0, 0, 1, 0, 0);
      coat.globalAlpha = 1;
      coat.globalCompositeOperation = "source-over";
      coat.clearRect(0, 0, rect.width, rect.height);
      drawGarmentDetails(coat, { species, key, bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, primary });
      const detail = coat.getImageData(0, 0, rect.width, rect.height);
      const meanLuma = primary[0] * 0.2126 + primary[1] * 0.7152 + primary[2] * 0.0722;
      for (let p = 0; p < selected.length; p++) {
        const i = p * 4;
        const a = (selected[p]! / 255) * (detail.data[i + 3]! / 255) * (original.data[i + 3]! / 255);
        if (a === 0) continue;
        const luma = colored.data[i]! * 0.2126 + colored.data[i + 1]! * 0.7152 + colored.data[i + 2]! * 0.0722;
        const shade = Math.max(0.65, Math.min(1.2, luma / meanLuma));
        for (let c = 0; c < 3; c++) colored.data[i + c] = Math.round(colored.data[i + c]! * (1 - a) + Math.min(255, detail.data[i + c]! * shade) * a);
      }
    }
    // Keep the exact original alpha after the hue blend (applying destination-in again would square it).
    for (let i = 3; i < colored.data.length; i += 4) colored.data[i] = original.data[i]!;
    ctx.putImageData(colored, 0, 0);
    const frame = { source: canvas, rect: { x: 0, y: 0, width: rect.width, height: rect.height } };
    frames.set(cacheKey, frame);
    return frame;
  }
  return { paint, cachedFrameCount: () => frames.size };
}
