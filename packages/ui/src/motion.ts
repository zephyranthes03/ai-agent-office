// Pure presentation motion. Distances and offsets are fractions of character height; angles are
// radians. Positive foot x points forward, lift points up, blink 1 is closed. Time comes in from the
// scene; nothing here reads a clock. Gait and gesture values follow the art run's refined studies
// (flow-motion-v2, flow-life-v3: window and chat poses; flow-attention-v1: help).
import { seedUnit as unit } from "./seed.ts";

const TAU = Math.PI * 2;
const STANCE = 0.64;
/** One gait cycle (two steps) of a plain walk, in character heights. */
export const STRIDE = 0.22;
const mod = (value: number, period: number) => ((value % period) + period) % period;
const smooth = (value: number) => value * value * (3 - 2 * value);
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export type Behavior = "work" | "rest" | "look" | "wait" | "unknown" | "walk" | "help" | "window" | "chat";
/**
 * How a walk looks (temperament.ts): `stride` scales the step length, `bob` the body's rise and fall,
 * `swing` the arms; `lean` tips the body forward and `head` the head down (radians, negative up).
 */
export type Gait = { stride: number; bob: number; lean: number; swing: number; head: number };
export const PLAIN_GAIT: Gait = Object.freeze({ stride: 1, bob: 1, lean: 0, swing: 1, head: 0 });
/** `stance`: the foot is planted (walking); `groundY`: the floor under it, set by the scene on a slanted path. */
export type Foot = { x: number; lift: number; angle: number; stance?: boolean; groundY?: number };
export type Pose = {
  headY: number;
  headAngle: number;
  bodyY: number;
  bodyAngle: number;
  nearArmAngle: number;
  farArmAngle: number;
  nearFoot: Foot;
  farFoot: Foot;
  blink: number;
  lookX: number;
};

function finite(name: string, value: number, minimum = -Infinity): number {
  if (!Number.isFinite(value) || value < minimum) throw new RangeError(`${name} must be finite and >= ${minimum}`);
  return value;
}

function pulse(time: number, start: number, duration: number): number {
  const phase = (time - start) / duration;
  return phase > 0 && phase < 1 ? Math.sin(Math.PI * phase) ** 2 : 0;
}

/** Distance is cumulative forward travel, not signed world position. */
export function sampleFoot(distance: number, stride = STRIDE, phaseOffset = 0): Foot & { stance: boolean } {
  finite("distance", distance);
  finite("stride", stride, Number.MIN_VALUE);
  finite("phaseOffset", phaseOffset);
  const phase = mod(distance / stride + phaseOffset, 1);
  const reach = (stride * STANCE) / 2;
  if (phase < STANCE) return { x: reach - phase * stride, lift: 0, angle: 0, stance: true };
  const swing = (phase - STANCE) / (1 - STANCE);
  const eased = smooth(swing);
  // Hermite endpoints have dx/ddistance = -1, matching the planted foot on both ends.
  const x = -reach + stride * STANCE * eased - stride * (1 - STANCE) * (swing - eased);
  const arch = Math.sin(Math.PI * swing) ** 2;
  return { x, lift: 0.045 * arch, angle: 0.1 * Math.sin(TAU * swing) * arch, stance: false };
}

export function neutralPose(): Pose {
  return { headY: 0, headAngle: 0, bodyY: 0, bodyAngle: 0, nearArmAngle: 0, farArmAngle: 0, nearFoot: { x: 0, lift: 0, angle: 0 }, farFoot: { x: 0, lift: 0, angle: 0 }, blink: 0, lookX: 0 };
}

const BEHAVIORS: readonly Behavior[] = ["work", "rest", "look", "wait", "unknown", "walk", "help", "window", "chat"];

type PoseOptions = { time?: number; seed?: string | number; behavior?: Behavior; distance?: number; movement?: number; speaking?: boolean; gait?: Gait };

