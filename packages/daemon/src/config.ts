// `~/.agent-office/config.json`, validated against the config schema. A missing file means the
// defaults; an unreadable or invalid one also means the defaults, and the problem is reported
// (log and /health) instead of stopping the daemon.
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { PricingOverrides, StatesConfig } from "@agent-office/core";
import { DEFAULT_STATES, parsePricingOverrides, statesConfig } from "@agent-office/core";
import type { NotifyRules } from "./notifier.ts";
import type { Validators } from "./validate.ts";

export type DaemonConfig = {
  states: StatesConfig;
  /** A top-level turn running this long is marked as running long (states.long_turn_min); 0 = off. */
  longTurnS: number;
  /** A session resting this long leaves the office until its next turn (states.away_after_min); 0 = never. */
  awayAfterS: number;
  port: number;
  reorderWindowS: number;
  historyDays: number;
  /** Days token samples and rate-limit observations are kept (storage.retention_days.events). */
  eventsDays: number;
  /** Days the daily token roll-ups are kept (storage.retention_days.usage_daily). */
  usageDailyDays: number;
  /** IANA zone of the usage days ("local" resolved to this machine's zone), and when a day starts. */
  usageTimeZone: string;
  dayStartsAt: string;
  /** Relative file name inside `~/.agent-office` for user price overrides (`usage.pricing.overrides_file`). */
  pricingOverridesFile?: string;
  /** When to notify (notifications.*, privacy.screen_share_mode). */
  notify: NotifyRules;
  /** Whether desktop notifications are sent at all (notifications.channels.desktop.enabled). */
  desktopNotifications: boolean;
  /** What the desktop app plays with a notification (notifications.sound); sent to screens. */
  notificationSound: NotificationSound;
  /** What the viewer listener may show (remote_view.detail). */
  viewerDetail: "status" | "targets" | "full";
  /** When waiting and resting characters start moving about (scene.wander_after_s); sent to screens. */
  wanderAfterS: number;
  /** How sessions get their species (scene.cast) and the agent kind → species mapping (species); sent to screens. */
  cast: SceneSettings["cast"];
  species: Record<string, string>;
  /** The office board on the wall and the monthly rewards (scene.board); sent to screens. */
  board: BoardSettings;
  /** Scheduled tasks (schedule.*): how long before its run a task waits on a bench (sent to screens), and the grace before a run is called missed. */
  schedule: { benchBeforeS: number; missedAfterS: number;
    /** Seconds a scheduled task's thread rests at its desk after a run before the waiting room (schedule.rest_after_min); sent to screens. */
    restAfterS: number };
  /** Whose name tag the office shows without pointing (labels.show); sent to screens. */
  labelsShow: LabelsShow;
  /** Minutes after which a needs-you marker grows stronger, and strongest (scene.needs_you_marker; null never); sent to screens. */
  needsYouMarker: NeedsYouMarker;
  /** Whether a colleague waiting for the owner stands in a still, warm light (scene.needs_you_glow); sent to screens. */
  needsYouGlow: boolean;
  /** The screens' language (ui.language): auto follows each device's languages; sent to screens. */
  language: UiLanguage;
  /** null when the file was absent or valid. */
  problem: string | null;
};

const BENCH_BEFORE_MIN = 60;
const MISSED_AFTER_MIN = 15;
/** Minutes a scheduled task's thread rests at its desk after a run before it waits in the waiting room (schedule.rest_after_min). */
const REST_AFTER_MIN = 5;

import type { BoardSettings, LabelsShow, NeedsYouMarker, NotificationSound, SceneSettings, UiLanguage } from "@agent-office/core";
export type { BoardSettings, LabelsShow, NeedsYouMarker, NotificationSound, SceneSettings, UiLanguage };
export const DEFAULT_BOARD: BoardSettings = { show: true, preset: "combined", rewards: "shelf", monthly_target: null };

