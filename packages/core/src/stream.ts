// What the daemon's stream and its GET routes carry besides sessions (events.ts): the attention list,
// the owner's notes, the scheduled tasks, the lifecycle controls, the warnings, a notification and
// the owner's settings for the screens. Types only, written once: the daemon builds these shapes and
// the screens read them. A screen may be talking to an older daemon that leaves fields out; it says
// which ones where it reads them.

/** `schedule_missed`: a scheduled task's occurrence passed with no run while the daemon watched; its `session` is the task's key, not a session. */
export type NeedsYouSignal = "approval" | "input" | "error" | "lost" | "schedule_missed";
export type NeedsYou = { session: string; signal: NeedsYouSignal; since: string };
/** A finished turn; `turn_s` is null when its start was never seen. */
export type Ready = { session: string; since: string; turn_s: number | null };
/** A turn past the threshold; `since` is its start, or the first observation when `start_known` is false. */
export type Long = { session: string; since: string; basis: "threshold"; start_known: boolean; waited_s: number };
/** A session started, resumed or cleared that has had no turn since `since`: opened, never asked anything. */
export type Opened = { session: string; since: string };
/** A session resting, quiet or only opened since `since`, past `states.away_after_min`: it leaves the office until its next turn. */
export type Away = { session: string; since: string };
/** A thread the agent's app runs for itself (not in its own thread list): never in the office or the lists. */
export type Internal = { session: string };
/** A top-level session that ended at `since`: sent home by the owner, ended by its agent, or lost mid-turn (also under `needs_you`). */
export type Ended = { session: string; since: string; by: "owner" | "agent" | "lost" };
export type Attention = { needs_you: NeedsYou[]; ready: Ready[]; long: Long[]; opened: Opened[]; away: Away[]; internal: Internal[]; ended: Ended[] };

/** The owner's note on a session. `species`: a species id (null: the configured assignment); screens that cannot draw it use the assignment. */
export type Note = { nickname: string | null; description: string | null; watched: boolean; alert_on_rest: boolean; species: string | null };
/** A note as a viewer gets it: no `alert_on_rest`, and the description only at its `full` level. */
export type ViewerNote = { nickname: string | null; description: string | null; watched: boolean; species: string | null };

export type ScheduledRun = { session: string; status: string | null; at: string; linked: boolean; evidence?: "session_created" };
/** The task's own thread, when its scheduler names one; `linked` when the daemon knows it as a session. */
export type ScheduledThread = { session: string; linked: boolean };
export type Unsure = { at: string; reason: "daemon_down" | "source_down" | "execution_unconfirmed" };
/** A scheduled task as the daemon read it from its agent's scheduler. */
export type ScheduledTask = {
  /** `<agent>:<the scheduler's own id>`. */
  key: string;
  agent: string;
  name: string | null;
  project: string | null;
  cwd: string | null;
  status: "active" | "paused" | "other";
  native_status?: "done" | "completed" | "error";
  kind: string;
  rrule: string | null;
  /** Native rule, when the scheduler does not use RRULE. */
  rule?: { kind: "cron" | "interval" | "at"; expression?: string; every_ms?: number; at?: string; timezone?: string };
  running_at?: string | null;
  last_status?: string | null;
  last_attempt_at?: string | null;
  can_confirm_run?: boolean;
  can_detect_missed?: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  /** The thread the task lives in, when the scheduler names one; a heartbeat task runs there. */
  thread: ScheduledThread | null;
  /** The newest run row the scheduler recorded, when any. */
  run: ScheduledRun | null;
  /** An occurrence that passed with no run while the daemon was watching. */
  missed: { at: string } | null;
  /** An occurrence that passed with no run while the daemon was not watching all the while. */
  unsure: Unsure | null;
  observed_at: string;
};
export type ScheduleSource = { agent: string; outcome: "ok" | "empty" | "absent" | "unreadable" | "unsupported"; code: string | null; at: string };
export type Schedule = { sources: ScheduleSource[]; tasks: ScheduledTask[] };