/**
 * movement scales motion intensity; it never rescales a planted foot's x. `help` (a session waiting
 * for the owner) tilts the head toward the owner and holds it there; the rig holds the near paw up
 * (flow-attention-v1). `window` looks out, `chat` talks with a colleague (`speaking` moves the paws;
 * the listener nods).
 */
export function samplePose(options: PoseOptions = {}): Pose {
  const { behavior = "rest", time = 0, speaking = false } = options;
  if (!BEHAVIORS.includes(behavior)) throw new RangeError(`Unknown behavior: ${String(behavior)}`);
  const gesture = behavior === "help" || behavior === "window" || behavior === "chat";
  const pose = basePose({ ...options, behavior: gesture ? (behavior === "help" ? "wait" : "look") : behavior });
  if (behavior === "help") {
    pose.headAngle = -0.035;
    pose.lookX = 0.012;
  } else if (behavior === "window") {
    pose.headAngle = -0.11 + 0.025 * Math.sin(time * 0.6);
    pose.lookX = 0.018;
    pose.nearArmAngle = 0;
    pose.farArmAngle = 0;
  } else if (behavior === "chat") {
    const wave = Math.sin(time * 2.7) ** 2;
    pose.nearArmAngle = speaking ? -0.38 * wave : 0;
    pose.farArmAngle = speaking ? -0.12 * wave : 0;
    pose.headAngle = (speaking ? 0.025 : 0.055) * Math.sin(time * 1.8);
    pose.lookX = 0.02;
  }
  return pose;
}

function basePose({ time = 0, seed = 0, behavior = "rest", distance = 0, movement = 1, gait = PLAIN_GAIT }: PoseOptions): Pose {
  finite("time", time);
  finite("distance", distance);
  finite("movement", movement);
  if (typeof seed !== "string" && (typeof seed !== "number" || !Number.isFinite(seed))) throw new TypeError("seed must be a string or finite number");
  if (!BEHAVIORS.includes(behavior)) throw new RangeError(`Unknown behavior: ${String(behavior)}`);
  const pose = neutralPose();
  if (behavior === "unknown") return pose; // No inferred work, breathing, gaze or blink.
  const amount = clamp(movement);
  const phase = unit(seed, "phase") * TAU;
  const breath = Math.sin(time * (0.78 + unit(seed, "breath") * 0.18) + phase);
  const blinkPeriod = 5.6 + unit(seed, "blink-period") * 2.7;
  pose.blink = pulse(mod(time + unit(seed, "blink-offset") * blinkPeriod, blinkPeriod), 0, 0.14) * amount;

  if (behavior === "walk") {
    const offset = unit(seed, "gait");
    const stride = STRIDE * finite("stride", gait.stride, Number.MIN_VALUE);
    const cycle = distance / stride + offset;
    const near = sampleFoot(distance, stride, offset);
    const far = sampleFoot(distance, stride, offset + 0.5);
    pose.nearFoot = { x: near.x, lift: near.lift * amount, angle: near.angle * amount, stance: near.stance };
    pose.farFoot = { x: far.x, lift: far.lift * amount, angle: far.angle * amount, stance: far.stance };
    const swing = Math.sin(TAU * cycle);
    pose.bodyY = -0.009 * swing ** 2 * amount * gait.bob;
    pose.bodyAngle = (0.01 + swing * 0.006 + gait.lean) * amount;
    pose.headY = 0.0025 * swing ** 2 * amount * gait.bob;
    pose.headAngle = (-0.008 * swing + gait.head) * amount;
    pose.nearArmAngle = -0.07 * swing * amount * gait.swing;
    pose.farArmAngle = 0.06 * swing * amount * gait.swing;
    return pose;
  }

  pose.bodyY = breath * (behavior === "wait" ? 0.0007 : 0.0025) * amount;
  pose.headY = -breath * 0.0006 * amount;
  if (behavior === "wait") return pose; // Stationary, attentive; no ambient gaze or arm action.
  if (behavior === "work") {
    const shifted = time + unit(seed, "work-offset") * 12;
    const cycle = Math.floor(shifted / 12);
    const local = mod(shifted, 12);
    let near = 0;
    let far = 0;
    let envelope = 0;
    for (let burst = 0; burst < 2; burst++) {
      const start = (burst ? 6.1 : 0.9) + unit(seed, `${cycle}:${burst}:start`) * 0.9;
      const duration = 1.2 + unit(seed, `${cycle}:${burst}:duration`) * 1.2;
      const weight = pulse(local, start, duration);
      const tap = (local - start) * TAU * (3.2 + unit(seed, `${cycle}:${burst}:pace`) * 0.7);
      near += Math.sin(tap) * weight;
      far += Math.sin(tap + 2.6) * weight;
      envelope += weight;
    }
    pose.nearArmAngle = near * 0.075 * amount;
    pose.farArmAngle = far * 0.063 * amount;
    pose.headAngle = 0.025 + envelope * 0.006 * amount;
    pose.bodyAngle = 0.009 + breath * 0.0015 * amount;
    return pose;
  }

  const period = behavior === "look" ? 7 : 10 + unit(seed, "look-period") * 4;
  const glance = pulse(mod(time + unit(seed, "look-offset") * period, period), 0.5, 2.4);
  const side = unit(seed, "look-side") < 0.5 ? -1 : 1;
  pose.headAngle = side * glance * 0.065 * amount;
  pose.lookX = side * glance * 0.016 * amount;
  pose.bodyAngle = breath * 0.002 * amount;
  return pose;
}