const DEFAULT_NEEDS_YOU_MARKER: NeedsYouMarker = { stronger_after_min: 5, strongest_after_min: 15 };

export const sceneSettings = (config: DaemonConfig): SceneSettings => ({ wander_after_s: config.wanderAfterS, cast: config.cast, species: config.species, board: config.board, schedule: { bench_before_min: config.schedule.benchBeforeS / 60, rest_after_min: config.schedule.restAfterS / 60, time_zone: config.usageTimeZone }, labels: { show: config.labelsShow }, needs_you_marker: config.needsYouMarker, needs_you_glow: config.needsYouGlow, language: config.language, notification_sound: config.notificationSound });

const DEFAULT_SPECIES: Record<string, string> = { "claude-code": "cat", codex: "otter" };
export const DEFAULT_PORT = 47631;
const LONG_TURN_MIN = 20;
const AWAY_AFTER_MIN = 30;

const LOCAL_ZONE = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A configured zone when the runtime knows it, else this machine's ("local" means that too). */
function zoneOf(value: string | undefined): string {
  if (value === undefined || value === "local") return LOCAL_ZONE();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
    return value;
  } catch (error) {
    if (error instanceof RangeError) return LOCAL_ZONE();
    throw error;
  }
}

type NotificationsConfig = {
  waiting_user?: boolean;
  error?: boolean;
  /** Accepted for older files; a session gone quiet is no longer notified. */
  silent?: boolean;
  lost?: boolean;
  schedule_missed?: boolean;
  ready?: boolean;
  ready_min_turn_min?: number;
  min_wait_s?: number;
  min_wait_s_sdk?: number;
  sound?: NotificationSound;
  channels?: { desktop?: { enabled?: boolean; click_opens?: "session" | "queue" } };
};

/** The schema's defaults for whatever is not set. */
function notifyRules(notifications: NotificationsConfig | undefined, screenShare: boolean | undefined): NotifyRules {
  return {
    waitingUser: notifications?.waiting_user ?? true,
    error: notifications?.error ?? true,
    lost: notifications?.lost ?? true,
    scheduleMissed: notifications?.schedule_missed ?? true,
    ready: notifications?.ready ?? false,
    readyMinTurnS: (notifications?.ready_min_turn_min ?? 10) * 60,
    minWaitS: notifications?.min_wait_s ?? 3,
    minWaitSdkS: notifications?.min_wait_s_sdk ?? 15,
    screenShare: screenShare ?? false,
    opens: notifications?.channels?.desktop?.click_opens ?? "session",
  };
}

export const DEFAULT_NOTIFY: NotifyRules = notifyRules(undefined, undefined);

const defaults = (problem: string | null): DaemonConfig => ({ states: DEFAULT_STATES, longTurnS: LONG_TURN_MIN * 60, awayAfterS: AWAY_AFTER_MIN * 60, port: DEFAULT_PORT, reorderWindowS: 600, historyDays: 90, eventsDays: 30, usageDailyDays: 400, usageTimeZone: LOCAL_ZONE(), dayStartsAt: "00:00", pricingOverridesFile: "custom-pricing.json", notify: DEFAULT_NOTIFY, desktopNotifications: true, notificationSound: "chime", viewerDetail: "status", wanderAfterS: 300, cast: "per-session", species: DEFAULT_SPECIES, board: DEFAULT_BOARD, schedule: { benchBeforeS: BENCH_BEFORE_MIN * 60, missedAfterS: MISSED_AFTER_MIN * 60, restAfterS: REST_AFTER_MIN * 60 }, labelsShow: "needs-you", needsYouMarker: DEFAULT_NEEDS_YOU_MARKER, needsYouGlow: true, language: "auto", problem });

