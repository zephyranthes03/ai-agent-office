// What makes each species move like itself (the owner's brief of 2026-11-05, with the art run's
// motion study): a state means the same on every colleague, but strides, stops on a stroll, habits,
// the shape of a long day at the laptop and a blank stare differ. Pure numbers by species, plus the
// stop plan of a stroll; nothing here draws or reads a clock.
import type { Gait } from "./motion.ts";
import type { Species } from "./model.ts";
import { seedUnit } from "./seed.ts";

/**
 * One glance while a strolling colleague stands looking about: `front` turns part way toward the
 * viewer and back (its head may tip, the dog's tilt), `ahead` lifts the head to look far ahead, `side`
 * moves only the eyes and head sideways, without turning (a side-eye).
 */
export type Glance = "front" | "ahead" | "side";
export type Temperament = {
  /** Walking to a desk, a bench or the door: longer steps, leaning toward where it goes. */
  purpose: Gait;
  /** Walking on a stroll: shorter, upright steps. */
  stroll: Gait;
  /** Steps in each stretch of a stroll before it stops: [fewest, most]. */
  steps: readonly [number, number];
  /** The glances of a stop, in order, how far each goes and how long they all take (seconds). */
  survey: { glances: readonly Glance[]; head: number; look: number; turn: number; tilt: number; seconds: number };
  /** How long it then stands still, in seconds: [shortest, longest]. */
  still: readonly [number, number];
  /** The chance that a stop ends with its own stretch or habit (at most one per stroll). */
  habitChance: number;
  /** Its own habit on a stroll besides the stretch (rubbing its paws, sniffing), if it has one. */
  habit: boolean;
  /**
   * A long turn at the laptop: how far the back rounds (`body`, radians), the head tips and drops
   * (`head` radians, `drop` character heights), the body sinks (`sink`) and the shoulders fall
   * (`shoulder`, character units; negative pulls them up around a lowered face).
   */
  tired: { body: number; head: number; drop: number; sink: number; shoulder: number };
  /** No signal: the head a little up (`head` radians, negative up; kept below the marker over a bench), the head forward or back (`look`), the body leaning back and the arms loose. */
  blank: { head: number; look: number; body: number; arms: number };
};

const T = (t: Temperament): Temperament => Object.freeze(t);

export const TEMPERAMENTS: Readonly<Record<Species, Temperament>> = Object.freeze({
  // Unhurried, talks with its paws: rubs them together, stretches both arms; rests a cheek deep on a paw.
  otter: T({ purpose: { stride: 1.08, bob: 1, lean: 0.05, swing: 0.9, head: 0.02 }, stroll: { stride: 0.82, bob: 0.8, lean: -0.01, swing: 0.7, head: -0.02 }, steps: [2, 4], survey: { glances: ["front", "ahead"], head: 0.07, look: 0.016, turn: 0.42, tilt: 0, seconds: 2.3 }, still: [1.5, 2.6], habitChance: 0.3, habit: true, tired: { body: 0.07, head: 0.14, drop: 0.008, sink: 0.02, shoulder: 2.6 }, blank: { head: -0.07, look: -0.006, body: -0.012, arms: 0.08 } }),
  // Light-footed and unhurried: a slow sideways look, a long back; tired, its back rounds and its ears spread.
  cat: T({ purpose: { stride: 1.05, bob: 0.45, lean: 0.046, swing: 0.6, head: 0.018 }, stroll: { stride: 0.8, bob: 0.4, lean: -0.014, swing: 0.5, head: -0.018 }, steps: [2, 3], survey: { glances: ["front"], head: 0.05, look: 0.022, turn: 0.4, tilt: 0, seconds: 2.6 }, still: [1.8, 3], habitChance: 0.28, habit: false, tired: { body: 0.09, head: 0.14, drop: 0.009, sink: 0.022, shoulder: 2.4 }, blank: { head: -0.05, look: 0.014, body: -0.01, arms: 0.06 } }),
  // A small explorer: short, precise steps, quick looks both ways, wings spread; tired, its neck sinks into the scarf.
  bird: T({ purpose: { stride: 0.82, bob: 0.7, lean: 0.05, swing: 0.8, head: 0.02 }, stroll: { stride: 0.66, bob: 0.6, lean: -0.01, swing: 0.7, head: -0.022 }, steps: [3, 4], survey: { glances: ["ahead", "front", "ahead"], head: 0.09, look: 0.012, turn: 0.4, tilt: 0, seconds: 1.8 }, still: [1, 1.8], habitChance: 0.3, habit: false, tired: { body: 0.06, head: 0.17, drop: 0.014, sink: 0.018, shoulder: 1.6 }, blank: { head: -0.1, look: 0, body: -0.01, arms: 0.05 } }),
  // Friendly and quick: a bouncy step, a sniff, a tilted head; tired, the weight of its head and ears shows.
  dog: T({ purpose: { stride: 1.12, bob: 1.25, lean: 0.055, swing: 1.1, head: 0.02 }, stroll: { stride: 0.86, bob: 1.1, lean: -0.005, swing: 0.9, head: -0.018 }, steps: [2, 4], survey: { glances: ["front", "ahead"], head: 0.07, look: 0.016, turn: 0.42, tilt: 0.14, seconds: 2.1 }, still: [1.2, 2.2], habitChance: 0.32, habit: true, tired: { body: 0.07, head: 0.15, drop: 0.01, sink: 0.02, shoulder: 2.6 }, blank: { head: -0.09, look: 0.004, body: -0.01, arms: 0.06 } }),
  // Nimble and delicate: small steps (never hopping about), a long stretch up; tired, its long ears hang to the side.
  rabbit: T({ purpose: { stride: 0.92, bob: 0.8, lean: 0.05, swing: 0.7, head: 0.02 }, stroll: { stride: 0.72, bob: 0.7, lean: -0.01, swing: 0.6, head: -0.02 }, steps: [3, 4], survey: { glances: ["ahead", "front"], head: 0.05, look: 0.012, turn: 0.4, tilt: 0, seconds: 1.9 }, still: [1.2, 2.2], habitChance: 0.28, habit: false, tired: { body: 0.07, head: 0.14, drop: 0.01, sink: 0.02, shoulder: 2.4 }, blank: { head: -0.05, look: 0.008, body: -0.012, arms: 0.05 } }),
  // Composed, its own rhythm: a long smooth stride, a side-eye, a lopsided stretch; tired, it leans its chin on one shoulder.
  fox: T({ purpose: { stride: 1.2, bob: 0.5, lean: 0.05, swing: 0.8, head: 0.018 }, stroll: { stride: 0.92, bob: 0.45, lean: -0.01, swing: 0.6, head: -0.018 }, steps: [2, 3], survey: { glances: ["side", "side"], head: 0.03, look: 0.028, turn: 0.36, tilt: 0, seconds: 2.4 }, still: [1.6, 2.8], habitChance: 0.26, habit: false, tired: { body: 0.08, head: 0.15, drop: 0.008, sink: 0.02, shoulder: 3 }, blank: { head: -0.04, look: 0.02, body: -0.02, arms: 0.06 } }),
  // Slow and weighty: long stops, a big stretch; tired, its back bows and its chin sinks heavily onto both paws.
  panda: T({ purpose: { stride: 1.1, bob: 1.5, lean: 0.045, swing: 0.9, head: 0.02 }, stroll: { stride: 0.84, bob: 1.3, lean: -0.005, swing: 0.7, head: -0.018 }, steps: [2, 3], survey: { glances: ["front"], head: 0.06, look: 0.014, turn: 0.42, tilt: 0, seconds: 2.8 }, still: [2.4, 3.8], habitChance: 0.3, habit: false, tired: { body: 0.1, head: 0.18, drop: 0.013, sink: 0.024, shoulder: 3.2 }, blank: { head: -0.06, look: 0, body: -0.015, arms: 0.07 } }),
  // Careful and small: short firm steps, little looks about, a small stretch; tired, its face sinks between its shoulders.
  hedgehog: T({ purpose: { stride: 0.86, bob: 0.9, lean: 0.05, swing: 0.6, head: 0.02 }, stroll: { stride: 0.7, bob: 0.8, lean: -0.005, swing: 0.5, head: -0.018 }, steps: [3, 4], survey: { glances: ["ahead", "ahead", "front"], head: 0.04, look: 0.01, turn: 0.38, tilt: 0, seconds: 2 }, still: [1.4, 2.4], habitChance: 0.26, habit: false, tired: { body: 0.09, head: 0.16, drop: 0.016, sink: 0.024, shoulder: -1.2 }, blank: { head: -0.04, look: 0.012, body: -0.005, arms: 0.04 } }),
});

