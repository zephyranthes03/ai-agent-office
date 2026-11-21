// The words and times the screen shows, in the language shown (i18n/). Times are plain arithmetic
// on what the daemon reported; nothing is estimated, and a missing fact is said to be unknown.
import type { LabelsShow, StandardEvent, State } from "@agent-office/core";
import { plural, t } from "./i18n/index.ts";
import type { Weekday } from "./i18n/index.ts";
import { identityFor } from "./identity.ts";
import { agentLine } from "./model.ts";
import type { Marker, NeedsYouSignal, ScheduledTask, SessionView } from "./model.ts";

export { plural };
export const unknown = (): string => t().unknown;
export const stateLabel = (state: State): string => t().format.states[state];
export const signalLabel = (signal: NeedsYouSignal): string => t().format.signals[signal];

/** Where delegated work went and who asked, as the delegation tool's own enums (the Claude app's cloud session start, 2026-11-01); anything else is shown as another session. */
export const delegationTarget = (target: string | null): string => (target === null ? t().format.otherSession : (t().format.delegationTargets[target] ?? t().format.otherSession));
/** A delegation out this long with no result is said not to have come back; the daemon cannot know a cloud session failed, so nothing is raised. */
export const DELEGATION_STALE_S = 24 * 3600;
export const delegationStale = (since: string, now: number): boolean => (secondsSince(since, now) ?? 0) >= DELEGATION_STALE_S;
export const originLabel = (origin: string) => (origin === "unknown" ? unknown() : (t().format.origins[origin] ?? origin));

/** The zone clock times are shown in (the daemon's usage.timezone); null means this device's. */
let clockZone: string | null = null;
export function setClockZone(zone: string | null): void {
  if (zone === null) {
    clockZone = null;
    return;
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(0);
    clockZone = zone;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    clockZone = null;
  }
}
const zoneOptions = (): Intl.DateTimeFormatOptions => (clockZone === null ? {} : { timeZone: clockZone });

/** "09:05" in the clock zone; unknown when the time cannot be read. */
export function clock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return unknown();
  return new Date(ms).toLocaleTimeString(t().locale, { hour: "2-digit", minute: "2-digit", hour12: false, ...zoneOptions() });
}

/** "Today 09:05", "Tomorrow 09:05", else the month and day ("11.03 09:05"), relative to `now` in the clock zone. */
export function clockDay(iso: string, now: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return unknown();
  const day = (at: number) => new Date(at).toLocaleDateString("en-CA", zoneOptions());
  const when = day(ms);
  const words = t().format;
  const prefix = when === day(now) ? words.today : when === day(now + 86_400_000) ? words.tomorrow : when === day(now - 86_400_000) ? words.yesterday : words.monthDay(when.slice(5, 7), when.slice(8, 10));
  return `${prefix} ${clock(iso)}`;
}

