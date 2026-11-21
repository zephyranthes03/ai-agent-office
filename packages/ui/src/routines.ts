// Small upper-body routines once a colleague has arrived (the art run's flow-life-v5 routines.mjs):
// typing, reading or a note at the desk; a newspaper, tea or a stretch at rest; looking out of the
// window; talking with a partner; a sip of tea on a stroll. A colleague in a long turn (the daemon's
// `long` list) works on tiredly: heavy typing, then a moment with its face on a paw or loosening its
// wrists and neck, then typing again. A stop on a stroll may end with the species' own stretch or habit.
// Presentation only: the scene owns arrival, state, partners and who holds a prop. Moods are cosmetic,
// never a judgment of the session.
import { seedUnit } from "./seed.ts";
import type { Pose } from "./motion.ts";
import type { Species } from "./model.ts";

export type RoutineContext = "work" | "work-tired" | "rest" | "window" | "chat" | "stroll-stop";
export type HandMode = "keyboard" | "keyboard-rest" | "chin" | "note" | "stretch" | "paper" | "cup" | "lap" | "yawn" | "gesture" | "wave" | "sill" | "prop" | "loosen" | "habit";
export type PropKind = "notepad" | "newspaper" | "cup";
type Routine = {
  context: RoutineContext;
  label: string;
  mood: string;
  seconds: readonly [number, number];
  handMode: HandMode;
  gaze: "screen" | "paper" | "window" | "peer" | "up" | "forward";
  preparation: number;
  recovery: number;
  prop: PropKind | null;
  bothHands: boolean;
  requiresCup: boolean;
  needsFreeCupHand: boolean;
};

const TAU = Math.PI * 2;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
const pulse = (value: number, start: number, end: number) => {
  const t = (value - start) / (end - start);
  return t > 0 && t < 1 ? Math.sin(Math.PI * t) ** 2 : 0;
};
const define = (context: RoutineContext, label: string, mood: string, seconds: readonly [number, number], handMode: HandMode, gaze: Routine["gaze"], extra: Partial<Routine> = {}): Routine =>
  Object.freeze({ context, label, mood, seconds, handMode, gaze, preparation: 0.18, recovery: 0.2, prop: null, bothHands: false, requiresCup: false, needsFreeCupHand: false, ...extra });

export const ROUTINES = Object.freeze({
  "work-type": define("work", "typing on the keyboard", "focused", [8, 12], "keyboard", "screen", { bothHands: true }),
  "work-read": define("work", "reading the screen calmly", "focused", [6, 10], "keyboard-rest", "screen"),
  "work-think": define("work", "gathering a thought for a moment", "thoughtful", [5.5, 8.5], "chin", "screen"),
  "work-note": define("work", "checking the screen while taking notes", "focused", [7, 11], "note", "paper", { prop: "notepad", bothHands: true }),
  "work-stretch": define("work", "loosening shoulders and arms at the desk", "reset", [5, 7.5], "stretch", "up", { bothHands: true, preparation: 0.26, recovery: 0.28 }),
  "rest-paper": define("rest", "reading an open newspaper", "curious", [12, 16], "paper", "paper", { prop: "newspaper", bothHands: true, preparation: 0.22, recovery: 0.23 }),
  "rest-tea": define("rest", "slowly drinking tea", "comfortable", [9, 13], "cup", "forward", { prop: "cup" }),
  "rest-daydream": define("rest", "leaning back, resting and daydreaming", "dreamy", [11, 16], "lap", "up", { preparation: 0.24, recovery: 0.24 }),
  "rest-yawn": define("rest", "covering a short yawn", "sleepy", [8, 11], "yawn", "forward", { preparation: 0.25, recovery: 0.27, needsFreeCupHand: true }),
  "rest-content": define("rest", "resting with a contented nod", "content", [8, 12], "lap", "forward"),
  "rest-stretch": define("rest", "stretching leisurely", "reset", [8, 11], "stretch", "up", { bothHands: true, preparation: 0.27, recovery: 0.29 }),
  "window-gaze": define("window", "gazing far out of the window", "calm", [10, 15], "sill", "window"),
  "window-cloud": define("window", "slowly following the view outside", "curious", [9, 14], "sill", "window"),
  "chat-talk": define("chat", "talking with gestures", "engaged", [5.5, 8], "gesture", "peer"),
  "chat-listen": define("chat", "listening to a colleague", "attentive", [6, 9], "lap", "peer"),
  "chat-laugh": define("chat", "sharing a light laugh with a colleague", "cheerful", [4.5, 6.5], "gesture", "peer"),
  "chat-greet": define("chat", "greeting a colleague warmly", "welcoming", [4, 5.5], "wave", "peer"),
  "stroll-sip": define("stroll-stop", "stopping for a sip of tea", "comfortable", [4.5, 6], "cup", "forward", { prop: "cup", requiresCup: true, preparation: 0.22, recovery: 0.25 }),
  "stroll-stretch": define("stroll-stop", "stretching in its own way on a stroll", "reset", [3.6, 5], "stretch", "up", { bothHands: true, preparation: 0.26, recovery: 0.28 }),
  "stroll-habit": define("stroll-stop", "its own little habit on a stroll", "content", [3, 4.2], "habit", "forward", { bothHands: true, preparation: 0.22, recovery: 0.24 }),
  "work-tired-type": define("work-tired", "typing on, heavily", "tired", [9, 14], "keyboard", "screen", { bothHands: true }),
  "work-tired-prop": define("work-tired", "resting its face on a paw for a moment", "tired", [5, 7.5], "prop", "screen", { preparation: 0.24, recovery: 0.26 }),
  "work-tired-loosen": define("work-tired", "loosening its wrists and neck", "tired", [4.5, 6.5], "loosen", "screen", { bothHands: true, preparation: 0.22, recovery: 0.24 }),
} satisfies Record<string, Routine>);

