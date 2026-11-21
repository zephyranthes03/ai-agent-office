// Garment details for the preview art: a knit, a check, a herringbone, pockets, buttons, a flower and
// stitching, drawn into the clothing selection by the material painter (material.ts), which keeps the
// garment's own shading and its exact source alpha and caches the result with each crop. No new images:
// everything here is Canvas strokes in a 100 × 100 square mapped onto the selected garment's bounds.
// Ported from the art run's private study (office-load-v1/flow-life-v5, wardrobe.mjs).
type Ctx = CanvasRenderingContext2D;
type Palette = { panel: string; thread: string; ink: string };
type Bounds = { x: number; y: number; width: number; height: number };
type Rgb = readonly [number, number, number];

/** Each species' outfit (the base panel colour of its pockets and patches). */
export const WARDROBE: Readonly<Record<string, { outfit: string; panel: string }>> = Object.freeze({
  cat: { outfit: "argyle knit vest", panel: "#c6a477" },
  otter: { outfit: "canvas pocket apron", panel: "#c29a6a" },
  bird: { outfit: "check scarf", panel: "#d5a064" },
  dog: { outfit: "work jacket", panel: "#718a9a" },
  rabbit: { outfit: "flower-embroidered cardigan", panel: "#cf9da6" },
  fox: { outfit: "herringbone vest", panel: "#bc8c65" },
  panda: { outfit: "cable-knit cardigan", panel: "#d5c5a6" },
  hedgehog: { outfit: "check pocket vest", panel: "#c8a477" },
});

const tint = (a: Rgb, b: Rgb, t: number) => `rgb(${a.map((v, i) => Math.round(v * (1 - t) + b[i]! * t)).join(" ")})`;

function line(ctx: Ctx, points: readonly (readonly [number, number])[], color: string, width = 1, alpha = 1, dash: number[] = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(dash);
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.restore();
}

function pocket(ctx: Ctx, x: number, y: number, w: number, h: number, { panel, thread, ink }: Palette, flap = false) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = 0.94;
  const gradient = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  gradient.addColorStop(0, panel);
  gradient.addColorStop(1, ink);
  ctx.shadowColor = "#343a2729";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 0.5;
  ctx.shadowOffsetY = 1.3;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h / 2);
  ctx.lineTo(w / 2, -h / 2);
  ctx.lineTo(w / 2, h * 0.28);
  ctx.quadraticCurveTo(w * 0.44, h / 2, 0, h / 2);
  ctx.quadraticCurveTo(-w * 0.44, h / 2, -w / 2, h * 0.28);
  ctx.closePath();
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = panel;
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 1, -h / 2 + 1);
  ctx.lineTo(w / 2 - 1, -h / 2 + 1);
  ctx.lineTo(w / 2 - 1, h * 0.25);
  ctx.quadraticCurveTo(w * 0.4, h / 2 - 1, 0, h / 2 - 1);
  ctx.quadraticCurveTo(-w * 0.4, h / 2 - 1, -w / 2 + 1, h * 0.25);
  ctx.closePath();
  ctx.fill();
  const shade = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  shade.addColorStop(0, "#171b1300");
  shade.addColorStop(0.55, "#171b1300");
  shade.addColorStop(1, "#171b1322");
  ctx.fillStyle = shade;
  ctx.globalAlpha = 1;
  ctx.fill();
  line(ctx, [[-w / 2 + 2, -h / 2 + 3], [-w / 2 + 2, h * 0.22], [-w * 0.34, h * 0.4], [0, h * 0.43], [w * 0.34, h * 0.4], [w / 2 - 2, h * 0.22], [w / 2 - 2, -h / 2 + 3]], thread, 0.6, 0.57, [1.3, 1.6]);
  line(ctx, [[-w / 2 + 1, -h / 2 + 3], [w / 2 - 1, -h / 2 + 3]], ink, 1.1, 0.55);
  if (flap) {
    ctx.fillStyle = thread;
    ctx.globalAlpha = 0.23;
    ctx.fillRect(-w / 2, -h / 2, w, h * 0.23);
    line(ctx, [[-w / 2 + 1, -h * 0.26], [w / 2 - 1, -h * 0.26]], thread, 0.65, 0.9, [1.4, 1.5]);
  }
  ctx.restore();
}

function button(ctx: Ctx, x: number, y: number, r: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#554633";
  ctx.globalAlpha = 0.32;
  ctx.beginPath();
  ctx.ellipse(0.35, 0.65, r * 1.06, r, 0, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, 0.1, 0, 0, r);
  g.addColorStop(0, "#d6b17a");
  g.addColorStop(0.7, "#aa7b49");
  g.addColorStop(1, "#765737");
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#e0c397";
  ctx.lineWidth = 0.45;
  ctx.beginPath();
  ctx.arc(0, -0.1, r * 0.73, Math.PI * 1.08, Math.PI * 1.85);
  ctx.stroke();
  line(ctx, [[-r * 0.25, -r * 0.18], [r * 0.25, r * 0.18]], "#674d36", 0.55, 0.85);
  ctx.restore();
}

