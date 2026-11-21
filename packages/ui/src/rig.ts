import { compactNeck, NECKS, CUSHION_FEET, FAR_LIMBS, articulateArm, cupAngleForReach } from "./anatomy.ts";
// Cut-out characters from the temporary preview art (packages/ui/art-preview): limbs, torso and head
// cropped from one image per species, joined at their pivots, with a short held front view during a
// turn. Rigid paws retain their authored shape; measured side soles approach the front soles
// before changing views, and scene-owned contacts keep planted paws still. Eight species: the first three from assets-rig, five cast packs from assets-cast with
// their joints in rig-profile.json (flow-life-v5). Rigid short arms rotate around calibrated
// shoulders, while held props follow the actual palms; props are drawn
// between the far and near arm. On a sofa or stool the single torso rests on the cushion;
// its original haunches and paws move continuously into a species-specific seated pose.
// The bird instead tucks its small feet behind its belly. One more face per species
// (assets-expression, 2026-11-05): blank (open eyes gone far off, a flat mouth). The sheet's tired
// faces are no longer drawn: a long turn shows in a bubble outside the character.
// Not a character-pack runtime. Positions are character units (height 110).
import { loadImage, loadJson } from "./art.ts";
import { createMaterialPainter } from "./material.ts";
import type { Identity } from "./identity.ts";
import type { Pose } from "./motion.ts";
import { SPECIES } from "./model.ts";
import type { Species } from "./model.ts";
import type { PropKind, RoutineFrame } from "./routines.ts";
import type { Station } from "./workstation.ts";

type Rect = { x: number; y: number; width: number; height: number };
type Leg = "nearLeg" | "farLeg";
type Arm = "nearArm" | "farArm";
type Sole = Point & {left:number;right:number};
type Point = { x: number; y: number };
type Limb = "head" | "torso" | "nearArm" | "farArm" | "nearLeg" | "farLeg";
type Frame = { rect: Rect; pivot: Point; suggestedWidth: number; solidBounds: Rect; mirrorX?: boolean; restRotation?: number; perspectiveScale?: number; seatSupport?: Point };
type RigSpecies = { image: string; frames: Record<Limb, Frame>; joints: Record<Exclude<Limb, "torso">, Point> };
type Atlas = { species: Record<"otter" | "cat" | "bird", RigSpecies> };
type ExpressionAtlas = { image: string; species: Record<"otter" | "cat" | "bird", Record<"blink" | "front", { rect: Rect }>> };
type FrontAtlas = { image: string; species: Record<"otter" | "cat" | "bird", { rect: Rect; solidBounds: Rect }> };
type Materials = { side: Record<"otter" | "cat" | "bird", { image: string }>; front: { image: string } };
type CastPack = { image: string; mask: string; frames: Record<Limb | "blink" | "front" | "frontBody", { rect: Rect; solidBounds: Rect }> };
type CastProfile = { frames: Record<Limb, { pivot: Point; suggestedWidth: number; mirrorX?: boolean; restRotation?: number; perspectiveScale?: number; seatSupport?: Point }>; joints: RigSpecies["joints"]; frontHeight: number; frontHeadWidth: number; coloredParts: Limb[] };
type PropAtlas = { image: string; frames: Record<PropKind, { rect: Rect; normalizedAnchors: Record<string, Point> }> };
/** A face a scene may ask for. A long turn shows outside the character, so only the blank stare is used. */
export type Face = "blank";
type FaceFrame = { rect: Rect; crop: Rect };
/** expression-v2.json: `crop` is where a face lies in its species' head crop (beyond it where ears were turned). */
type FaceAtlas = { image: string; species: Record<Species, Record<Face, FaceFrame>> };

/** Everything the rig needs of one species, whichever folder it came from. */
type Character = {
  frames: Record<Limb, Frame>;
  joints: RigSpecies["joints"];
  source: HTMLImageElement;
  sideMask: HTMLImageElement;
  blink: Rect;
  frontHead: Rect;
  expressionImage: HTMLImageElement;
  frontBody: { rect: Rect; solidBounds: Rect };
  frontImage: HTMLImageElement;
  frontMask: HTMLImageElement;
  /** A cast pack's front body stands on its own soles; the first three hang from the neck. */
  frontGrounded: boolean;
  frontHeight: number;
  frontHeadWidth: number;
  coloredParts: readonly Limb[];
  /** A visible paw point inside each arm crop, as fractions of the crop. */
  hands: Record<"nearArm" | "farArm", Point>;
  /** The lowest visible pixels of the torso crop (what sits on a cushion) and of each leg crop (its sole), in crop pixels. */
  soles: Record<"torso" | "nearLeg" | "farLeg", Sole>;
  frontSoles: Sole[];
};

const FIRST: readonly ("otter" | "cat" | "bird")[] = ["otter", "cat", "bird"];
const CAST = SPECIES.filter((name): name is Exclude<Species, "otter" | "cat" | "bird"> => !(FIRST as readonly string[]).includes(name));

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export type DrawOptions = {
  species: Species;
  appearance: Identity | null;
  x: number;
  y: number;
  height: number;
  pose: Pose;
  direction?: number;
  turn?: number;
  sit?: number;
  work?: boolean;
  alpha?: number;
  shadow?: boolean;
  /** A routine in progress: its pose changes are added, its paws and prop placed. */
  routine?: RoutineFrame | null;
  /** A cup carried between routines (in the far paw). */
  heldProp?: PropKind | null;
  /** The near paw is kept for the help gesture: routines leave it alone. */
  reserveNearHand?: boolean;
  /** A face instead of the usual one: blank (no signal). */
  face?: Face | null;
  /** How far the shoulders sit lower (character units; negative raises them): a tired colleague's slump. */
  shoulderDrop?: number;
  /** How far the near paw is held up beside the head (0 down, 1 up): a colleague waiting for the owner. */
  raisedHand?: number;
  /** The laptop of a seated working colleague: its paws go to the keys, a writing paw to its note. */
  workstation?: (Station & { contactMix: number }) | null;
  /** Physical desk support, retained while sitting down or getting up even when work has stopped. */
  deskSeat?: Station | null;
  /** The cushion a resting body sits on (room units): the body is lifted onto it as it sits down. */
  support?: Point | null;
  /** Painted window ledge, in room coordinates. */
  windowSill?: Point | null;
  /** Split desk arms at the painted tabletop edge; props and upper arms go above the laptop. */
  layer?: "all" | "body" | "hands";
};

/** The rendered origin after translating the whole figure onto its seat. */
export type Drawn = { visualX: number; visualY: number; renderOffsetX: number; renderOffsetY: number };

export type Rigs = {
  draw: (ctx: CanvasRenderingContext2D, options: DrawOptions) => Drawn;
  /** Rigid translation used by draw, for the name and hit area as well as the visible figure. */
  placement: (options: DrawOptions) => Point;
  portrait: (species: Species, appearance: Identity, pose: Pose) => string;
  /** Where a leg hangs from the body, in character heights from the centre (planted paws are placed from it). */
  footBase: (species: Species, leg: Leg) => number;
  projectGait: (pose:Pose,species:Species,tangent:Point,direction:number) => void;
  hipOffset: (species: Species, leg: "nearLeg" | "farLeg") => number;
};

