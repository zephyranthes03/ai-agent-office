// `states` section of the user configuration: thresholds the reducer reads (§2 of the state rules).

export type StatesConfig = {
  done_hold_s: number;
  cancelled_hold_s: number;
  working_stale_s: number;
  idle_stale_s: number;
  unknown_gone_s: number;
  /** An alive:true liveness report counts as recent for this long (H3). */
  liveness_fresh_s: number;
  /** H6: turn an approval wait into idle this long after it began; null keeps it until the next signal (H5). */
  approval_wait_timeout_s: number | null;
};

export const DEFAULT_STATES: StatesConfig = {
  done_hold_s: 3,
  cancelled_hold_s: 3,
  working_stale_s: 900,
  idle_stale_s: 21600,
  unknown_gone_s: 7200,
  liveness_fresh_s: 90,
  approval_wait_timeout_s: null,
};

/** Fills a partial `states` section with the defaults; unknown keys are ignored. */
export function statesConfig(partial: Partial<StatesConfig> | null | undefined): StatesConfig {
  const out: StatesConfig = { ...DEFAULT_STATES };
  if (!partial) return out;
  for (const key of Object.keys(DEFAULT_STATES) as (keyof StatesConfig)[]) {
    const value = partial[key];
    if (value === undefined) continue;
    if (key === "approval_wait_timeout_s") out[key] = value;
    else if (typeof value === "number") out[key] = value;
  }
  return out;
}