const WEEKDAYS: readonly string[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/**
 * An RFC 5545 rule in words, for the simple shapes a scheduler's form makes (daily or on weekdays at
 * 09:00, weekly on Monday and Wednesday, every 2 hours, every 55 minutes, once); null for anything
 * else, so the raw rule is shown instead. A leading "RRULE:" (the ChatGPT app writes one) is allowed. The time of day comes
 * from the rule only when it names one; nothing is computed.
 */
export function rruleText(rrule: string): string | null {
  const parts = new Map<string, string>();
  for (const piece of rrule.replace(/^RRULE:/i, "").split(";")) {
    const [key, value] = piece.split("=");
    if (!key || value === undefined) return null;
    parts.set(key.toUpperCase(), value.toUpperCase());
  }
  const freq = parts.get("FREQ");
  const interval = Number(parts.get("INTERVAL") ?? "1");
  if (freq === undefined || !Number.isInteger(interval) || interval < 1) return null;
  const words = t().format;
  if (parts.get("COUNT") === "1") return words.once;
  const hour = parts.has("BYHOUR") ? Number(parts.get("BYHOUR")) : null;
  const minute = parts.has("BYMINUTE") ? Number(parts.get("BYMINUTE")) : 0;
  if ((hour !== null && !Number.isInteger(hour)) || !Number.isInteger(minute)) return null;
  const time = hour === null ? null : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const days = parts.get("BYDAY")?.split(",") ?? [];
  if (days.some((day) => !WEEKDAYS.includes(day))) return null;
  if (freq === "MINUTELY") return words.everyMinutes(interval);
  if (freq === "HOURLY") return interval === 24 && hour === null ? words.daily24h(minute) : words.everyHours(interval);
  if (freq === "DAILY") return words.atTime(words.daily(interval), time);
  if (freq === "WEEKLY") {
    const weekdays = days.length === 5 && ["MO", "TU", "WE", "TH", "FR"].every((day) => days.includes(day));
    return words.atTime(words.weekly(interval, weekdays ? "weekdays" : days.map((day) => words.weekdays[day as Weekday])), time);
  }
  return null;
}

/** Seconds, minutes, hours and minutes, or days and hours ("45s", "12m", "1h 5m", "2d 3h" in English). */
export function duration(seconds: number): string {
  const words = t().format;
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return words.seconds(s);
  const m = Math.floor(s / 60);
  if (m < 60) return words.minutes(m);
  const h = Math.floor(m / 60);
  if (h < 24) return words.hours(h, m % 60);
  const d = Math.floor(h / 24);
  return words.days(d, h % 24);
}

/** Seconds from an ISO time to `now`, or null when the time cannot be read. */
export function secondsSince(iso: string, now: number): number | null {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, (now - at) / 1000);
}

export function ago(iso: string, now: number): string {
  const s = secondsSince(iso, now);
  if (s === null) return unknown();
  return s < 10 ? t().format.justNow : t().format.ago(duration(s));
}

export function forHow(iso: string, now: number): string {
  const s = secondsSince(iso, now);
  return s === null ? unknown() : duration(s);
}

/** How a session's last turn ended, for the home tab. */
const endLabel = (view: SessionView): string | null => (view.event.result ? (t().format.ends[view.event.result.outcome] ?? view.event.result.outcome) : null);

/** The states in which a session rests (model.ts keeps the same list for seats and counts). */
const RESTING_STATES: readonly string[] = ["idle", "done", "cancelled", "paused"];

/** The short status line of a session: its attention signal when it has one, else its state. */
export function statusLine(view: SessionView): string {
  const words = t().format;
  if (view.internal !== null) return words.internal;
  if (view.needs !== null) return signalLabel(view.needs.signal);
  // A scheduled task on its bench: when it is due, or that its last occurrence could not be watched.
  if (view.standIn && view.task !== null) return view.task.unsure !== null ? words.scheduledUnsure : view.task.next_run_at === null ? words.scheduledNextUnknown : words.scheduledArrives(clock(view.task.next_run_at));
  // The task's own thread waiting for its next run.
  if (view.benched && view.task !== null) return view.task.unsure !== null ? words.scheduledUnsure : view.task.next_run_at === null ? words.benchedNextUnknown : words.benchedNext(clock(view.task.next_run_at));
  if (view.ended !== null) return [view.ended.by === "owner" ? words.sentHome : words.ended, endLabel(view)].filter(Boolean).join(" · ");
  if (view.long !== null && view.event.state !== "unknown") return words.longTurn;
  if (view.away !== null) return view.ready !== null ? words.awayReady : view.opened !== null ? words.awayOpened : words.away;
  // Resting while background work it left running goes on: not finished, not on its way home.
  if (view.subprocesses > 0) return words.subprocesses(view.subprocesses);
  // Resting with work handed to other sessions still out.
  const open = view.event.delegations?.open ?? [];
  if (open.length > 0 && RESTING_STATES.includes(view.event.state)) return `${words.resting} · ${delegationWait(open)}`;
  if (view.ready !== null || view.event.state === "done") return words.restingReady;
  if (view.event.state === "cancelled") return words.resting;
  if (view.opened !== null) return words.openedOnly;
  return stateLabel(view.event.state);
}

