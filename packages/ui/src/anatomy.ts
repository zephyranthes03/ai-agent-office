import type { Species } from "./model.ts";
type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type HeadFrame = { rect: Rect; pivot: Point; suggestedWidth: number };
// Elbow fractions use the opaque arm crop, with separate upper/forearm lengths.
// Wrist curves follow the original cuff; they restore only the grip over props.
// Moving shoulder sockets must not move these source-image landmarks.
export const FAR_LIMBS: Record<Species, {elbow:number; restEdge?:number; nearWrist:readonly[number,number]; farWrist:readonly[Point,Point,Point]; mouth:readonly[number,number]}> = {
  cat:{elbow:.47,nearWrist:[.74,-.60],farWrist:[{x:0.44,y:0.83},{x:0.47,y:0.56},{x:0.75,y:0.54}],mouth:[.70,.59]},
  otter:{elbow:.48,nearWrist:[.91,-.55],farWrist:[{x:0.53,y:0.83},{x:0.62,y:0.7},{x:0.89,y:0.67}],mouth:[.73,.49]},
  bird:{elbow:.43,restEdge:.075,nearWrist:[.72,-.12],farWrist:[{x:.30,y:.88},{x:.58,y:.73},{x:.90,y:.50}],mouth:[.80,.52]},
  dog:{elbow:.47,nearWrist:[.76,-.55],farWrist:[{x:0.22,y:0.65},{x:0.42,y:0.6},{x:0.67,y:0.8}],mouth:[.70,.51]},
  rabbit:{elbow:.48,nearWrist:[.76,-.55],farWrist:[{x:0.41,y:0.82},{x:0.42,y:0.54},{x:0.82,y:0.59}],mouth:[.67,.68]},
  fox:{elbow:.46,nearWrist:[.61,-.35],farWrist:[{x:0.23,y:0.52},{x:0.42,y:0.47},{x:0.73,y:0.65}],mouth:[.75,.60]},
  panda:{elbow:.46,nearWrist:[.57,-.35],farWrist:[{x:0.14,y:0.51},{x:0.4,y:0.45},{x:0.73,y:0.63}],mouth:[.76,.54]},
  hedgehog:{elbow:.45,restEdge:.20,nearWrist:[.61,-.65],farWrist:[{x:0.31,y:0.73},{x:0.4,y:0.41},{x:0.75,y:0.46}],mouth:[.84,.60]},
};
export function articulateArm(shoulder: Point, upper: Point, lower: Point, target: Point) {
  const dx=target.x-shoulder.x,dy=target.y-shoulder.y,aim=Math.atan2(dy,dx);
  const l1=Math.hypot(upper.x,upper.y),l2=Math.hypot(lower.x,lower.y),reach=l1+l2;
  const requested=Math.max(Math.abs(l1-l2)+1e-6,Math.min(reach,Math.hypot(dx,dy)));
  // The same anatomical bend is used across the whole right-facing pose space.
  // Source-part mirroring is already in upper/lower; screen-facing is applied
  // only after solving. No angle branch can turn the elbow inside out.
  const distance=requested;
  const ux=Math.cos(aim),uy=Math.sin(aim),along=(l1*l1-l2*l2+distance*distance)/(2*distance);
  const side=Math.sqrt(Math.max(0,l1*l1-along*along));
  const elbow={x:shoulder.x+ux*along-uy*side,y:shoulder.y+uy*along+ux*side};
  const hand={x:shoulder.x+ux*distance,y:shoulder.y+uy*distance};
  return {elbow,hand,upperRotation:Math.atan2(elbow.y-shoulder.y,elbow.x-shoulder.x)-Math.atan2(upper.y,upper.x),lowerRotation:Math.atan2(hand.y-elbow.y,hand.x-elbow.x)-Math.atan2(lower.y,lower.x)};
}
// The cup stays upright at rest and tips toward the mouth, never away from it.
// Reach can select a slight negative tilt inside the drinking range only.
export function cupAngleForReach(shoulder:Point,mouth:Point,lipToGrip:Point,minReach:number,maxReach:number,preferred=-.45) {
  const mx=mouth.x-shoulder.x,my=mouth.y-shoulder.y,dx=lipToGrip.x,dy=lipToGrip.y;
  const a=mx*dx+my*dy,b=my*dx-mx*dy,base=mx*mx+my*my+dx*dx+dy*dy;
  const amplitude=2*Math.hypot(a,b),phase=Math.atan2(b,a),low=-.55,high=-.35;
  const preferredAngle=Math.max(low,Math.min(high,preferred));
  const distance=(angle:number)=>Math.sqrt(Math.max(0,base+2*(a*Math.cos(angle)+b*Math.sin(angle))));
  const error=(angle:number)=>Math.max(0,minReach-distance(angle),distance(angle)-maxReach);
  const choices=[preferredAngle,low,high];
  if(amplitude>1e-8)for(const radius of [minReach,maxReach]){
    const cosine=(radius*radius-base)/amplitude;
    if(cosine<-1||cosine>1)continue;
    const offset=Math.acos(cosine);
    for(const sign of [-1,1])for(const turn of [-1,0,1]){
      const angle=phase+sign*offset+turn*Math.PI*2;
      if(angle>=low&&angle<=high)choices.push(angle);
    }
  }
  choices.sort((x,y)=>{const difference=error(x)-error(y);return Math.abs(difference)>1e-7?difference:Math.abs(x-preferredAngle)-Math.abs(y-preferredAngle);});
  return choices[0]!;
}
// Cushion poses use the same haunch and paw pieces as standing. Distances are
// from the single torso's support point; the farther foot is higher in depth.
export const CUSHION_FEET: Record<Species, Record<"nearLeg"|"farLeg",readonly[number,number,number]>> = {
  cat: {nearLeg:[16,7,-.70],farLeg:[24,5,-.60]},
  bird: {nearLeg:[-2,-12,0],farLeg:[2,-12,0]},
  otter: {nearLeg:[18,6,-.75],farLeg:[28,3,-.65]},
  dog: {nearLeg:[16,8,-.70],farLeg:[26,5,-.58]},
  rabbit: {nearLeg:[18,9,-.82],farLeg:[29,5,-.67]},
  fox: {nearLeg:[17,7,-.70],farLeg:[26,4,-.60]},
  panda: {nearLeg:[15,6,-.75],farLeg:[25,4,-.55]},
  hedgehog: {nearLeg:[12,5,-.60],farLeg:[20,3,-.48]},
};
type NeckProfile = { jaw: readonly [number, number, number, number, number, number]; neckScale: readonly [number, number] };
export const NECKS: Partial<Record<string, NeckProfile>> = {
  hedgehog: { jaw: [.30,.82,.55,.90,.80,.78], neckScale: [.80,.24] },
  bird: { jaw: [.17,.82,.52,.90,.86,.80], neckScale: [.94,.84] },
};
// Registered source pixels below the jaw are compacted once per face frame.
// The face, nose, ears and outer spines retain their authored proportions.
const neckCache = new WeakMap<CanvasImageSource, Map<string, HTMLCanvasElement>>();
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export function compactNeck(source: CanvasImageSource, rect: Rect, head: HeadFrame, pivot: Point, width: number, height: number, profile: NeckProfile) {
  let frames = neckCache.get(source);
  if (!frames) neckCache.set(source, frames = new Map());
  const key = [rect.x,rect.y,rect.width,rect.height,width,pivot.x,pivot.y].join('/');
  if (frames.has(key)) return frames.get(key);
  const out = document.createElement('canvas');
  const w = out.width = rect.width, h = out.height = rect.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  ctx.drawImage(source,rect.x,rect.y,w,h,0,0,w,h);
  const from = ctx.getImageData(0,0,w,h), to = ctx.createImageData(w,h);
  to.data.set(from.data);
  const [x0,y0,xc,yc,x1,y1] = profile.jaw;
  const [across,down] = profile.neckScale;
  const scaleX = width/head.suggestedWidth;
  const scaleY = height/(head.suggestedWidth*head.rect.height/head.rect.width);
  const jawAt = (x: number) => {
    const t=clamp((x-x0)/(x1-x0)), a=1-t;
    return a*a*y0+2*a*t*yc+t*t*y1;
  };
  const firstRow=Math.max(0,Math.floor((pivot.y+(Math.min(y0,y1)-head.pivot.y)/scaleY)*h)-1);
  for(let y=firstRow;y<h;y++)for(let x=0;x<w;x++){
    const nx=head.pivot.x+((x+.5)/w-pivot.x)*scaleX;
    const ny=head.pivot.y+((y+.5)/h-pivot.y)*scaleY;
    if(ny<jawAt(nx))continue;
    const edge=clamp((nx-x0+.04)/.04)*clamp((x1+.04-nx)/.04);
    if(!edge)continue;
    let ox=nx,oy=ny;
    for(let pass=0;pass<3;pass++){
      const jaw=jawAt(ox);
      oy=jaw+(ny-jaw)/(1-edge*(1-down));
      const depth=clamp((oy-jaw)/(1-jaw));
      ox=xc+(nx-xc)/(1-edge*(1-across)*depth);
    }
    const px=(pivot.x+(ox-head.pivot.x)/scaleX)*w-.5;
    const py=(pivot.y+(oy-head.pivot.y)/scaleY)*h-.5;
    const ix=Math.floor(px),iy=Math.floor(py), k=4*(y*w+x);
    let alpha=0,red=0,green=0,blue=0;
    for(let j=0;j<2;j++)for(let i=0;i<2;i++){
      const xx=ix+i,yy=iy+j;
      if(xx<0||yy<0||xx>=w||yy>=h)continue;
      const p=4*(yy*w+xx), weight=(i?px-ix:1-px+ix)*(j?py-iy:1-py+iy)*from.data[p+3]!;
      alpha+=weight;red+=weight*from.data[p]!;green+=weight*from.data[p+1]!;blue+=weight*from.data[p+2]!;
    }
    to.data[k]=alpha?red/alpha:0;to.data[k+1]=alpha?green/alpha:0;
    to.data[k+2]=alpha?blue/alpha:0;to.data[k+3]=alpha;
  }
  ctx.putImageData(to,0,0);frames.set(key,out);return out;
}