export type RoutineKind = keyof typeof ROUTINES;
export type RoutineChoice = { kind: RoutineKind; context: RoutineContext; seed: string; duration: number };
export type PoseDelta = Pick<Pose, "bodyY" | "bodyAngle" | "headY" | "headAngle" | "nearArmAngle" | "farArmAngle" | "lookX" | "blink">;
export type PropRequest = { kind: PropKind; lift: number; openness: number; tilt: number; pageTurn: number };
export type RoutineFrame = {
  kind: RoutineKind;
  label: string;
  stage: "prepare" | "act" | "recover" | "done";
  progress: number;
  duration: number;
  done: boolean;
  poseDelta: PoseDelta;
  handMode: HandMode;
  handMix: number;
  prop: PropRequest | null;
};

const KINDS = Object.keys(ROUTINES) as RoutineKind[];
const zeroDelta = (): PoseDelta => ({ bodyY: 0, bodyAngle: 0, headY: 0, headAngle: 0, nearArmAngle: 0, farArmAngle: 0, lookX: 0, blink: 0 });
const durationFor = (kind: RoutineKind, seed: string) => {
  const [minimum, maximum] = ROUTINES[kind].seconds;
  return minimum + (maximum - minimum) * seedUnit(seed, `routine-duration:${kind}`);
};

/**
 * A routine to keep until it completes, not a new choice every frame. Choices follow the session
 * seed, the context and the visit, and avoid repeating the previous kind when there is another.
 * A colleague raising a paw for help, or holding a cup, gets no two-handed routine; `null` when
 * nothing fits (a stroll stop without a cup). `only` narrows the choice to some kinds. A tired
 * colleague types between every other routine, so its turn still reads as work. A colleague working on
 * paper (`onPaper`: its desk tool is no laptop) writes on it where it would type.
 */
export function chooseRoutine({ context, seed, visit, previousKind = null, needsHelp = false, hasCup = false, only = null, onPaper = false }: { context: RoutineContext; seed: string; visit: number; previousKind?: RoutineKind | null; needsHelp?: boolean; hasCup?: boolean; only?: readonly RoutineKind[] | null; onPaper?: boolean }): RoutineChoice | null {
  const available = KINDS.filter((kind) => {
    const r: Routine = ROUTINES[kind];
    return r.context === context && (only === null || only.includes(kind)) && (!r.requiresCup || hasCup) && (!(needsHelp || hasCup) || !r.bothHands) && (!hasCup || !r.needsFreeCupHand) && (!hasCup || r.prop === null || r.prop === "cup");
  });
  if (available.length === 0) return null;
  const tired = context === "work-tired" ? available.filter((kind) => (previousKind === "work-tired-type" ? kind !== "work-tired-type" : kind === "work-tired-type")) : [];
  const choices = tired.length > 0 ? tired : available.length > 1 ? available.filter((kind) => kind !== previousKind) : available;
  const selection = `${seed}:routine:${context}:${visit}`;
  const picked = choices[Math.floor(seedUnit(selection, "choose") * choices.length)]!;
  const kind = onPaper && picked === "work-type" ? "work-note" : picked;
  return { kind, context, seed: selection, duration: durationFor(kind, selection) };
}