export type ControlName = "start" | "stop" | "restart";
export type ServiceView = { agent: string; state: "running" | "stopped" | "unknown"; controls: ControlName[]; instance: string | null; note: string | null };
/** A lifecycle control request as the daemon reports it. */
export type ControlView = { id: string; control: ControlName; agent: string; session: string | null; service: string | null; status: string; step: string | null; requested_at: string; resolved_at: string | null; reason: string | null; evidence: Record<string, unknown> };
/** The lifecycle controls: recent requests, the sessions that can be stopped or restarted now (with the process the daemon saw), where a session can be started, and the background services. */
export type ControlsState = { requests: ControlView[]; available: Record<string, { controls: ("stop" | "restart")[]; instance: string }>; start: { agents: string[]; folders: string[] }; services: ServiceView[] };

/**
 * Why hooks are not (or may not be) reaching the daemon, for the screens; null when nothing says so.
 * `hooks-not-delivered`: the launcher found nothing to run the hook with after the last signal any
 * hook delivered (an agent did fire a hook, and it went nowhere). `launcher-target-missing`: the Node
 * or the program the launcher names is gone, so the next hook depends on a Node on the agent's PATH.
 */
export type HookWarning = { code: "hooks-not-delivered" | "launcher-target-missing"; since: string | null };
/** The `warnings` stream event: `hooks` when hooks are not, or may not be, reaching the daemon. */
export type Warnings = { hooks: HookWarning | null };

/** The `notification` stream event. */
export type Notification = {
  id: string;
  kind: "needs_you" | "ready";
  signal: NeedsYouSignal | "ready";
  /** The session, or for `schedule_missed` the task's key. */
  session: string;
  since: string;
  agent: string;
  /** The owner's nickname for the session (or its top-level parent), else its project; null when unknown or hidden. */
  title: string | null;
  /** What a wait is about (the tool target); null when there is none or it is hidden. */
  target: string | null;
  /** Seconds the finished turn took (ready only). */
  turn_s: number | null;
  opens: "session" | "queue";
};

/** The office board (scene.board): shown or not, its preset, how rewards are displayed, the monthly goal (null: none). */
export type BoardSettings = { show: boolean; preset: "combined" | "goal" | "rhythm" | "health"; rewards: "shelf" | "frames" | "none"; monthly_target: number | null };
export type UiLanguage = "auto" | "ko" | "en";
/** The general chime, the cry of the colleague's species, or nothing. */
export type NotificationSound = "chime" | "animal" | "off";
/** Whose name tag the office shows without pointing (labels.show). */
export type LabelsShow = "needs-you" | "everyone" | "on-hover";
/** Minutes after which a needs-you marker grows stronger, and strongest; null never. */
export type NeedsYouMarker = { stronger_after_min: number | null; strongest_after_min: number | null };
/** What the screens need of the owner's settings, sent when a stream opens. */
export type SceneSettings = { wander_after_s: number; cast: "per-session" | "per-agent" | "per-project"; species: Record<string, string>; board: BoardSettings; schedule: { bench_before_min: number; rest_after_min: number; time_zone: string }; labels: { show: LabelsShow }; needs_you_marker: NeedsYouMarker; needs_you_glow: boolean; language: UiLanguage; notification_sound: NotificationSound };

/** One local day's tokens and estimated cost for an agent, project and model (`GET /v1/usage`). */
export type UsageDay = {
  day: string;
  agent: string;
  project: string | null;
  model: string | null;
  in: number;
  out: number;
  cached_in: number;
  cache_write_in: number;
  reasoning_out: number;
  complete: boolean;
  estimated_cost_usd: number | null;
};
export type PricingInfo = { version: string; source: "bundled" | "custom" };
export type UsageResponse = {
  tz: string;
  day_starts_at: string;
  days: UsageDay[];
  pricing: PricingInfo | null;
};

/** One rate-limit window (`primary`, `secondary`) and one limit observation (`GET /v1/limits`). */
export type LimitWindow = { window: string; window_minutes: number | null; used_percent: number; resets_at: string | null };
export type LimitEntry = {
  provider: string;
  limit_id: string;
  limit_name: string | null;
  plan_type: string | null;
  observed_at: string;
  credits_balance: string | null;
  reached: string | null;
  windows: LimitWindow[];
};
export type LimitsResponse = { limits: LimitEntry[] };

/** A shape as a screen reads it from a daemon that may be older: the fields `K` may be missing. */
export type FromOlderDaemon<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
