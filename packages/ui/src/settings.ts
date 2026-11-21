// The owner's settings the screen takes from the daemon's `settings` event: when a resting colleague
// starts to wander, which species each session gets, how early a scheduled task's stand-in sits on
// a bench, how long a scheduled thread rests after a run, whose name tags show, when a needs-you
// marker grows stronger and whether a colleague waiting for the owner stands in a warm light. A value
// out of range keeps the one in use; the species cast always follows the event (an older daemon sends
// none: the defaults).
import type { Settings } from "./client.ts";
import type { LabelsShow, NeedsMarker } from "./format.ts";
import { DEFAULT_CAST } from "./model.ts";
import type { Cast } from "./model.ts";

export type SceneChoices = { wanderAfterS: number; cast: Cast; benchBeforeS: number; restAfterS: number; labelsShow: LabelsShow; needsMarker: NeedsMarker; needsYouGlow: boolean };
const SHOWS: readonly LabelsShow[] = ["needs-you", "everyone", "on-hover"];
const minutes = (value: number | null | undefined, current: number | null): number | null => (value === null ? null : value !== undefined && Number.isFinite(value) && value >= 0 ? value : current);

/** The choices after a `settings` event, from the ones in use. */
export function withSettings(current: SceneChoices, settings: Settings): SceneChoices {
  const next: SceneChoices = { ...current, cast: { cast: settings.cast ?? DEFAULT_CAST.cast, species: settings.species ?? DEFAULT_CAST.species } };
  if (Number.isFinite(settings.wander_after_s) && settings.wander_after_s >= 0) next.wanderAfterS = settings.wander_after_s;
  const schedule = settings.schedule;
  if (schedule !== undefined) {
    if (Number.isFinite(schedule.bench_before_min) && schedule.bench_before_min >= 0) next.benchBeforeS = schedule.bench_before_min * 60;
    if (schedule.rest_after_min !== undefined && Number.isFinite(schedule.rest_after_min) && schedule.rest_after_min >= 0) next.restAfterS = schedule.rest_after_min * 60;
  }
  if (settings.labels !== undefined && SHOWS.includes(settings.labels.show)) next.labelsShow = settings.labels.show;
  const marker = settings.needs_you_marker;
  if (marker !== undefined) next.needsMarker = { strongerAfterMin: minutes(marker.stronger_after_min, current.needsMarker.strongerAfterMin), strongestAfterMin: minutes(marker.strongest_after_min, current.needsMarker.strongestAfterMin) };
  if (typeof settings.needs_you_glow === "boolean") next.needsYouGlow = settings.needs_you_glow;
  return next;
}