export type Journey = { position: number; direction: 1 | -1; travelled: number; speed: number; phase: "walk" | "rest" | "turn"; turnProgress: number };

/**
 * Position is route distance from the origin; travelled never decreases. During a turn, direction
 * is the incoming facing and turnProgress runs 0 → 1. Nonwalking poses have neutral feet; the
 * renderer owns walk-to-rest pose blending.
 */
export function sampleJourney(time: number, { distance, speed = 0.14, dwell = 12, ramp = 1.1, turn = 0.8 }: { distance: number; speed?: number; dwell?: number; ramp?: number; turn?: number }): Journey {
  finite("time", time);
  finite("distance", distance, 0);
  finite("speed", speed, Number.MIN_VALUE);
  finite("dwell", dwell, 0);
  finite("ramp", ramp, Number.MIN_VALUE);
  finite("turn", turn, Number.MIN_VALUE);
  if (distance === 0) return { position: 0, direction: 1, travelled: 0, speed: 0, phase: "rest", turnProgress: 0 };
  const peak = Math.min(speed, distance / ramp); // Tiny routes slow down instead of snapping through short ramps.
  const cruise = Math.max(0, distance / peak - ramp);
  const travel = 2 * ramp + cruise;
  const legDuration = travel + dwell + turn;
  const elapsed = Math.max(0, time);
  const leg = Math.floor(elapsed / legDuration);
  const local = elapsed - leg * legDuration;
  const direction = leg % 2 ? -1 : 1;
  let along = distance;
  let velocity = 0;
  let phase: Journey["phase"] = "walk";
  let turnProgress = 0;
  if (local < ramp) {
    const u = local / ramp;
    along = peak * ramp * (u ** 3 - u ** 4 / 2);
    velocity = peak * smooth(u);
  } else if (local < ramp + cruise) {
    along = peak * (ramp / 2 + local - ramp);
    velocity = peak;
  } else if (local < travel) {
    const u = (local - ramp - cruise) / ramp;
    along = peak * (ramp / 2 + cruise + ramp * (u - u ** 3 + u ** 4 / 2));
    velocity = peak * (1 - smooth(u));
  } else if (local < travel + dwell) phase = "rest";
  else {
    phase = "turn";
    turnProgress = clamp((local - travel - dwell) / turn);
  }
  return { position: direction === 1 ? along : distance - along, direction, travelled: leg * distance + along, speed: velocity, phase, turnProgress };
}