/** What a session with work handed out waits for: where the first went, and how many are out. */
export const delegationWait = (open: readonly { target: string | null }[]): string => t().format.delegationWait(delegationTarget(open[0]!.target), open.length);

/** What the session waits on or works with, when the daemon reported it (≤ 64 characters). */
export function targetLine(view: SessionView): string | null {
  return view.event.waiting_on?.target ?? view.event.detail ?? null;
}

/**
 * The card's tool line, always present so the card keeps its shape while tools come and go: what an
 * approval or input wait is about; the tool a turn runs right now, or that it is answering without
 * one; nothing for a session at rest.
 */
export function toolLine(view: SessionView): { label: string; value: string } {
  const words = t().format;
  const target = targetLine(view);
  const state = view.event.state;
  // A task's stand-in, or its thread at rest: the next run.
  if (view.task !== null && (view.standIn || (view.task.status === "active" && state !== "working" && state !== "waiting_user" && state !== "waiting_dependency"))) return { label: words.nextRun, value: view.task.next_run_at === null ? unknown() : clock(view.task.next_run_at) };
  if (state === "waiting_user") return { label: view.event.waiting_on?.reason === "approval" ? words.waitingApproval : words.waitingAnswer, value: target ?? words.inOriginalTool };
  if (state === "working" || state === "waiting_dependency") return { label: words.currentTool, value: target ?? words.answeringWithoutTool };
  return { label: words.currentTool, value: target ?? words.none };
}

/** The small text on a character's marker; empty for a marker that is only a symbol. */
export function markerText(marker: Marker, now: number): { symbol: string; text: string } | null {
  if (marker === null) return null;
  switch (marker.kind) {
    case "needs":
      return { symbol: "!", text: signalLabel(marker.signal) };
    case "unknown":
      return { symbol: "?", text: "" };
    case "long":
      return { symbol: "◷", text: forHow(marker.since, now) };
    case "ready":
      return { symbol: "✓", text: "" };
    case "link":
      return { symbol: "⋯", text: "" };
    case "delegating":
      return { symbol: "⋯", text: marker.count > 1 ? t().format.delegatedCount(marker.count) : t().format.delegated };
    case "scheduled":
      return { symbol: "◷", text: clock(marker.at) };
  }
}

/** Whose name tag the office shows without pointing (the owner's labels.show). */
export type { LabelsShow };
/** Minutes after which a needs-you marker grows stronger, and strongest (the owner's scene.needs_you_marker); null never. */
export type NeedsMarker = { strongerAfterMin: number | null; strongestAfterMin: number | null };
export const DEFAULT_NEEDS_MARKER: NeedsMarker = { strongerAfterMin: 5, strongestAfterMin: 15 };

/** How strongly a needs-you marker speaks after waiting since `since`: 1 at first, 2 from the stronger minutes, 3 from the strongest. */
export function needsStage(since: string, now: number, marker: NeedsMarker): 1 | 2 | 3 {
  const waited = secondsSince(since, now) ?? 0;
  if (marker.strongestAfterMin !== null && waited >= marker.strongestAfterMin * 60) return 3;
  if (marker.strongerAfterMin !== null && waited >= marker.strongerAfterMin * 60) return 2;
  return 1;
}

/** `project` and `agent` say which process it is where the name does not fit (a phone): the repository's folder (else the name) and the agent. */
export type SceneTag = { symbol: string; text: string; loud: boolean; name: string | null; project: string | null; agent: string | null; stage: 1 | 2 | 3 | null; waited: string | null };
const LOUD: readonly string[] = ["needs", "unknown", "long"];