export function loadConfig(path: string, validators: Validators): DaemonConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return defaults(code === "ENOENT" ? null : `config.json unreadable (${code ?? "error"})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return defaults("config.json is not valid JSON");
    throw error;
  }
  const errors = validators.config(raw);
  if (errors.length > 0) return defaults(`config.json does not match the schema: ${errors.slice(0, 3).join("; ")}`);
  const config = raw as {
    states?: Partial<StatesConfig> & { long_turn_min?: number; away_after_min?: number };
    daemon?: { port?: number; reorder_window_s?: number };
    storage?: { retention_days?: { history?: number; events?: number; usage_daily?: number } };
    usage?: { timezone?: string; day_starts_at?: string; pricing?: { overrides_file?: string } };
    notifications?: NotificationsConfig;
    privacy?: { screen_share_mode?: boolean };
    remote_view?: { detail?: "status" | "targets" | "full" };
    scene?: { wander_after_s?: number; cast?: SceneSettings["cast"]; board?: Partial<BoardSettings>; needs_you_marker?: Partial<NeedsYouMarker>; needs_you_glow?: boolean };
    labels?: { show?: LabelsShow };
    species?: Record<string, string>;
    schedule?: { bench_before_min?: number; missed_after_min?: number; rest_after_min?: number };
    ui?: { language?: UiLanguage };
  };
  return {
    states: statesConfig(config.states),
    longTurnS: (config.states?.long_turn_min ?? LONG_TURN_MIN) * 60,
    awayAfterS: (config.states?.away_after_min ?? AWAY_AFTER_MIN) * 60,
    port: config.daemon?.port ?? DEFAULT_PORT,
    reorderWindowS: config.daemon?.reorder_window_s ?? 600,
    historyDays: config.storage?.retention_days?.history ?? 90,
    eventsDays: config.storage?.retention_days?.events ?? 30,
    usageDailyDays: config.storage?.retention_days?.usage_daily ?? 400,
    usageTimeZone: zoneOf(config.usage?.timezone),
    dayStartsAt: config.usage?.day_starts_at ?? "00:00",
    pricingOverridesFile: config.usage?.pricing?.overrides_file ?? "custom-pricing.json",
    notify: notifyRules(config.notifications, config.privacy?.screen_share_mode),
    desktopNotifications: config.notifications?.channels?.desktop?.enabled ?? true,
    notificationSound: config.notifications?.sound ?? "chime",
    viewerDetail: config.remote_view?.detail ?? "status",
    wanderAfterS: config.scene?.wander_after_s ?? 300,
    cast: config.scene?.cast ?? "per-session",
    species: config.species ?? DEFAULT_SPECIES,
    board: { ...DEFAULT_BOARD, ...config.scene?.board },
    schedule: { benchBeforeS: (config.schedule?.bench_before_min ?? BENCH_BEFORE_MIN) * 60, missedAfterS: (config.schedule?.missed_after_min ?? MISSED_AFTER_MIN) * 60, restAfterS: (config.schedule?.rest_after_min ?? REST_AFTER_MIN) * 60 },
    labelsShow: config.labels?.show ?? "needs-you",
    needsYouMarker: { ...DEFAULT_NEEDS_YOU_MARKER, ...config.scene?.needs_you_marker },
    needsYouGlow: config.scene?.needs_you_glow ?? true,
    language: config.ui?.language ?? "auto",
    problem: null,
  };
}

/** Reads `~/.agent-office/custom-pricing.json` when present inside `home`; logs and ignores an unreadable or invalid file. */
export function loadPricingOverrides(home: string, file: string, log: (line: string) => void): PricingOverrides | null {
  const none: PricingOverrides | null = null;
  const root = resolve(home);
  const target = resolve(root, file);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    log("pricing_overrides_outside_home");
    return none;
  }
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log(`pricing_overrides_unreadable ${code ?? "error"}`);
    return none;
  }
  try {
    const parsed = parsePricingOverrides(JSON.parse(text));
    if (parsed === null) log("pricing_overrides_invalid");
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      log("pricing_overrides_invalid");
      return none;
    }
    throw error;
  }
}