function leaf(ctx: Ctx, x: number, y: number, size: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.88;
  ctx.beginPath();
  ctx.moveTo(0, 5);
  ctx.bezierCurveTo(-7, 1, -6, -5, 2, -7);
  ctx.bezierCurveTo(6, -1, 5, 3, 0, 5);
  ctx.fill();
  line(ctx, [[0, 5], [1, -4]], "#fff0c9", 0.8, 0.8);
  ctx.restore();
}

function flower(ctx: Ctx, x: number, y: number, size: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  line(ctx, [[0, 8], [0, 0], [3, -4]], "#e4d4a8", 1.2, 0.9);
  for (let i = 0; i < 5; i++) {
    ctx.save();
    ctx.rotate((i * Math.PI * 2) / 5);
    ctx.fillStyle = i % 2 ? "#f0cfce" : "#efdcd0";
    ctx.beginPath();
    ctx.ellipse(0, -3.2, 1.7, 2.7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = "#bd9a5c";
  ctx.beginPath();
  ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
  ctx.fill();
  leaf(ctx, -2, 6, 0.38, "#e1d4ac");
  ctx.restore();
}

function weave(ctx: Ctx, ink: string, thread: string) {
  for (let y = 2; y < 100; y += 3.2) line(ctx, [[0, y], [100, y + 0.4]], thread, 0.42, 0.09);
  for (let x = 2; x < 100; x += 4.1) line(ctx, [[x, 0], [x - 0.3, 100]], ink, 0.35, 0.07);
}

function argyle(ctx: Ctx, { panel, thread, ink }: Palette) {
  for (let y = -12; y < 120; y += 30)
    for (let x = -16; x < 120; x += 30) {
      ctx.save();
      ctx.globalAlpha = (x / 30 + y / 30) & 1 ? 0.3 : 0.49;
      ctx.fillStyle = panel;
      ctx.beginPath();
      ctx.moveTo(x, y - 15);
      ctx.lineTo(x + 15, y);
      ctx.lineTo(x, y + 15);
      ctx.lineTo(x - 15, y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  for (let i = -100; i < 180; i += 30) {
    line(ctx, [[i, 0], [i + 100, 100]], thread, 0.7, 0.5, [2, 1.7]);
    line(ctx, [[i, 0], [i - 100, 100]], ink, 0.6, 0.26, [2, 1.7]);
  }
}

function check(ctx: Ctx, { panel, thread, ink }: Palette, scarf = false) {
  const step = scarf ? 36 : 27;
  for (let x = -step; x < 120; x += step) {
    ctx.save();
    ctx.globalAlpha = scarf ? 0.46 : 0.32;
    ctx.fillStyle = panel;
    ctx.fillRect(x, 0, step * 0.38, 100);
    ctx.restore();
    line(ctx, [[x + step * 0.55, 0], [x + step * 0.55, 100]], thread, scarf ? 1.8 : 0.8, 0.55);
  }
  for (let y = -step; y < 120; y += step) {
    ctx.save();
    ctx.globalAlpha = scarf ? 0.36 : 0.25;
    ctx.fillStyle = panel;
    ctx.fillRect(0, y, 100, step * 0.34);
    ctx.restore();
    line(ctx, [[0, y + step * 0.56], [100, y + step * 0.56]], ink, scarf ? 1.7 : 0.9, 0.28);
  }
}

function herringbone(ctx: Ctx, { thread, ink }: Palette) {
  for (let x = -8; x < 110; x += 16)
    for (let y = -12; y < 110; y += 12) {
      line(ctx, [[x, y], [x + 8, y + 8], [x + 16, y]], thread, 0.95, 0.32);
      line(ctx, [[x, y + 2], [x + 8, y + 10], [x + 16, y + 2]], ink, 0.7, 0.13);
    }
}

function knit(ctx: Ctx, { thread, ink }: Palette, cables = false, front = false) {
  if (!cables) for (let y = 5; y < 105; y += 8) for (let x = 5; x < 105; x += 8) line(ctx, [[x - 2, y - 2], [x, y + 2], [x + 2, y - 2]], thread, 0.65, 0.17);
  if (cables)
    for (const x of front ? [27, 76] : [27, 49])
      for (let y = 9; y < 92; y += 18)
        for (const sign of [-1, 1]) {
          ctx.save();
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.bezierCurveTo(x + sign * 2, y + 3, x + sign * 2, y + 6, x, y + 9);
          ctx.bezierCurveTo(x - sign * 2, y + 12, x - sign * 2, y + 15, x, y + 18);
          ctx.strokeStyle = ink;
          ctx.lineWidth = 2.4;
          ctx.globalAlpha = 0.15;
          ctx.stroke();
          ctx.strokeStyle = thread;
          ctx.lineWidth = 1.05;
          ctx.globalAlpha = 0.48;
          ctx.stroke();
          ctx.restore();
        }
}

/**
 * Draws one crop's garment details over `bounds` (the selected garment's box in crop pixels). `key` is
 * the painter's crop key (`species:part`): a sleeve (`…Arm`) gets only a cuff line (and the rabbit's
 * flower), the front view (`…:front`) its own layout; `primary` is the tinted garment's mean colour,
 * which the threads and the ink are derived from so they suit any identity colour.
 */
export function drawGarmentDetails(ctx: Ctx, { species, key, bounds, primary }: { species: string; key: string; bounds: Bounds; primary: Rgb }) {
  const wardrobe = WARDROBE[species];
  if (wardrobe === undefined) throw new Error(`Unknown wardrobe: ${species}`);
  const front = key.endsWith(":front");
  const sleeve = key.endsWith("Arm");
  const c: Palette = { panel: wardrobe.panel, thread: tint(primary, [251, 235, 202], 0.79), ink: tint(primary, [40, 45, 38], 0.56) };
  ctx.save();
  ctx.translate(bounds.x, bounds.y);
  ctx.scale(bounds.width / 100, bounds.height / 100);
  weave(ctx, c.ink, c.thread);
  if (sleeve) {
    if (species === "rabbit") {
      knit(ctx, c, false);
      flower(ctx, 49, 37, 2.4);
    }
    line(ctx, [[0, 77], [100, 82]], c.thread, 1.25, 0.58, [2, 2]);
    ctx.restore();
    return;
  }
  if (species === "bird") {
    check(ctx, c, true);
    line(ctx, [[0, 82], [100, 91]], c.thread, 2.8, 0.75);
    line(ctx, [[0, 74], [100, 83]], c.ink, 0.8, 0.48);
    ctx.restore();
    return;
  }
  if (species === "cat") {
    argyle(ctx, c);
    const seam = front ? 51 : 83;
    line(ctx, [[seam - 4, 17], [seam, 58], [seam - 2, 97]], c.ink, 3, 0.45);
    line(ctx, [[seam - 5, 18], [seam - 1, 58], [seam - 3, 94]], c.thread, 0.75, 0.8, [1.5, 1.7]);
    for (const y of [44, 63, 82]) button(ctx, seam - 1, y, 2.5);
    pocket(ctx, front ? 24 : 41, 72, front ? 24 : 26, 17, c);
    leaf(ctx, front ? 72 : 57, 32, 0.6, c.thread);
  } else if (species === "otter") {
    pocket(ctx, front ? 50 : 73, 65, front ? 48 : 36, 35, c);
    line(ctx, [[front ? 50 : 72, 48], [front ? 50 : 72, 79]], c.thread, 0.75, 0.8, [1.5, 1.5]);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = c.thread;
    ctx.fillRect(front ? 59 : 78, 43, 10, 5);
    ctx.restore();
    for (const x of front ? [30, 69] : [30, 72]) button(ctx, x, 19, 2.4);
    line(ctx, [[7, 87], [51, 93], [98, 89]], c.thread, 1, 0.7, [1.6, 1.7]);
  } else if (species === "dog") {
    pocket(ctx, front ? 24 : 54, 69, front ? 24 : 23, 24, c, true);
    if (front) pocket(ctx, 76, 69, 23, 24, c, true);
    line(ctx, [[5, 88], [49, 96]], c.thread, 1, 0.65, [1.7, 1.7]);
    line(ctx, [[68, 94], [98, 84]], c.thread, 1, 0.65, [1.7, 1.7]);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "#d8bd84";
    ctx.fillRect(front ? 19 : 26, 34, 13, 5);
    ctx.restore();
  } else if (species === "rabbit") {
    knit(ctx, c);
    flower(ctx, front ? 24 : 60, front ? 42 : 24, 1.4);
    if (front) flower(ctx, 10, 44, 0.8);
    pocket(ctx, front ? 77 : 57, 76, front ? 20 : 22, 15, c);
    line(ctx, [[3, 87], [36, 94], [63, 95], [99, 85]], c.thread, 1.3, 0.6, [1, 2]);
  } else if (species === "fox") {
    herringbone(ctx, c);
    pocket(ctx, front ? 26 : 41, 70, front ? 25 : 27, 14, c);
    leaf(ctx, front ? 71 : 56, 30, 1, c.thread);
    line(ctx, front ? [[34, 8], [51, 32], [66, 9]] : [[39, 5], [68, 30], [91, 9]], c.panel, 2, 0.8);
    line(ctx, front ? [[34, 12], [51, 36], [66, 13]] : [[39, 9], [68, 34], [91, 13]], c.thread, 0.8, 0.72, [1.5, 1.5]);
  } else if (species === "panda") {
    knit(ctx, c, true, front);
    pocket(ctx, front ? 76 : 27, 74, front ? 21 : 27, 15, c);
    line(ctx, [[2, 87], [35, 94], [66, 94], [99, 85]], c.thread, 1.1, 0.65, [1.5, 1.7]);
  } else if (species === "hedgehog") {
    check(ctx, c);
    pocket(ctx, front ? 25 : 44, 72, front ? 24 : 27, 19, c, true);
    leaf(ctx, front ? 73 : 50, 28, 0.72, c.thread);
    line(ctx, front ? [[34, 10], [52, 33], [68, 10]] : [[40, 5], [71, 31], [96, 11]], c.thread, 1, 0.62, [1.5, 1.5]);
  }
  ctx.restore();
}