/**
 * Bounded upper-body changes and hand/prop requests at `age` seconds of motion time; no feet, places or
 * owners. `species` shapes the stroll's stretch and habit and a tired face on a paw.
 */
export function sampleRoutine({ kind, seed, age = 0, speaking = false, species = null }: { kind: RoutineKind; seed: string; age?: number; speaking?: boolean; species?: Species | null }): RoutineFrame {
  const routine: Routine = ROUTINES[kind];
  const duration = durationFor(kind, seed);
  const progress = clamp(age / duration);
  const weight = smooth(progress / routine.preparation) * smooth((1 - progress) / routine.recovery);
  const active = clamp((progress - routine.preparation) / (1 - routine.preparation - routine.recovery));
  const phase = seedUnit(seed, "body-phase") * TAU;
  const sway = Math.sin(age * 0.55 + phase);
  const breath = Math.sin(age * 0.7 + phase);
  const d = zeroDelta();
  let handMix = weight;
  let prop: PropRequest | null = routine.prop === null ? null : { kind: routine.prop, lift: 0, openness: 0, tilt: 0, pageTurn: 0 };
  switch (kind) {
    case "work-type": {
      const burst = pulse(active, 0.04, 0.37) + pulse(active, 0.57, 0.92);
      d.bodyAngle = 0.035;
      d.headAngle = 0.055;
      d.lookX = 0.006;
      d.nearArmAngle = 0.11 * Math.sin(age * 18 + phase) * burst;
      d.farArmAngle = 0.09 * Math.sin(age * 18 + phase + 2.4) * burst;
      d.headY = 0.0015 * Math.sin(age * 2) * burst;
      break;
    }
    case "work-read":
      d.bodyAngle = 0.018;
      d.headAngle = 0.025 + 0.015 * sway;
      d.lookX = 0.014 * Math.sin(active * Math.PI * 2);
      d.nearArmAngle = 0.02;
      d.farArmAngle = 0.015;
      break;
    case "work-think":
      d.bodyAngle = -0.025;
      d.headAngle = -0.06 + 0.035 * sway;
      d.lookX = 0.014;
      d.blink = 0.7 * pulse(active, 0.56, 0.78);
      d.nearArmAngle = -0.2;
      break;
    case "work-note": {
      const writing = pulse(active, 0.08, 0.42) + pulse(active, 0.57, 0.88);
      // Lean into the shallow page; short limbs do not stretch down to it.
      d.bodyAngle = 0.14;
      d.bodyY = 0.035;
      d.headAngle = 0.085 * writing + 0.025;
      d.lookX = -0.008;
      d.nearArmAngle = 0.035 * Math.sin(age * 9) * writing;
      d.farArmAngle = 0.015;
      prop = { ...prop!, openness: weight, pageTurn: 0, tilt: -0.035 * weight };
      break;
    }
    case "work-stretch":
      d.bodyAngle = -0.055;
      d.headAngle = -0.075;
      d.bodyY = -0.007;
      d.nearArmAngle = -0.48;
      d.farArmAngle = 0.42;
      d.blink = 0.75 * pulse(active, 0.1, 0.85);
      break;
    case "rest-paper": {
      const peek=pulse(active,0.66,0.98);
      d.bodyAngle = -0.025;
      d.headAngle = 0.42 + 0.018 * Math.sin(active * Math.PI * 4) - 0.12 * peek;
      d.lookX = 0.014 * Math.sin(active * Math.PI * 4) + 0.025 * peek;
      d.nearArmAngle = 0.02;
      d.farArmAngle = -0.02;
      prop = { ...prop!, lift: weight * (1 - 0.38 * peek), openness: weight, tilt: 0.02 * sway * weight, pageTurn: pulse(active, 0.48, 0.7) };
      break;
    }
    case "rest-tea":
    case "stroll-sip": {
      const sipping = pulse(active, 0.08, 0.88);
      d.bodyAngle = -0.02;
      if(kind==="stroll-sip"&&species==="hedgehog")d.bodyAngle-=.10*sipping;
      // Keep the drinking nod in the routine pose so an interrupted sip releases
      // it with the other head motion, even after the held cup's lift is cleared.
      // Meet the cup with a small head rotation at the existing neck socket.
      // Lower far shoulders retain the original arm reach and resting posture.
      const sipNods: Partial<Record<Species, number>> = { cat: .52, otter: .43, bird: .47, panda: .38, hedgehog: .36 };
      const sipNod = species ? sipNods[species] ?? .18 : .18;
      d.headAngle = (sipNod - 0.045) * sipping;
      d.headY = -0.003 * sipping;
      d.blink = 0.9 * pulse(active, 0.34, 0.7);
      d.farArmAngle = 0.06;
      prop = { ...prop!, lift: sipping * weight, openness: 1, tilt: -0.45 * sipping * weight };
      break;
    }
    case "rest-daydream":
      d.bodyAngle = -0.075;
      d.headAngle = -0.085 + 0.025 * sway;
      d.bodyY = 0.005 * breath;
      d.lookX = 0.02 * Math.sin(active * Math.PI);
      d.blink = 0.88 * pulse(active, 0.28, 0.87);
      d.nearArmAngle = 0.1;
      d.farArmAngle = 0.07;
      handMix = 0.5 * weight;
      break;
    case "rest-yawn": {
      const yawn = pulse(active, 0.05, 0.82);
      d.bodyAngle = -0.035;
      d.headAngle = -0.095 * yawn;
      d.bodyY = 0.009 * yawn;
      d.blink = 0.98 * yawn;
      d.nearArmAngle = -0.5 * yawn;
      d.farArmAngle = 0.08;
      break;
    }
    case "rest-content":
      d.bodyAngle = -0.045;
      d.headAngle = 0.045 * Math.sin(active * Math.PI * 3);
      d.bodyY = -0.0025 * pulse(active, 0.14, 0.75);
      d.blink = 0.9 * pulse(active, 0.18, 0.83);
      d.nearArmAngle = 0.09;
      d.farArmAngle = 0.06;
      handMix = 0.55 * weight;
      break;
    case "rest-stretch":
      d.bodyAngle = -0.065;
      d.headAngle = -0.095;
      d.bodyY = -0.008;
      d.nearArmAngle = -0.65;
      d.farArmAngle = 0.55;
      d.blink = 0.85 * pulse(active, 0.08, 0.88);
      break;
    case "window-gaze":
      d.bodyAngle = 0.015;
      d.headAngle = -0.1 + 0.012 * sway;
      d.lookX = 0.027;
      d.bodyY = 0.0025 * breath;
      d.nearArmAngle = 0.035;
      d.farArmAngle = 0.025;
      break;
    case "window-cloud":
      d.bodyAngle = 0.02;
      d.headAngle = -0.08 - 0.04 * Math.sin(active * Math.PI);
      d.lookX = 0.035 * Math.sin(active * Math.PI - 0.5);
      d.blink = 0.65 * pulse(active, 0.73, 0.9);
      break;
    case "chat-talk": {
      const gesture = Math.sin(age * 2.3 + phase) ** 2;
      d.headAngle = (speaking ? 0.035 : 0.055) * Math.sin(age * 1.7);
      d.nearArmAngle = speaking ? -0.3 * gesture : 0;
      d.farArmAngle = speaking ? -0.08 * gesture : 0.035;
      d.lookX = 0.02;
      handMix = (speaking ? 1 : 0.35) * weight;
      break;
    }
    case "chat-listen":
      d.bodyAngle = 0.018;
      d.headAngle = 0.065 * Math.sin(active * Math.PI * 3);
      d.lookX = 0.022;
      d.nearArmAngle = 0.025;
      d.farArmAngle = 0.02;
      handMix = 0.4 * weight;
      break;
    case "chat-laugh": {
      const laugh = pulse(active, 0.08, 0.9);
      const bounce = Math.sin(age * 4.1 + phase) ** 2;
      d.bodyAngle = -0.04 * laugh;
      d.headAngle = -0.065 * laugh;
      d.bodyY = -0.006 * bounce * laugh;
      d.headY = -0.002 * bounce * laugh;
      d.blink = 0.96 * laugh;
      d.nearArmAngle = -0.17 * laugh;
      d.farArmAngle = 0.035;
      d.lookX = 0.018;
      break;
    }
    case "chat-greet":
      d.headAngle = 0.04 * Math.sin(active * Math.PI * 2);
      d.lookX = 0.022;
      d.nearArmAngle = -0.7 + 0.13 * Math.sin(age * 5);
      d.farArmAngle = 0.025;
      break;
    case "work-tired-type": {
      // Slower taps in shorter bursts, the head low, and a slow, heavy blink between them.
      const burst = pulse(active, 0.05, 0.38) + pulse(active, 0.56, 0.9);
      d.bodyAngle = 0.02;
      d.headAngle = 0.03;
      d.lookX = 0.004;
      d.nearArmAngle = 0.08 * Math.sin(age * 12 + phase) * burst;
      d.farArmAngle = 0.065 * Math.sin(age * 12 + phase + 2.4) * burst;
      d.blink = 0.95 * pulse(active, 0.4, 0.52);
      break;
    }
    case "work-tired-prop": {
      // The face rests on a paw (the rig places the paw by species), which holds the head up above the
      // laptop, eyes closing for a moment; the hedgehog and the bird, with nothing to lean on, sink lower.
      d.bodyAngle = species === "fox" ? 0.05 : 0.02;
      d.headAngle = species === "hedgehog" || species === "bird" ? 0.05 : -0.04;
      d.headY = species === "hedgehog" || species === "bird" ? 0.008 : -0.004;
      d.blink = 0.95 * pulse(active, 0.3, 0.58);
      if (species === "bird") {
        // No paw to lean on: the wings droop instead.
        d.nearArmAngle = 0.12;
        d.farArmAngle = 0.1;
      }
      break;
    }
    case "work-tired-loosen": {
      const roll = Math.sin(active * Math.PI * 3);
      d.bodyAngle = -0.015;
      d.headAngle = 0.05 * roll - 0.02;
      d.lookX = 0.006 * roll;
      d.nearArmAngle = 0.1 * Math.sin(age * 3.2 + phase);
      d.farArmAngle = 0.08 * Math.sin(age * 3.2 + phase + 1.6);
      break;
    }
    case "stroll-stretch": {
      // Each its own: the cat lengthens its back forward, the rabbit reaches up tall, the panda goes big,
      // the hedgehog stays small; the rig places the paws.
      const shape: Record<Species, readonly [number, number, number]> = { otter: [-0.06, -0.09, -0.008], cat: [0.1, -0.04, 0.006], bird: [-0.03, -0.06, -0.004], dog: [-0.04, -0.05, -0.004], rabbit: [-0.05, -0.1, -0.014], fox: [-0.05, -0.06, -0.006], panda: [-0.08, -0.11, -0.01], hedgehog: [-0.03, -0.05, -0.004] };
      const [body, head, rise] = shape[species ?? "otter"];
      d.bodyAngle = body;
      d.headAngle = head;
      d.bodyY = rise;
      d.blink = 0.85 * pulse(active, 0.15, 0.85);
      break;
    }
    case "stroll-habit": {
      if (species === "dog") {
        // A sniff low and forward, then a tilt of the head.
        const sniff = pulse(active, 0.02, 0.62);
        d.headAngle = 0.16 * sniff - 0.05 * pulse(active, 0.6, 0.98);
        d.lookX = 0.022 * sniff;
        d.bodyAngle = 0.06 * sniff;
      } else {
        // The otter brings its paws together and rubs them.
        d.headAngle = 0.03;
        d.nearArmAngle = 0.06 * Math.sin(age * 7 + phase);
        d.farArmAngle = -0.05 * Math.sin(age * 7 + phase);
      }
      break;
    }
  }
  // Exactly neutral at both ends, without signed-zero noise.
  for (const key of Object.keys(d) as (keyof PoseDelta)[]) d[key] = weight === 0 ? 0 : d[key] * weight;
  const done = progress === 1;
  const stage = done ? "done" : progress < routine.preparation ? "prepare" : progress > 1 - routine.recovery ? "recover" : "act";
  return { kind, label: routine.label, stage, progress, duration, done, poseDelta: d, handMode: routine.handMode, handMix, prop };
}