/**
 * The marker over a character in the scene: its symbol and text, whether the scene shows it (needs
 * you, quiet and long do; the list carries the others), and for a session that needs you how strongly
 * it speaks, how long it has waited from the second stage on, and its name, project and agent
 * unless names show only on pointing.
 */
export function sceneTag(view: SessionView, now: number, show: LabelsShow, marker: NeedsMarker): SceneTag | null {
  const mark = markerText(view.marker, now);
  if (mark === null || view.marker === null) return null;
  const loud = LOUD.includes(view.marker.kind);
  if (view.marker.kind !== "needs" || view.needs === null) return { ...mark, loud, name: null, project: null, agent: null, stage: null, waited: null };
  const stage = needsStage(view.needs.since, now, marker);
  const named = show !== "on-hover";
  return { ...mark, loud, name: named ? view.name : null, project: named ? (view.event.project ?? view.name) : null, agent: named ? view.agentName : null, stage, waited: stage > 1 ? forHow(view.needs.since, now) : null };
}

/** The status key used by the stylesheet: needs, long, unknown or calm. */
export function tone(view: SessionView): "needs" | "long" | "unknown" | "calm" {
  if (view.needs !== null) return "needs";
  if (view.event.state === "unknown") return "unknown";
  if (view.long !== null) return "long";
  return "calm";
}

export type Fact = { label: string; value: string; note?: string };

/** The detail card's facts. Values the API does not provide are shown as unknown, never filled in. */
export const taskStatus = (status: string): string => (status === "other" ? unknown() : (t().format.taskStatus[status] ?? status));

/** A scheduled task's facts: the schedule and the last run apart, nothing computed from the rule. On a stand-in's card they are the whole card; on its thread's card they follow the session's. */
function taskFacts(view: SessionView, task: NonNullable<SessionView["task"]>, now: number): Fact[] {
  const words = t().format;
  const list: Fact[] = [];
  if (view.standIn) {
    list.push({ label: words.agent, value: agentLine(view) });
    list.push({ label: words.project, value: task.project ?? unknown() });
  } else {
    list.push({ label: words.task, value: task.name ?? unknown(), note: words.taskThreadNote });
  }
  if (view.needs?.signal === "schedule_missed") list.push({ label: signalLabel(view.needs.signal), value: clockDay(view.needs.since, now), note: words.missedNote });
  if (task.unsure !== null) list.push({ label: words.unsureRun, value: clockDay(task.unsure.at, now), note: words.unsureReasons[task.unsure.reason] ?? task.unsure.reason });
  list.push({ label: words.nextRun, value: task.next_run_at === null ? unknown() : clockDay(task.next_run_at, now), note: words.nextRunNote });
  list.push({ label: words.repeats, value: scheduleRule(task) });
  if (task.can_confirm_run === false) list.push({ label: words.lastRun, value: t().schedules.executionUnknown });
  if (task.last_attempt_at) list.push({ label: t().schedules.lastAttempt, value: ago(task.last_attempt_at, now) });
  if (task.running_at) list.push({ label: t().schedules.running, value: ago(task.running_at, now), note: t().schedules.runningNote });
  if (task.last_status) list.push({ label: t().schedules.lastStatus, value: t().schedules.runStates[task.last_status] ?? task.last_status });
  const run = task.run;
  const runStatus = run?.status === null || run?.status === undefined ? null : (words.runStatus[run.status.toLowerCase()] ?? run.status);
  const runNote = run !== null ? [runStatus, run.linked ? words.runLinked : words.runUnlinked].filter(Boolean).join(" · ") : task.last_run_at !== null && task.thread !== null ? (task.thread.linked ? words.threadRan : words.threadUnlinked) : null;
  if (task.can_confirm_run !== false || run !== null) list.push({ label: run?.evidence === "session_created" ? t().schedules.sessionCreated : words.lastRun, value: run === null ? (task.last_run_at === null ? words.noneYet : ago(task.last_run_at, now)) : ago(run.at, now), ...(runNote !== null ? { note: runNote } : {}) });
  list.push({ label: words.taskState, value: scheduleStatus(task) });
  list.push({ label: words.managedIn, value: scheduleManager(task.agent) });
  list.push({ label: words.lastChecked, value: ago(task.observed_at, now) });
  list.push({ label: words.taskId, value: task.key });
  return list;
}