/** A stop on a stroll: how long it looks about and then stands still, and whether a stretch or habit follows. */
export type StopPlan = { look: number; still: number; habit: boolean };

/** How many steps the `bout`-th stretch of a stroll takes before it stops. */
export function boutSteps(species: Species, seed: string, bout: number): number {
  const [fewest, most] = TEMPERAMENTS[species].steps;
  return fewest + Math.floor(seedUnit(seed, `bout:${bout}`) * (most - fewest + 1));
}

/** The `stop`-th stop of a stroll; `habitLeft` is false once this stroll had its stretch or habit. */
export function planStop(species: Species, seed: string, stop: number, habitLeft: boolean): StopPlan {
  const t = TEMPERAMENTS[species];
  const [shortest, longest] = t.still;
  return { look: t.survey.seconds, still: shortest + (longest - shortest) * seedUnit(seed, `still:${stop}`), habit: habitLeft && seedUnit(seed, `habit:${stop}`) < t.habitChance };
}

const bump = (age: number, start: number, length: number) => {
  const p = (age - start) / length;
  return p > 0 && p < 1 ? Math.sin(Math.PI * p) ** 2 : 0;
};

/**
 * The look about at `age` seconds into a stop: a part turn toward the viewer (`turn`, 0 to below a half
 * turn, so it never faces the other way), and head and gaze changes to add to the pose. Without
 * `toViewer` (a colleague holding its paw up for help, which only its side view shows) a glance toward
 * the viewer becomes a look ahead.
 */
export function survey(species: Species, age: number, toViewer = true): { turn: number; headAngle: number; lookX: number } {
  const s = TEMPERAMENTS[species].survey;
  const each = s.seconds / s.glances.length;
  let turn = 0, headAngle = 0, lookX = 0;
  s.glances.forEach((glance, i) => {
    const amount = bump(age, i * each, each);
    if (glance === "front" && toViewer) {
      turn += s.turn * amount;
      headAngle += s.tilt * amount;
    } else if (glance === "ahead" || glance === "front") {
      headAngle -= s.head * amount;
      lookX += s.look * amount;
    } else {
      const side = i % 2 === 0 ? 1 : -1;
      headAngle += side * s.head * amount;
      lookX += side * s.look * amount;
    }
  });
  return { turn, headAngle, lookX };
}