/** The centre of the opaque pixels in the lower part of an arm crop: where the paw is. */
function handPixel(source: HTMLImageElement, frame: Frame, from = .72, to = .90): Point & { halfWidth:number } {
  const r = frame.rect;
  const canvas = document.createElement("canvas");
  canvas.width = r.width;
  canvas.height = r.height;
  const cx = canvas.getContext("2d", { willReadFrequently: true });
  if (cx === null) throw new Error("Canvas 2D is not available");
  cx.drawImage(source, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  const pixels = cx.getImageData(0, 0, r.width, r.height).data;
  const b = frame.solidBounds;
  let sx = 0;
  let sy = 0;
  let count = 0;
  let left=r.width,right=0;
  const top = Math.floor(b.y - r.y + b.height * from);
  const bottom = Math.ceil(b.y - r.y + b.height * to);
  for (let py = top; py < bottom; py++)
    for (let px = 0; px < r.width; px++)
      if (pixels[(py * r.width + px) * 4 + 3]! >= 128) {
        sx += px + 0.5;
        sy += py + 0.5;
        count++;
        left=Math.min(left,px);right=Math.max(right,px+1);
      }
  if (count === 0) throw new Error("No opaque pixels in the requested arm section");
  return { x: sx / count / r.width, y: sy / count / r.height,halfWidth:Math.max(sx/count-left,right-sx/count)/r.width };
}

/** The lowest visible row in the lower 30 % of a crop and the mean x of its last three rows (crop pixels). */
function solePixel(source: HTMLImageElement, r: Rect, left=0, right=r.width): Sole {
  const canvas = document.createElement("canvas");
  canvas.width = r.width;
  canvas.height = r.height;
  const cx = canvas.getContext("2d", { willReadFrequently: true });
  if (cx === null) throw new Error("Canvas 2D is not available");
  cx.drawImage(source, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  const pixels = cx.getImageData(0, 0, r.width, r.height).data;
  const visible = (px: number, py: number) => pixels[(py * r.width + px) * 4 + 3]! >= 16;
  let bottom = -1;
  for (let py = r.height - 1; py >= Math.floor(r.height * 0.7) && bottom < 0; py--)
    for (let px = left; px < right; px++)
      if (visible(px, py)) {
        bottom = py;
        break;
      }
  if (bottom < 0) throw new Error("No visible sole in a character crop");
  let minimum=Infinity,maximum=-Infinity;
  let sum = 0;
  let count = 0;
  for (let py = Math.max(0, bottom - 2); py <= bottom; py++)
    for (let px = left; px < right; px++)
      if (visible(px, py)) {
        sum += px + 0.5;
        minimum=Math.min(minimum,px);maximum=Math.max(maximum,px+1);
        count++;
      }
  return { x: sum / count, y: bottom + 1,left:minimum,right:maximum };
}

export async function createRigs(): Promise<Rigs> {
  const [atlas, expressions, frontBodies, materials, profiles, props, faces] = await Promise.all([
    loadJson<Atlas>("./assets-rig/atlas.json"),
    loadJson<ExpressionAtlas>("./assets-rig/expression-atlas.json"),
    loadJson<FrontAtlas>("./assets-rig/front-body-atlas.json"),
    loadJson<Materials>("./assets-identity/manifest.json"),
    loadJson<{ species: Record<(typeof CAST)[number], CastProfile> }>("./assets-cast/rig-profile.json"),
    loadJson<PropAtlas>("./assets-interaction/parts.json"),
    loadJson<FaceAtlas>("./assets-expression/expression-v2.json"),
  ]);
  const [expressionImage, frontImage, frontMask, propImage, faceImage] = await Promise.all([loadImage(expressions.image), loadImage(frontBodies.image), loadImage(materials.front.image), loadImage(`./assets-interaction/${props.image}`), loadImage(faces.image)]);
  if (frontMask.width !== frontImage.width || frontMask.height !== frontImage.height) throw new Error("Front clothing mask dimensions differ");
  const characters = {} as Record<Species, Character>;
  await Promise.all([
    ...FIRST.map(async (name) => {
      const rig = atlas.species[name];
      const [source, sideMask] = await Promise.all([loadImage(rig.image), loadImage(materials.side[name].image)]);
      characters[name] = { frames: rig.frames, joints: rig.joints, source, sideMask, blink: expressions.species[name].blink.rect, frontHead: expressions.species[name].front.rect, expressionImage, frontBody: frontBodies.species[name], frontImage, frontMask, frontGrounded: false, frontHeight: name === "bird" ? 66 : 73, frontHeadWidth: rig.frames.head.suggestedWidth * 0.96, coloredParts: ["torso"], hands: { nearArm: { x: 0, y: 0 }, farArm: { x: 0, y: 0 } }, frontSoles: [], soles: { torso: { x: 0, y: 0,left:0,right:0 }, nearLeg: { x: 0, y: 0,left:0,right:0 }, farLeg: { x: 0, y: 0,left:0,right:0 } } };
    }),
    ...CAST.map(async (name) => {
      const folder = `./assets-cast/${name}/`;
      const pack = await loadJson<CastPack>(`${folder}parts.json`);
      const profile = profiles.species[name];
      const [source, mask] = await Promise.all([loadImage(folder + pack.image), loadImage(folder + pack.mask)]);
      const frames = Object.fromEntries((Object.keys(profile.frames) as Limb[]).map((key) => [key, { ...pack.frames[key], ...profile.frames[key] }])) as Record<Limb, Frame>;
      characters[name] = { frames, joints: profile.joints, source, sideMask: mask, blink: pack.frames.blink.rect, frontHead: pack.frames.front.rect, expressionImage: source, frontBody: pack.frames.frontBody, frontImage: source, frontMask: mask, frontGrounded: true, frontHeight: profile.frontHeight, frontHeadWidth: profile.frontHeadWidth, coloredParts: profile.coloredParts, hands: { nearArm: { x: 0, y: 0 }, farArm: { x: 0, y: 0 } }, frontSoles: [], soles: { torso: { x: 0, y: 0,left:0,right:0 }, nearLeg: { x: 0, y: 0,left:0,right:0 }, farLeg: { x: 0, y: 0,left:0,right:0 } } };
    }),
  ]);
  for (const name of SPECIES) {
    const c = characters[name];
    if (c.sideMask.width !== c.source.width || c.sideMask.height !== c.source.height) throw new Error(`Clothing mask dimensions differ: ${name}`);
    c.hands = { nearArm: handPixel(c.source, c.frames.nearArm), farArm: handPixel(c.source, c.frames.farArm) };
    c.frontSoles=[solePixel(c.frontImage,c.frontBody.rect,0,Math.floor(c.frontBody.rect.width/2)),solePixel(c.frontImage,c.frontBody.rect,Math.floor(c.frontBody.rect.width/2))];
    c.soles = { torso: solePixel(c.source, c.frames.torso.rect), nearLeg: solePixel(c.source, c.frames.nearLeg.rect), farLeg: solePixel(c.source, c.frames.farLeg.rect) };
  }
  const material = createMaterialPainter();
  const portraits = new Map<string, string>();
  // The back limb owns one visibility rule in every render pass. These masks
  // include soft art edges, so replaying a hand above a desk never paints it
  // through the shirt or the head.
  const silhouetteCache = new WeakMap<CanvasImageSource, Map<string, { outside: Path2D; rightAt: (y:number)=>number }>>();
  function silhouette(image:CanvasImageSource, r:Rect, pivot:Point, w:number, h:number) {
    let entries=silhouetteCache.get(image);if(!entries)silhouetteCache.set(image,entries=new Map());
    const key=[r.x,r.y,r.width,r.height,pivot.x,pivot.y,w,h].join('/');
    const cached=entries.get(key);if(cached)return cached;
    const canvas=document.createElement("canvas");canvas.width=r.width;canvas.height=r.height;
    const cx=canvas.getContext("2d",{willReadFrequently:true});if(!cx)throw Error("Canvas 2D is unavailable");
    cx.drawImage(image,r.x,r.y,r.width,r.height,0,0,r.width,r.height);
    const pixels=cx.getImageData(0,0,r.width,r.height).data,outside=new Path2D(),right:number[]=[],outline:Array<{y:number;left:number;right:number}>=[];
    outside.rect(-500,-500,1000,1000);
    for(let y=0;y<r.height;y++){
      let left=-1,last=-1,edge=-1;
      for(let x=0;x<=r.width;x++){
        const alpha=x<r.width?pixels[(y*r.width+x)*4+3]!:0;
        if(alpha>=128)edge=x+1;
        if(alpha>=16){if(left<0)left=x;last=x+1;}
      }
      right[y]=edge;
      if(left>=0)outline.push({y,left,right:last});
    }
    // One closed contour has no internal row edges that can leak antialiased
    // scanlines through the face. The back arm only approaches the right edge.
    if(!outline.length)throw Error("Empty body/head silhouette");
    const margin=.3,rows=Math.ceil(margin*r.height/h),expanded:Array<{y:number;left:number;right:number}>=[];
    for(let y=outline[0]!.y-rows;y<=outline[outline.length-1]!.y+rows;y++){
      const band=outline.filter(row=>Math.abs(row.y-y)<=rows);
      if(band.length)expanded.push({y,left:Math.min(...band.map(row=>row.left))-margin*r.width/w,right:Math.max(...band.map(row=>row.right))+margin*r.width/w});
    }
    expanded.forEach((row,i)=>{const px=(row.right/r.width-pivot.x)*w,py=(row.y/r.height-pivot.y)*h;if(i)outside.lineTo(px,py);else outside.moveTo(px,py);outside.lineTo(px,py+h/r.height);});
    for(let i=expanded.length-1;i>=0;i--){const row=expanded[i]!,px=(row.left/r.width-pivot.x)*w,py=(row.y/r.height-pivot.y)*h;outside.lineTo(px,py+h/r.height);outside.lineTo(px,py);}
    outside.closePath();
    const value={outside,rightAt:(y:number)=>{
      let row=Math.max(0,Math.min(r.height-1,Math.round((y/h+pivot.y)*r.height)));
      if(right[row]!<0){let d=1;while(d<r.height&&right[Math.max(0,row-d)]!<0&&right[Math.min(r.height-1,row+d)]!<0)d++;row=right[Math.max(0,row-d)]!>=0?Math.max(0,row-d):Math.min(r.height-1,row+d);}
      return (right[row]!/r.width-pivot.x)*w;
    }};
    entries.set(key,value);return value;
  }
  const torsoShapes=Object.fromEntries(SPECIES.map(name=>{const c=characters[name],f=c.frames.torso,w=f.suggestedWidth;return [name,silhouette(c.source,f.rect,f.pivot,w,w*f.rect.height/f.rect.width)];})) as Record<Species,ReturnType<typeof silhouette>>;

const turnFootEase=(value:number)=>{const t=clamp(value),ramp=.05;if(t<ramp)return t*t/(2*ramp*(1-ramp));if(t>1-ramp)return 1-(1-t)**2/(2*ramp*(1-ramp));return(t-ramp/2)/(1-ramp);};
  const armShapes = Object.fromEntries(SPECIES.map(name => [name, Object.fromEntries((["nearArm", "farArm"] as const).map(key => {
      const f = characters[name].frames[key], w = (key === "nearArm" && name === "bird" ? 31 : f.suggestedWidth) * (f.perspectiveScale ?? 1), h = w * f.rect.height / f.rect.width, a = characters[name].hands[key];
      const elbowY=FAR_LIMBS[name]!.elbow, elbow=handPixel(characters[name].source,f,elbowY-.025,elbowY+.025);
      return [key, { f, w, h, elbow, e:{x:(elbow.x-f.pivot.x)*w*(f.mirrorX?-1:1),y:(elbow.y-f.pivot.y)*h}, v: { x: (a.x - f.pivot.x) * w * (f.mirrorX ? -1 : 1), y: (a.y - f.pivot.y) * h } }];
    }))])) as Record<Species, Record<Arm, {
    f: Frame;
    w: number;
    h: number;
    v: Point;
    e: Point;
    elbow: Point & {halfWidth:number};
  }>>;
  const cupGrips=new Map<Species,Point>(SPECIES.map(name=>[name,handPixel(characters[name].source,characters[name].frames.farArm,name==="hedgehog"?.94:.84,name==="hedgehog"?1:.97)]));
  function frontGeometry(name: Species) {
    const rig = characters[name], frame = characters[name].frontBody, r = frame.rect, h = rig.frontHeight || (name === "bird" ? 66 : 73), w = h * r.width / r.height, sole = frame.solidBounds ? (frame.solidBounds.y + frame.solidBounds.height - r.y) / r.height : 1, groundOffset = rig.frontGrounded ? h * (1 - sole) : 0;
    const feet = Object.fromEntries((["nearLeg", "farLeg"] as const).map((key, i) => { const p = characters[name].frontSoles[i]!; return [key, { x: -w / 2 + p.x * w / r.width, y: -h + groundOffset + p.y * h / r.height }]; }));
    return { frame, r, w, h, groundOffset, feet: feet as Record<Leg, Point> };
  }
  function footBase(name: Species, key: Leg) { const rig = characters[name], f = rig.frames.torso, w = f.suggestedWidth, near = (rig.joints.nearLeg.x - f.pivot.x) * w, far = (rig.joints.farLeg.x - f.pivot.x) * w; return (near + far) / 2 + (key === "nearLeg" ? -3.4 : 3.4); }
  function projectGait(pose: Pose, name: Species, tangent: Point, direction: number) {
    const data = characters[name], torso = data.frames.torso, depth = 1 - Math.abs(tangent.x);
    for (const key of ["nearFoot", "farFoot"] as const) {
      const foot = pose[key], leg = key === "nearFoot" ? "nearLeg" : "farLeg", anatomical = (data.joints[leg].x - torso.pivot.x) * torso.suggestedWidth, base = footBase(name, leg), along = foot.x;
      foot.x = along * tangent.x / direction + (anatomical - base) * depth / 110;
      foot.groundY = along * tangent.y;
    }
  }
  /**
   * The pose a figure is drawn in: the scene's pose with its routine's changes added (not to a paw
   * kept for the help gesture), the blink within its range, and both paws off the floor on a cushion.
   */
  function posed(options: DrawOptions): Pose {
    const { species: name, sit = 0, routine = null, reserveNearHand = false, support = null } = options;
    const pose: Pose = { ...options.pose };
    if (routine)
      for (const [key, value] of Object.entries(routine!.poseDelta) as [
        keyof RoutineFrame["poseDelta"],
        number
      ][])
        if (!(reserveNearHand && key === "nearArmAngle"))
          pose[key] = (pose[key] || 0) + value;
    pose.blink = clamp(pose.blink);
    if (support && sit > 0) {
      pose.nearFoot = { ...pose.nearFoot, stance: false };
      pose.farFoot = { ...pose.farFoot, stance: false };
    }
    if (name === "dog" && routine?.kind === "stroll-sip")
      pose.headAngle += .04 * Math.sin(Math.PI * clamp(routine!.progress / .26)) ** 2;
    return pose;
  }
  /**
   * Where a figure's body lies in its own frame (character units, `rotate` taking a torso point there)
   * and the whole figure's seat translation (`renderOffsetX/Y`, room units). `pose` is the pose it
   * is drawn in (`posed`). Both `draw` and `placement` place the body with this, so what is drawn and
   * where its name goes cannot differ.
   */
  function seated(name: Species, pose: Pose, turn: number, sit: number, support: Point | null, y: number, height: number, deskSeat: Station | null = null, originX = 0, direction = 1, shoulderDrop = 0) {
    const rig = characters[name];
    const unit = height / 110, turning = turn > 0 && turn < 1;
    const yaw = ease(Math.min(turn / .29, (1 - turn) / .29));
    const torso = rig.frames.torso, tw = torso.suggestedWidth, th = tw * torso.rect.height / torso.rect.width;
    // The compact bird sits higher on the desk chair; fade the rise with its
    // sit/stand transition. Cushions keep their own measured support height.
    const birdDeskRise = name === "bird" && !support ? 10 * clamp(sit / .55) : 0;
    const baseY = mix(name === "bird" ? -14 : -18, -22, yaw) + sit * 7 - birdDeskRise;
    let bodyY = baseY + (turning ? 0 : pose.bodyY * 110);
    // Rock the body over its rigid paws while leaving a cushion; the artwork never stretches.
    const seatReach = clamp(sit / 0.7), seatFootMix = 1 - (1 - seatReach) ** 2;
    let bodyX = support && !["cat", "bird"].includes(name) ? (["rabbit", "fox"].includes(name) ? 16 : 12) * Math.min(seatFootMix, ease((1 - sit) / 0.3)) : 0;
    const bodyAngle = turning ? 0 : pose.bodyAngle - sit * (support ? .10 : .025);
    const rotate = (p: Point) => ({ x: bodyX + p.x * Math.cos(bodyAngle) - p.y * Math.sin(bodyAngle), y: bodyY + p.x * Math.sin(bodyAngle) + p.y * Math.cos(bodyAngle) });
    const seatPixel = rig.soles.torso;
    const contact = deskSeat && !support ? torso.seatSupport : { x: seatPixel.x / torso.rect.width, y: seatPixel.y / torso.rect.height };
    if (!contact) throw new Error("Missing desk seat support for " + name);
    const seatLocal = { x: (contact.x - torso.pivot.x) * tw, y: (contact.y - torso.pivot.y) * th };
    const joint = (key: keyof Character["joints"]) => ({ x: (rig.joints[key].x - torso.pivot.x) * tw, y: (rig.joints[key].y - torso.pivot.y) * th + (key === "nearArm" || key === "farArm" ? shoulderDrop : 0) });
    const deskOffset = { x: 0, y: 0 };
    const deskMix = deskSeat && !support && !turning ? ease(clamp(sit / .55)) : 0;
    if (deskSeat && deskMix > 0) {
      // The seat supports the body. Lean about that point, never chase a hand target.
      const rotatedX = seatLocal.x * Math.cos(bodyAngle) - seatLocal.y * Math.sin(bodyAngle);
      const rotatedY = seatLocal.x * Math.sin(bodyAngle) + seatLocal.y * Math.cos(bodyAngle);
      bodyX += (seatLocal.x - rotatedX) * deskMix;
      bodyY += (seatLocal.y - rotatedY - pose.bodyY * 110) * deskMix;
      deskOffset.x = (deskSeat.chair.seat.x - originX - seatLocal.x * unit * direction) * deskMix;
      deskOffset.y = (deskSeat.chair.seat.y - y - (baseY + seatLocal.y) * unit) * deskMix;
    }
    const renderOffsetY = support && sit > 0 ? sit * (support.y - y - rotate(seatLocal).y * unit) : deskOffset.y;
    return { unit, turning, yaw, torso, tw, th, bodyX, bodyY, bodyAngle, seatFootMix, rotate, seatLocal, deskMix, renderOffsetY, renderOffsetX: deskOffset.x, joint };
  }
  function placement(options: DrawOptions): Point {
    const { species, turn = 0, sit = 0, support = null, deskSeat = null, x, y, height, direction = 1, shoulderDrop = 0 } = options;
    const frame = seated(species, posed(options), turn, sit, support, y, height, deskSeat, x, direction, shoulderDrop);
    return { x: frame.renderOffsetX, y: frame.renderOffsetY };
  }
  function draw(ctx: CanvasRenderingContext2D, options: DrawOptions): Drawn {
    const { species: name, appearance, x: originX, y, height, direction = 1, turn = 0, sit = 0, work = false, alpha = 1, shadow = true, routine = null, heldProp = null, reserveNearHand = false, raisedHand = 0, workstation = null, deskSeat = null, support = null, windowSill = null, layer = "all", face = null, shoulderDrop = 0 } = options;
    const drawBody = layer !== "hands", drawHands = layer !== "body";
    const pose = posed(options);
    const rig = characters[name], source = rig.source;
    if (!rig)
      throw new Error("Unknown cutout species: " + name);
    // Looking and nodding rotate around the measured neck section. Translating
    // the whole head moved its neck out of the collar during routine/survey sums.
    const faceReach = routine?.handMode === "yawn" ? .45* routine.handMix : 0;
    const headAngle = pose.headAngle + Math.atan(pose.lookX * 110 / (rig.frames.head.suggestedWidth * .9)) + pose.headY * 2 + faceReach;
    const { unit, turning, bodyX, bodyY, bodyAngle, rotate, seatLocal, deskMix, renderOffsetY, renderOffsetX, joint } = seated(name, pose, turn, sit, support, y, height, deskSeat, originX, direction, shoulderDrop);
    const x = originX + renderOffsetX;
    const facing = turn >= .5 ? -direction : direction;
    // Head and body change view together, with a shared neck socket and whole-figure turn.
    const front = turn >= .29 && turn <= .71;
    const footYaw = turnFootEase(Math.min(turn / .29, (1 - turn) / .29));
    const turnWidth = 1 - .055 * Math.sin(Math.PI * turn) ** 2;
    // Every activity uses the same measured shoulder sockets. The tired posture
    // moves both shoulders together with the authored slump.
    const far = joint("farArm"), near = joint("nearArm"), armBase = mix(-.04 * sit, -.28, deskMix);
    const nearShape=armShapes[name].nearArm, farShape=armShapes[name].farArm;
    const nearAngle=armBase+pose.nearArmAngle;
    const nearRest={x:near.x+nearShape.v.x*Math.cos(nearAngle)-nearShape.v.y*Math.sin(nearAngle),y:near.y+nearShape.v.x*Math.sin(nearAngle)+nearShape.v.y*Math.cos(nearAngle)};
    const reach=name==="bird"?Math.hypot(farShape.v.x,farShape.v.y):Math.hypot(farShape.e.x,farShape.e.y)+Math.hypot(farShape.v.x-farShape.e.x,farShape.v.y-farShape.e.y);
    const edgeReach=FAR_LIMBS[name]!.restEdge ?? .17;
    function outerGrip(desiredY:number){
      let y=desiredY,x=torsoShapes[name].rightAt(y)+farShape.w*edgeReach;
      for(let step=0;step<80&&Math.hypot(x-far.x,y-far.y)>reach*.97&&y>far.y+2;step++){
        y-=.25;x=torsoShapes[name].rightAt(y)+farShape.w*edgeReach;
      }
      return {x,y};
    }
    // Keep the approved basic silhouette outside a desk chair. The desk's
    // relaxed arm is a separate base pose, blended by physical seating rather
    // than the work flag so stopping work cannot switch it while still seated.
    const baseRest = outerGrip(nearRest.y - 4);
    const relaxed = Math.atan2(nearShape.v.y, nearShape.v.x) + armBase;
    const baseAngle = Math.atan2(baseRest.y - far.y, baseRest.x - far.x);
    const angle = baseAngle + Math.atan2(Math.sin(relaxed - baseAngle), Math.cos(relaxed - baseAngle)) * deskMix;
    const radius = mix(Math.hypot(baseRest.x - far.x, baseRest.y - far.y), Math.hypot(farShape.v.x, farShape.v.y), deskMix);
    const resting = name === "bird" || deskMix === 0 ? baseRest : { x: far.x + radius * Math.cos(angle), y: far.y + radius * Math.sin(angle) };
    const restX=resting.x,restY=resting.y;
    const rx=restX-far.x,ry=restY-far.y,swing=pose.farArmAngle;
    const naturalHands={nearArm:nearRest,farArm:{x:far.x+rx*Math.cos(swing)-ry*Math.sin(swing),y:far.y+rx*Math.sin(swing)+ry*Math.cos(swing)}};
    // Preserve the accepted standing wing silhouette: its old rigid tip was
    // on the native socket-to-palm circle. Only interactions fold its two bones.
    if(name==="bird"){
      const angle=Math.atan2(naturalHands.farArm.y-far.y,naturalHands.farArm.x-far.x),radius=Math.hypot(farShape.v.x,farShape.v.y);
      naturalHands.farArm={x:far.x+radius*Math.cos(angle),y:far.y+radius*Math.sin(angle)};
    }
    const visualY = y + renderOffsetY;
    const frontShape = frontGeometry(name);
    const seatedMix = deskMix || (support ? (name === "bird" ? Math.sin(Math.PI * .5 * clamp(sit)) : ease(sit)) : 0), birdSeat = name === "bird" && Boolean(support || deskSeat), tucked = birdSeat && (deskSeat ? deskMix : sit) >= .92;
    const world = (p: Point, face = 1) => ({ x: x + p.x * unit * turnWidth * face, y: visualY + p.y * unit });
    function part(key: Limb, px: number, py: number, angle = 0, { width, sourceImage = source, rect, pivot, scaleX = 1, scaleY = 1, shear = 0 }: {
      width?: number;
      sourceImage?: CanvasImageSource;
      rect?: Rect;
      pivot?: Point;
      scaleX?: number;
      scaleY?: number;
      shear?: number;
    } = {}) {
      const f = rig.frames[key], r = rect || f.rect, w = width || f.suggestedWidth, h = w * r.height / r.width, p = pivot || f.pivot;
      const neck = key === "head" && !front ? NECKS[name] : undefined;
      const headSource = neck ? compactNeck(sourceImage, r, rig.frames.head, p, w, h, neck) : null;
      const colored = headSource ? { source: headSource, rect: { x: 0, y: 0, width: r.width, height: r.height } } : (rig.coloredParts || ["torso"]).includes(key) ? (appearance ? material.paint(sourceImage, characters[name].sideMask, r, appearance.color, name + ":" + key, name) : { source: sourceImage, rect: r }) : { source: sourceImage, rect: r }, c = colored.rect;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      ctx.transform(scaleX, 0, shear, scaleY, 0, 0);
      if (drawBody)
        ctx.drawImage(colored.source, c.x, c.y, c.width, c.height, -p.x * w, -p.y * h, w, h);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    if (shadow && drawBody && !(support && sit > 0)) {
      ctx.fillStyle = "#51432c19";
      ctx.beginPath();
      ctx.ellipse(x, y + unit, 27 * unit, 4.5 * unit, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (support && sit > 0 && drawBody) {
      ctx.save();
      ctx.globalAlpha = alpha * sit * .16;
      ctx.fillStyle = "#463d29";
      ctx.beginPath();
      ctx.ellipse(support.x, support.y + unit, 18 * unit, 3 * unit, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.translate(x, visualY);
    ctx.scale(unit * turnWidth, unit);
    if (!front) {
      ctx.save();
      ctx.scale(facing, 1);
      // One torso and the same two haunch/paw sprites remain throughout sitting.
      // No alternate pelvis or foot artwork is swapped in at a progress threshold.
      const legs = ([["farLeg", pose.farFoot], ["nearLeg", pose.nearFoot]] as const).map(([key, foot]) => {
        const f = rig.frames[key], w = f.suggestedWidth * (name === "rabbit" ? 1.06 : 1.02), h = w * f.rect.height / f.rect.width * (name === "rabbit" ? 1.4 : name === "bird" ? 1.3 : 1.25), pixels = characters[name].soles[key];
        const g = { key, f, w, h, hip: rotate(joint(key)), footX: footBase(name, key) + foot.x * 110, footY: ((foot.groundY || 0) - foot.lift) * 110, pixels, angle: foot.lift > 0 ? foot.angle : 0, solePoint(px: number): Point { const dx = (px - pixels.x) * w / f.rect.width; return { x: this.footX + dx * Math.cos(this.angle), y: this.footY + dx * Math.sin(this.angle) }; } };
        // Spread and pivot the real side soles into the authored front soles
        // before changing art. No foot changes location at the view boundary.
        if (turning && !support) {
          const target = frontShape.feet[key];
          g.footX = mix(g.footX, target.x / facing, footYaw);
          g.footY = mix(g.footY, target.y, footYaw);
        }
        // The little bird folds its rigid feet behind the round belly. No
        // claw-bearing seated cutout is used; hidden feet have no visible landmarks.
        if (birdSeat) {
          const belly = rotate(seatLocal);
          const [ahead,down]=CUSHION_FEET.bird[key];
          g.footX = mix(g.footX, belly.x + ahead, seatedMix);
          g.footY = mix(g.footY, belly.y + down, seatedMix);
        }
        return g;
      });
      if ((support || deskMix > 0) && !birdSeat) {
        const pelvis = rotate(seatLocal), placement = CUSHION_FEET[name]!;
        for (const g of legs) {
          const [ahead, down, angle] = placement[g.key];
          g.footX = mix(g.footX, pelvis.x + ahead, seatedMix);
          g.footY = mix(g.footY, pelvis.y + down, seatedMix);
          g.angle = mix(g.angle, angle, seatedMix);
        }
      }
      for (const g of legs) {
        const { f, w, h, footX, footY, pixels, angle } = g;
        // Keep the authored rounded paw silhouette rigid. Its upper haunch is
        // hidden under the belly rather than stretched from the hip to the floor.
        ctx.save();
        ctx.translate(footX, footY);
        ctx.rotate(angle);
        if (drawBody && !tucked)
          ctx.drawImage(source, f.rect.x, f.rect.y, f.rect.width, f.rect.height, -pixels.x * w / f.rect.width, -pixels.y * h / f.rect.height, w, h);
        ctx.restore();
      }
      ctx.save();
      ctx.translate(bodyX, bodyY);
      ctx.rotate(bodyAngle);
      const hp = joint("head");
      const neckX = hp.x, neckY = hp.y;
      // Keep the mouth registered to source art when the neck pivot is measured
      // off-centre. Prop targets must move with the face, not the old crop centre.
      const headFrame = rig.frames.head, [mouthSourceX,mouthSourceY] = FAR_LIMBS[name]!.mouth;
      const mouthOffset = { x: headFrame.suggestedWidth * (mouthSourceX-headFrame.pivot.x), y: headFrame.suggestedWidth * headFrame.rect.height / headFrame.rect.width * (mouthSourceY-headFrame.pivot.y) };
      const mouthLocal = { x: neckX + mouthOffset.x * Math.cos(headAngle) - mouthOffset.y * Math.sin(headAngle), y: neckY + mouthOffset.x * Math.sin(headAngle) + mouthOffset.y * Math.cos(headAngle) };
      const faceFrame=face!==null?faces.species[name][face]:null;
      const headRect=faceFrame?.rect ?? (pose.blink>.36?characters[name].blink:headFrame.rect);
      const headSource=faceFrame?faceImage:pose.blink>.36?characters[name].expressionImage:source;
      const headWidth=faceFrame?headFrame.suggestedWidth*faceFrame.crop.width/headFrame.rect.width:headFrame.suggestedWidth;
      const headPivot=faceFrame?{x:(headFrame.pivot.x*headFrame.rect.width-faceFrame.crop.x)/faceFrame.crop.width,y:(headFrame.pivot.y*headFrame.rect.height-faceFrame.crop.y)/faceFrame.crop.height}:headFrame.pivot;
      const headHeight=headWidth*headRect.height/headRect.width;
      const compact=NECKS[name]?compactNeck(headSource,headRect,headFrame,headPivot,headWidth,headHeight,NECKS[name]!):null;
      const headShape=silhouette(compact??headSource,compact?{x:0,y:0,width:headRect.width,height:headRect.height}:headRect,headPivot,headWidth,headHeight);
      const headOutside=new Path2D();headOutside.addPath(headShape.outside,new DOMMatrix().translate(neckX,neckY).rotate(headAngle*180/Math.PI));
      function clipBackLayer(behindHead=true){ctx.clip(torsoShapes[name].outside,"evenodd");if(behindHead)ctx.clip(headOutside,"evenodd");}
      function besideCheek(down=7){
        const local={x:headShape.rightAt(mouthOffset.y+down)+armShapes[name].farArm.w*.12,y:mouthOffset.y+down};
        return {x:neckX+local.x*Math.cos(headAngle)-local.y*Math.sin(headAngle),y:neckY+local.x*Math.sin(headAngle)+local.y*Math.cos(headAngle)};
      }

      const inverseWorld = (point: Point) => {
        const px = (point.x - x) / (unit * turnWidth * facing) - bodyX, py = (point.y - visualY) / unit - bodyY;
        return { x: px * Math.cos(bodyAngle) + py * Math.sin(bodyAngle), y: -px * Math.sin(bodyAngle) + py * Math.cos(bodyAngle) };
      };
      const goals: Partial<Record<Arm, Point>> = {}, mixes: Partial<Record<Arm, number>> = {}, renderedHands: Partial<Record<Arm, Point>> = {};
      // Rotate around the shoulder while blending reach. A straight interpolation
      // through the shoulder crushed the sprite halfway through waves and yawns.
      function handArc(key: Arm, start: Point, end: Point, t: number, arcReference: number | null = null) {
        if (t <= 0)
          return start;
        if (t >= 1)
          return end;
        const s = joint(key), f = rig.frames[key], p = characters[name].hands[key];
        // Keep winding anchored to the authored resting arm. A moving start angle
        // must not choose a different semicircle when it crosses the target antipode.
        const reference = arcReference ?? (key==="farArm"?Math.atan2(ry,rx):Math.atan2((p.y-f.pivot.y)*f.rect.height/f.rect.width,(p.x-f.pivot.x)*(f.mirrorX?-1:1))+armBase);
        const angleAt = (point: Point) => { const a = Math.atan2(point.y - s.y, point.x - s.x) - reference; return reference + Math.atan2(Math.sin(a), Math.cos(a)); };
        const a = angleAt(start), b = angleAt(end), radius = mix(Math.hypot(start.x - s.x, start.y - s.y), Math.hypot(end.x - s.x, end.y - s.y), t), angle = mix(a, b, t);
        return { x: s.x + Math.cos(angle) * radius, y: s.y + Math.sin(angle) * radius };
      }
      const aim = (key: Arm, point: Point, weight = 1) => { if (!(reserveNearHand && key === "nearArm")) {
        if (goals[key])
          goals[key] = handArc(key, goals[key]!, point, clamp(weight), work ? -Math.PI / 2 : null);
        else {
          goals[key] = point;
          mixes[key] = clamp(weight);
        }
      } };
      const handMix = routine?.handMix || 0, mode = routine?.handMode;
      if (work && workstation && mode!=="note") {
        aim("nearArm", inverseWorld(workstation.nearHand), workstation.contactMix ?? 1);
        aim("farArm", inverseWorld(workstation.farHand), workstation.contactMix ?? 1);
      }
      if (mode === "keyboard" && workstation) {
        const tapping = (key: "nearHand" | "farHand", value: number) => { const point = inverseWorld(workstation[key]); return { ...point, y: point.y - Math.abs(value) * 4 }; };
        aim("nearArm", tapping("nearHand", routine!.poseDelta.nearArmAngle));
        aim("farArm", tapping("farHand", routine!.poseDelta.farArmAngle));
      }
      else if (mode === "chin") aim("farArm",besideCheek(10),handMix);
      else if (mode === "yawn")
        // Cover the mouth with the camera-side limb. Pulling the hidden far
        // forearm through the cheek required an impossible foreground fragment.
        aim("nearArm", {x:mouthLocal.x-headFrame.suggestedWidth*.18,y:mouthLocal.y+5}, handMix);
      else if (mode === "stretch" && routine?.kind === "stroll-stretch") {
        // On a stroll, each its own: the otter's arms wide, the cat's paws forward as its back lengthens,
        // the bird's wings out, the dog's shoulders up, the rabbit's paws high, the fox's lopsided, the
        // panda's big, the hedgehog's close to its body.
        const own: Record<Species, readonly [readonly [number, number], readonly [number, number]]> = { otter: [[-18, 4], [16, 2]], cat: [[16, 14], [20, 12]], bird: [[-26, 0], [22, -4]], dog: [[-12, -12], [10, -10]], rabbit: [[-6, -26], [6, -24]], fox: [[-10, -22], [14, 10]], panda: [[-21, -10], [21, -8]], hedgehog: [[-8, -4], [8, 4]] }, [a, b] = own[name];
        aim("nearArm", { x: near.x + a[0], y: near.y + a[1] }, handMix);
        aim("farArm", { x: far.x + b[0], y: far.y + b[1] }, handMix);
      }
      else if (mode === "prop" && name!=="hedgehog" && name!=="bird") aim("farArm",besideCheek(10),handMix);
      else if (mode === "loosen") {
        // Loosen each wrist beside the body. A far target inside the chest
        // disappears behind the required torso occlusion.
        const circle = routine!.poseDelta.nearArmAngle * 40;
        aim("farArm", outerGrip(naturalHands.farArm.y-3+circle*.2), handMix);
        aim("nearArm", { x: nearRest.x+circle*.2, y: nearRest.y-3 }, handMix);
      }
      else if (mode === "habit" && name !== "dog") {
        // The otter fidgets with its paws at the body edges; both remain visible.
        const rub = routine!.poseDelta.nearArmAngle * 40;
        aim("farArm", outerGrip(naturalHands.farArm.y-1+rub*.12), handMix);
        aim("nearArm", { x: nearRest.x+rub*.15, y: nearRest.y-2 }, handMix);
      }
      else if (mode === "stretch") {
        const gestures: Record<Species, readonly [
          readonly [
            number,
            number
          ],
          readonly [
            number,
            number
          ]
        ]> = { cat: [[-15, -11], [12, -8]], otter: [[-16, 5], [14, 3]], bird: [[-24, 2], [20, -3]], dog: [[-14, -9], [12, 5]], rabbit: [[-12, -18], [10, -11]], fox: [[-16, -7], [11, 7]], panda: [[-15, 6], [15, 5]], hedgehog: [[-12, -5], [10, 7]] }, [a, b] = name === "bird" && work ? ([[-19, -24], [20, -22]] as const) : gestures[name], amount = work ? .78 : 1;
        aim("nearArm", { x: near.x + a[0] * amount, y: near.y + a[1] * amount }, handMix);
        aim("farArm", { x: far.x + b[0] * amount, y: far.y + b[1] * amount }, handMix);
      }
      else if (mode === "wave") {
        const { v } = armShapes[name].nearArm, radius = Math.hypot(v.x, v.y) * 1.05, angle = Math.PI + .45 + 1.2 * (routine!.poseDelta.nearArmAngle + .7 * handMix);
        aim("nearArm", { x: near.x + radius * Math.cos(angle), y: near.y + radius * Math.sin(angle) }, handMix);
      }
      else if (mode === "gesture")
        aim("nearArm", { x: near.x + 14, y: near.y + 2 + routine!.poseDelta.nearArmAngle * 15 }, handMix);
      else if (mode === "sill" && windowSill) {
        const target = inverseWorld(windowSill), reach = Math.hypot(target.x - far.x, target.y - far.y);
        if (!heldProp && reach <= 35)
          aim("farArm", target, handMix);
      }
      // Prop coordinates are in the same torso frame as the visible hand pixels.
      // Cup goes in the far hand, leaving the near hand free for help signals.
      const propKind = routine?.prop?.kind || heldProp;
      let farGripVector=farShape.v;
      let object: {
        kind: PropKind;
        frame: PropAtlas["frames"][PropKind];
        w: number;
        h: number;
        pivot: Point;
        origin: Point;
        angle: number;
        cupYaw?: number;
        frontGrip?: number;
        shear?: number;
      } | null = null;
      let tableNote = false;
      if (propKind === "cup") {
        const sniff = name === "dog" && routine?.kind === "stroll-sip" ? .85 * Math.sin(Math.PI * clamp(routine!.progress / .26)) ** 2 : 0;
        const f = props.frames.cup, w = 20, h = w * f.rect.height / f.rect.width, lift = Math.max(routine?.prop?.lift || 0, sniff);
        const turn=clamp(lift),nativeLip=f.normalizedAnchors["lip"]!,nativeHandle=f.normalizedAnchors["handle"]!,lowerHandle=f.normalizedAnchors["handleLower"]!,center=f.normalizedAnchors["teaCenter"]!;
        // The handle and the rim contact roll together around the cylinder.
        // Its body stays upright and never collapses or flips sideways.
        const cupYaw=Math.cos(Math.PI*turn);
        const lip={x:center.x+(nativeLip.x-center.x)*cupYaw,y:nativeLip.y};
        const handle={x:center.x+(mix(nativeHandle.x,lowerHandle.x,turn)-center.x)*cupYaw,y:mix(nativeHandle.y,lowerHandle.y,turn)};
        const finger=cupGrips.get(name)!,frame=farShape.f;
        farGripVector={x:mix(farShape.v.x,(finger.x-frame.pivot.x)*farShape.w*(frame.mirrorX?-1:1),turn),y:mix(farShape.v.y,(finger.y-frame.pivot.y)*farShape.h,turn)};
        const mouthGoal = { x: mouthLocal.x, y: mouthLocal.y };
        const delta = { x: (handle.x - lip.x) * w, y: (handle.y - lip.y) * h };
        const minimum=Math.abs(Math.hypot(farShape.e.x,farShape.e.y)-Math.hypot(farGripVector.x-farShape.e.x,farGripVector.y-farShape.e.y));
        const maximum=Math.hypot(farShape.e.x,farShape.e.y)+Math.hypot(farGripVector.x-farShape.e.x,farGripVector.y-farShape.e.y);
        // The mug has its own upright frame. Sitting or leaning the torso must
        // not tip a carried drink; only the sip changes its room-space angle.
        const inRoom=(p:Point)=>({x:p.x*Math.cos(bodyAngle)-p.y*Math.sin(bodyAngle),y:p.x*Math.sin(bodyAngle)+p.y*Math.cos(bodyAngle)});
        const sip= routine?.prop?.lift||0;
        const sipAngle=sip>0?cupAngleForReach(inRoom(far),inRoom(mouthGoal),delta,minimum,maximum,routine!.prop!.tilt/sip):0;
        const tilt=sip*sipAngle-bodyAngle;
        const raised = { x: mouthGoal.x + delta.x * Math.cos(tilt) - delta.y * Math.sin(tilt), y: mouthGoal.y + delta.x * Math.sin(tilt) + delta.y * Math.cos(tilt) };
        const low=naturalHands.farArm;
        object = { kind: "cup", frame: f, w, h, pivot: handle, origin: handArc("farArm", low, raised, lift), angle: tilt,cupYaw,frontGrip:ease(clamp((lift-.35)/.25)) };
      }
      else if (propKind === "notepad" && workstation?.note) {
        tableNote = true;
        const writing = inverseWorld(workstation.note.anchors["writingSurface"]!);
        writing.x += routine!.poseDelta.nearArmAngle * 22;
        writing.y += routine!.poseDelta.nearArmAngle * 6;
        aim("nearArm", { x: writing.x - 2, y: writing.y - 4 }, handMix);
        // On paper, steady the outer edge. On a laptop, steady the top of the
        // screen while the near paw writes in the separate note on the other side.
        const screenA=workstation.screen[0]!,screenB=workstation.screen[1]!;
        const support=workstation.tool==="laptop"
          ? {x:mix(screenA.x,screenB.x,.42),y:mix(screenA.y,screenB.y,.42)-unit}
          : workstation.note.anchors["rightGrip"]!;
        aim("farArm",inverseWorld(support),handMix);
      }
      else if (propKind === "newspaper" || propKind === "notepad") {
        const paper = propKind === "newspaper", openness = routine!.prop!.openness;
        const f = props.frames[propKind], w = paper ? mix(31, 48, openness) : 42, h = w * f.rect.height / f.rect.width * (paper ? .62 : .65);
        object = { kind: propKind, frame: f, w, h, pivot: { x: .5, y: .8 }, origin: { x: 5, y: mix(-8, -17, paper ? routine!.prop!.lift : handMix) + (paper && name === "bird" ? 9 : 0) }, angle: routine!.prop!.tilt + routine!.prop!.pageTurn * .065,shear:paper?-.38:0 };
      }
      function objectPoint(anchor: string): Point {
        const current = object!;
        const a = current.kind==="cup"&&anchor==="handle"?current.pivot:current.frame.normalizedAnchors[anchor]!,dy = (a.y - current.pivot.y) * current.h,dx = (a.x - current.pivot.x) * current.w+(current.shear||0)*dy;
        return { x: current.origin.x + dx * Math.cos(current.angle) - dy * Math.sin(current.angle), y: current.origin.y + dx * Math.sin(current.angle) + dy * Math.cos(current.angle) };
      }
      if (object) {
        if (object.kind === "cup") {
          goals.farArm = objectPoint("handle");
          mixes.farArm = 1;

        }
        else {
          const support=outerGrip(naturalHands.farArm.y-(object.kind==="notepad"?6:2)*(routine?.prop?.lift||handMix));
          if(object.kind==="newspaper"){
            // Read at arm's length instead of displaying the paper on the chest.
            // Both grips move forward in the character's frame; the nearer arm
            // retains its authored radius and the far elbow retains its bend.
            const nearReach=Math.hypot(nearShape.v.x,nearShape.v.y);
            aim("nearArm",{x:near.x+nearReach*.88,y:near.y+nearReach*.48},handMix);
            aim("farArm",{x:far.x+reach*.92,y:far.y+reach*.28},handMix);
          }else{
            aim("farArm",support,handMix);
            const a=object.frame.normalizedAnchors["rightGrip"]!;
            const dx=(a.x-object.pivot.x)*object.w,dy=(a.y-object.pivot.y)*object.h;
            object.origin={x:support.x-dx*Math.cos(object.angle)+dy*Math.sin(object.angle),y:support.y-dx*Math.sin(object.angle)-dy*Math.cos(object.angle)};
            const writing=objectPoint("writingSurface");
            aim("nearArm",{x:writing.x-2,y:writing.y-4},handMix);
          }
        }
      }
      // Raise the original short limb around its shoulder; its silhouette stays rigid.
      if (raisedHand > 0) {
        const { v } = armShapes[name].nearArm, radius = Math.hypot(v.x, v.y), angle = Math.PI + 1.36;
        goals.nearArm = { x: near.x + radius * Math.cos(angle), y: near.y + radius * Math.sin(angle) };
        mixes.nearArm = clamp(raisedHand);
      }
      const naturalDesk = work && workstation && name !== "bird" && !object && !reserveNearHand && raisedHand === 0 && (!mode || ["keyboard", "keyboard-rest"].includes(mode));
      function handTarget(key: Arm): Point {
        const {v}=armShapes[name][key],shoulder=joint(key),natural=naturalHands[key];
        const goal = goals[key], weight = mixes[key] || 0, target = naturalDesk ? natural : goal ? handArc(key, natural, goal, weight) : natural;
        if (key === "farArm") return target;
        const theta = Math.atan2(target.y - shoulder.y, target.x - shoulder.x), radius = Math.hypot(v.x, v.y);
        return { x: shoulder.x + radius * Math.cos(theta), y: shoulder.y + radius * Math.sin(theta) };
      }
      const fs = armShapes[name].farArm, farTarget=handTarget("farArm");
      const farPose = articulateArm(far,fs.e,{x:farGripVector.x-fs.e.x,y:farGripVector.y-fs.e.y},farTarget);
      const actualHands = { nearArm: handTarget("nearArm"), farArm: farPose.hand };
      // Props follow real palms, so a far-away grip cannot stretch an animal's arm.
      // A sheet is fitted to the two grips with one similarity transform.
      if (object?.kind === "cup") {
        object.origin = actualHands.farArm;

      }
      else if(object?.kind==="notepad"){
        const a=object.frame.normalizedAnchors["rightGrip"]!,dx=(a.x-object.pivot.x)*object.w,dy=(a.y-object.pivot.y)*object.h;
        object.origin={x:actualHands.farArm.x-dx*Math.cos(object.angle)+dy*Math.sin(object.angle),y:actualHands.farArm.y-dx*Math.sin(object.angle)-dy*Math.cos(object.angle)};
        if(!reserveNearHand&&raisedHand===0){
          const writing=objectPoint("writingSurface");
          goals.nearArm={x:writing.x-2+routine!.poseDelta.nearArmAngle*8,y:writing.y-4};mixes.nearArm=handMix;
          actualHands.nearArm=handTarget("nearArm");
        }
      }
      else if (object) {
        const left = object.frame.normalizedAnchors["leftGrip"]!;
        const right = object.frame.normalizedAnchors["rightGrip"]!;
        const dy = (right.y - left.y) * object.h, dx = (right.x - left.x) * object.w+(object.shear||0)*dy;
        const a = actualHands.nearArm, b = actualHands.farArm;
        const scale = Math.hypot(b.x-a.x,b.y-a.y) / Math.hypot(dx,dy);
        object.angle = Math.atan2(b.y-a.y,b.x-a.x) - Math.atan2(dy,dx);
        object.w *= scale; object.h *= scale;
        const oy = (left.y-object.pivot.y)*object.h,ox = (left.x-object.pivot.x)*object.w+(object.shear||0)*oy;
        object.origin = {x:a.x-ox*Math.cos(object.angle)+oy*Math.sin(object.angle),y:a.y-ox*Math.sin(object.angle)-oy*Math.cos(object.angle)};
      }
      function arm(key: Arm, stage: "upper"|"forearm"|"paw"|"whole" = "whole") {
        const isFar=key==="farArm";
        if (isFar && stage==="upper" && !drawBody) return;
        if (isFar && stage==="forearm" && !drawBody && !(workstation&&layer==="hands")) return;
        if (stage==="paw" && !drawHands && !(workstation&&layer==="body")) return;
        const { f,w,h,v,elbow }=armShapes[name][key], shoulder=joint(key), target=actualHands[key];
        const isUpper=stage==="upper",lower=isFar&&!isUpper;
        const pivot=lower?elbow:f.pivot, origin=lower?farPose.elbow:shoulder;
        const rotation=isFar?(isUpper?farPose.upperRotation:farPose.lowerRotation):Math.atan2(target.y-shoulder.y,target.x-shoulder.x)-Math.atan2(v.y,v.x);
        const colored = (rig.coloredParts || ["torso"]).includes(key) ? (appearance ? material.paint(source, characters[name].sideMask, f.rect, appearance.color, name + ":" + key, name) : { source, rect: f.rect }) : { source, rect: f.rect }, c = colored.rect;
        ctx.save();
        // This is the back layer, including desk restoration and prop grips.
        // The torso always occludes the far arm. The face also hides its sleeve;
        // only the grip wraps in front of a cup held in front of the face.
        if(isFar)clipBackLayer(object?.kind!=="cup"||stage!=="paw");
        if(work&&workstation&&layer!=="all"&&!(isFar&&(stage==="upper"||stage==="forearm"&&layer==="body"))){
          // Restore only the forearm area covered by the desktop. The face already
          // occludes the forearm in the body pass; never repaint a sleeve over it.
          const edge=workstation.foregroundY;
          const top=layer==="hands"?(stage==="forearm"?workstation.rearY:y-height*4):edge;
          const bottom=layer==="hands"?edge:y+height*4;
          const polygon=[{x:x-height*4,y:top},{x:x+height*4,y:top},{x:x+height*4,y:bottom},{x:x-height*4,y:bottom}].map(inverseWorld);
          ctx.beginPath();polygon.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.clip();
        }
        ctx.translate(origin.x,origin.y);ctx.rotate(rotation);ctx.scale(f.mirrorX?-1:1,1);
        if(isFar&&name==="otter"&&(isUpper||stage==="forearm")){
          const hand=characters[name].hands.farArm,dx=(isUpper?f.pivot.x-elbow.x:hand.x-elbow.x)*w,dy=(isUpper?f.pivot.y-elbow.y:hand.y-elbow.y)*h,length=Math.hypot(dx,dy),ux=dx/length,uy=dy/length,nx=-uy,ny=ux;
          const ex=(elbow.x-pivot.x)*w,ey=(elbow.y-pivot.y)*h,m=500,rx=elbow.halfWidth*w*1.03,ry=Math.min(rx*.55,Math.hypot(fs.e.x,fs.e.y)*.65);
          // Cut normal to the measured limb, with a wide shallow rounded joint.
          // A horizontal crop left pointed fur corners when this arm bent.
          ctx.beginPath();ctx.moveTo(ex+nx*m,ey+ny*m);ctx.lineTo(ex-nx*m,ey-ny*m);ctx.lineTo(ex-nx*m+ux*m,ey-ny*m+uy*m);ctx.lineTo(ex+nx*m+ux*m,ey+ny*m+uy*m);ctx.closePath();
          const a=Math.atan2(uy,ux)-Math.PI/2;ctx.moveTo(ex+rx*Math.cos(a),ey+rx*Math.sin(a));ctx.ellipse(ex,ey,rx,ry,a,0,Math.PI*2);ctx.clip();
        }
        else if(isFar&&isUpper){
          const radius=Math.min(w*.28,Math.hypot(fs.e.x,fs.e.y)*.70);
          const rx=radius,ry=radius;
          ctx.beginPath();ctx.rect(-pivot.x*w,-pivot.y*h,w,elbow.y*h);
          const ex=(elbow.x-pivot.x)*w,ey=(elbow.y-pivot.y)*h;
          ctx.moveTo(ex+rx,ey);ctx.ellipse(ex,ey,rx,ry,0,0,Math.PI*2);ctx.clip();
        }
        if(isFar&&stage==="forearm"&&name!=="otter"){
          const top=elbow.y;ctx.beginPath();ctx.rect(-pivot.x*w,(top-pivot.y)*h,w,(1-top)*h);
          {const radius=Math.min(w*.28,Math.hypot(fs.e.x,fs.e.y)*.70),ex=(elbow.x-pivot.x)*w,ey=(elbow.y-pivot.y)*h,rx=radius,ry=radius;ctx.moveTo(ex+rx,ey);ctx.ellipse(ex,ey,rx,ry,0,0,Math.PI*2);}
          ctx.clip();
        }
        if(stage==="paw"){
          {
            ctx.beginPath();
            if(isFar){
              const [a,b,c]=FAR_LIMBS[name]!.farWrist!;
              ctx.moveTo(-pivot.x*w,(a.y-pivot.y)*h);ctx.lineTo((a.x-pivot.x)*w,(a.y-pivot.y)*h);
              ctx.quadraticCurveTo((b.x-pivot.x)*w,(b.y-pivot.y)*h,(c.x-pivot.x)*w,(c.y-pivot.y)*h);
              ctx.lineTo((1-pivot.x)*w,(c.y-pivot.y)*h);
            }else{
              const [base,slope]=FAR_LIMBS[name]!.nearWrist;
              ctx.moveTo(-pivot.x*w,(base-slope*.5-pivot.y)*h);ctx.lineTo((1-pivot.x)*w,(base+slope*.5-pivot.y)*h);
            }
            ctx.lineTo((1-pivot.x)*w,(1-pivot.y)*h);ctx.lineTo(-pivot.x*w,(1-pivot.y)*h);ctx.closePath();ctx.clip();
          }
        }
        if(drawBody||drawHands)ctx.drawImage(colored.source,c.x,c.y,c.width,c.height,-pivot.x*w,-pivot.y*h,w,h);
        ctx.restore();renderedHands[key]=world(rotate(target),facing);
      }
      // The arm passes behind the face. The cup, followed by its visible grip,
      // can cover the face without painting a sleeve over the cheek.
      arm("farArm","upper");
      if(object?.kind!=="cup"){
        arm("farArm","forearm");
      }
      part("torso",0,0);
      if (face !== null) {
        // A face from expression-v2 has the side head's pivot and scale, measured on a larger crop where ears were turned.
        const f = faces.species[name][face], head = rig.frames.head, w0 = head.rect.width, h0 = head.rect.height;
        part("head", neckX, neckY, headAngle, { rect: f.rect, sourceImage: faceImage, width: head.suggestedWidth * f.crop.width / w0, pivot: { x: (head.pivot.x * w0 - f.crop.x) / f.crop.width, y: (head.pivot.y * h0 - f.crop.y) / f.crop.height } });
      }
      else {
        const expression = pose.blink > .36 ? "blink" : null;
        part("head", neckX, neckY, headAngle, { rect: expression ? characters[name].blink : rig.frames.head.rect, sourceImage: expression ? characters[name].expressionImage : source });
      }
      // Near arm is continuous in front of the torso. Props cover forearms;
      // only the visible palms are painted over their grips afterwards.
      if(object?.kind==="cup"){
        arm("farArm","forearm");
      }
      arm("nearArm");
      if (object && drawHands) {
        const r = object.frame.rect;
        ctx.save();
        if (object.kind !== "cup")
          ctx.globalAlpha *= ease(Math.min(routine!.progress / .1, (1 - routine!.progress) / .12));
        ctx.translate(object.origin.x, object.origin.y);
        ctx.rotate(object.angle);
        ctx.transform(1,0,object.shear||0,1,0,0);
        if(object.kind==="cup"&&object.cupYaw!==1){
          // The original cup's left contour separates its handle from its body.
          // Their union is the unchanged source at yaw=1; only the handle turns.
          const body=new Path2D();body.moveTo(.30,-1);body.lineTo(2,-1);body.lineTo(2,2);body.lineTo(.50,2);body.lineTo(.50,1);
          body.bezierCurveTo(.36,.97,.30,.72,.275,.45);body.bezierCurveTo(.24,.25,.25,.10,.30,0);body.closePath();
          const handleMask=new Path2D();handleMask.rect(-2,-2,4,4);handleMask.addPath(body);
          const center=object.frame.normalizedAnchors["teaCenter"]!.x;
          ctx.translate(-object.pivot.x*object.w,-object.pivot.y*object.h);ctx.scale(object.w,object.h);
          const paintHandle=()=>{ctx.save();ctx.translate(center,0);ctx.scale(object.cupYaw!,1);ctx.translate(-center,0);ctx.clip(handleMask,"evenodd");ctx.drawImage(propImage,r.x,r.y,r.width,r.height,0,0,1,1);ctx.restore();};
          if(object.cupYaw!>=0)paintHandle();
          ctx.save();ctx.clip(body);ctx.drawImage(propImage,r.x,r.y,r.width,r.height,0,0,1,1);ctx.restore();
          if(object.cupYaw!<0)paintHandle();
        }else ctx.drawImage(propImage, r.x, r.y, r.width, r.height, -object.pivot.x * object.w, -object.pivot.y * object.h, object.w, object.h);
        ctx.restore();
        if (object.kind === "notepad" && !reserveNearHand && raisedHand===0) {
          const pen = actualHands.nearArm,ink=objectPoint("writingSurface");
          ctx.save();
          ctx.globalAlpha *= handMix;
          ctx.strokeStyle = "#435a4b";
          ctx.lineWidth = 1.5;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(pen.x - 3, pen.y - 5);
          ctx.lineTo(ink.x,ink.y);
          ctx.stroke();
          ctx.fillStyle = "#473b32";
          ctx.beginPath();
          ctx.arc(ink.x, ink.y, .7, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
      if(object){
        ctx.save();if(object.kind==="cup")ctx.globalAlpha*=object.frontGrip!;
        arm("farArm","paw");if(object.kind!=="cup")arm("nearArm","paw");ctx.restore();
      }
      if (tableNote && drawHands) {
        // The paw grips above the paper; the nib, not the paw centre, writes on it.
        // Paint the narrow shaft after the hand so the held instrument stays legible.
        const palm = renderedHands.nearArm!, page = workstation!.note;
        const inset = unit;
        const tipWorld = {
          x: Math.max(page.x-page.width/2+inset,Math.min(page.x+page.width/2-inset,palm.x+facing*2*unit)),
          y: Math.max(page.y-page.height/2+inset,Math.min(page.y+page.height/2-inset,palm.y+4*unit)),
        };
        const pen = inverseWorld(palm), tip = inverseWorld(tipWorld);
        const angle = Math.atan2(tip.y-pen.y,tip.x-pen.x);
        ctx.save();
        ctx.globalAlpha *= handMix;
        ctx.strokeStyle = "#435a4b";
        ctx.lineWidth = 1.3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(pen.x - 7*Math.cos(angle), pen.y - 7*Math.sin(angle));
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
      ctx.restore();
    }
    else {
      if (heldProp === "cup") {
        // During the front-facing part of a turn the carrying arm travels behind
        // the torso. Draw the continuous cup path before the torso so its temporary
        // occlusion follows the body, rather than deleting/recreating the prop.
        const f = props.frames.cup, r = f.rect, w = 20, h = w * r.height / r.width, grip = f.normalizedAnchors["handle"]!;
        const target=naturalHands.farArm;
        const gripPoint=articulateArm(far,farShape.e,{x:farShape.v.x-farShape.e.x,y:farShape.v.y-farShape.e.y},target).hand;
        const t = ease((turn - .29) / .42), cx = direction * gripPoint.x * (1 - 2 * t), cy = bodyY + gripPoint.y;
        const face = turn < .5 ? direction : -direction;
        if (drawBody) {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.scale(face, 1);
          ctx.drawImage(propImage, r.x, r.y, r.width, r.height, -grip.x * w, -grip.y * h, w, h);
          ctx.restore();
        }
      }
      const { r, h, w, groundOffset } = frontShape;
      const colored = appearance ? material.paint(characters[name].frontImage, characters[name].frontMask, r, appearance.color, name + ":front", name, { edgeReach: name === "bird" ? 8 : 0 }) : { source: characters[name].frontImage, rect: r }, c = colored.rect;
      if (drawBody)
        ctx.drawImage(colored.source, c.x, c.y, c.width, c.height, -w / 2, -h + groundOffset, w, h);
      // Front art has its own real aspect ratio. It is attached to the neck, never
      // squeezed to the side head's height or independently switched ahead of the body.
      const sideNeck = rotate(joint("head"));
      const neckY = (rig.frontGrounded ? sideNeck.y : mix(sideNeck.y, -h + 7, ease(Math.sin(Math.PI * (turn - .29) / .42)))) + (name === "fox" ? 5 : name === "rabbit" || name === "dog" ? 2 : 0);
      const frontRect = characters[name].frontHead;
      // Facing the viewer, a head angle tips the head sideways (a turn's own pose keeps it level; a glance on a stroll may tilt it).
      part("head", 0, neckY, headAngle, { rect: frontRect, sourceImage: characters[name].expressionImage, width: rig.frontHeadWidth || rig.frames.head.suggestedWidth * .96, pivot: { x: .5, y: .9 } });
    }
    ctx.restore();
    return { visualX: x, visualY, renderOffsetX, renderOffsetY };
  }

  function portrait(species: Species, appearance: Identity, pose: Pose): string {
    const key = `${species}:${appearance.paletteId}`;
    const cached = portraits.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = 144;
    canvas.height = 144;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("Canvas 2D is not available");
    draw(ctx, { species, appearance, pose, x: 72, y: 222, height: 220, turn: 0.5, shadow: false });
    const url = canvas.toDataURL("image/png");
    portraits.set(key, url);
    return url;
  }

  function hipOffset(species: Species, leg: "nearLeg" | "farLeg"): number {
    const c = characters[species];
    return ((c.joints[leg].x - c.frames.torso.pivot.x) * c.frames.torso.suggestedWidth) / 110;
  }

  return { draw, placement, portrait, hipOffset, footBase, projectGait };
}