export function facts(view: SessionView, now: number): Fact[] {
  if (view.standIn && view.task !== null) return taskFacts(view, view.task, now);
  const words = t().format;
  const list: Fact[] = [];
  const e = view.event;
  list.push({ label: words.agent, value: agentLine(view) });
  list.push({ label: words.project, value: e.project ?? unknown() });
  if (view.needs !== null && view.needs.signal !== "schedule_missed") list.push({ label: signalLabel(view.needs.signal), value: forHow(view.needs.since, now), note: words.sinceSignal });
  if (view.long !== null) {
    list.push(view.long.start_known ? { label: words.thisTurn, value: forHow(view.long.since, now), note: view.long.waited_s > 0 ? words.includingWait(duration(view.long.waited_s)) : words.sinceTurnStart } : { label: words.thisTurn, value: words.atLeast(forHow(view.long.since, now)), note: words.sinceFirstSeen });
  }
  if (view.ready !== null) list.push({ label: words.finishedTurn, value: view.ready.turn_s === null ? words.tookUnknown(unknown()) : duration(view.ready.turn_s), note: words.finishedAgo(ago(view.ready.since, now)) });
  if (view.needs === null && view.long === null && view.ready === null) list.push({ label: words.thisTurn, value: unknown(), note: words.startNotReceived });
  list.push({ label: words.lastSignal, value: ago(e.ts, now) });
  list.push({ label: words.processAlive, value: unknown(), note: words.notSentToScreen });
  if (e.origin !== "human" && e.origin !== "unknown") list.push({ label: words.startedBy, value: originLabel(e.origin) });
  if (e.parent !== null) list.push({ label: words.parentSession, value: identityFor(e.parent).code });
  list.push({ label: words.sessionId, value: e.session });
  if (e.delegations !== undefined) list.push(...delegationFacts(e.delegations, now));
  if (view.task !== null) list.push(...taskFacts(view, view.task, now));
  return list;
}

/** The card's delegated-work section: each delegation still out (where, who asked, since when), and how many came back. */
function delegationFacts(delegations: NonNullable<StandardEvent["delegations"]>, now: number): Fact[] {
  const words = t().format;
  const list: Fact[] = [];
  list.push({ label: words.delegatedWork, value: words.delegationCounts(delegations.open.length, delegations.returned), note: words.delegatedWorkNote });
  delegations.open.forEach((item, index) => {
    const who = item.initiation === null ? null : (words.delegationInitiations[item.initiation] ?? item.initiation);
    list.push({ label: words.delegationN(index + 1), value: [delegationTarget(item.target), who].filter(Boolean).join(" · "), note: words.delegationSince(clockDay(item.since, now), forHow(item.since, now), delegationStale(item.since, now)) });
  });
  return list;
}


export function scheduleManager(agent: string): string {
  const names: Record<string, string> = t().schedules.management;
  return Object.hasOwn(names, agent) ? names[agent]! : agent;
}

export function scheduleRule(task: ScheduledTask): string {
  if (task.rrule !== null) return rruleText(task.rrule) ?? task.rrule;
  const rule = task.rule;
  if (rule === undefined) return unknown();
  if (rule.kind === "cron") return [rule.expression, rule.timezone].filter(Boolean).join(" · ");
  if (rule.kind === "interval" && rule.every_ms !== undefined) return t().schedules.interval(duration(rule.every_ms / 1000));
  return rule.at ?? rule.expression ?? unknown();
}


export function scheduleStatus(task: ScheduledTask): string {
  return task.native_status === undefined ? taskStatus(task.status) : t().schedules.definitionStates[task.native_status];
}
