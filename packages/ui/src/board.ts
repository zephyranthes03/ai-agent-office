// What the office board and the reward display show (the art run's flow-board-v1), from
// the daemon's record (GET /v1/board) and the attention list. Pure. Besides how many turns ended, how
// they went: the share done without waiting for the owner, the share stopped (cancelled, failed or
// lost) and the share of the owner's waits that took more than five minutes. Missing facts stay missing: a
// day without any recorded state change is a gap, never zero; a month without a goal gets no stamps
// or reward; future days and months are never filled. Labels are in the language shown.
import { t } from "./i18n/index.ts";
import type { BoardSettings } from "@agent-office/core";
import type { Attention } from "./model.ts";

/** `solo`, `failed`, `waits` and `long_waits` are null for a day the daemon no longer knows them for. */
export type BoardDay = { day: string; completed: number; cancelled: number; solo: number | null; failed: number | null; waits: number | null; long_waits: number | null };
export type BoardIssue = { session: string; kind: "error" | "lost"; at: string };
export type BoardRecord = { today: string; year: number; days: BoardDay[]; months: { month: string; target: number | null }[]; issues_today: BoardIssue[] };
export type { BoardSettings };
export type BoardPreset = BoardSettings["preset"];
export const DEFAULT_BOARD: BoardSettings = { show: true, preset: "combined", rewards: "shelf", monthly_target: null };
export type Period = "month" | "quarter";

export type MonthStatus = "future" | "empty" | "earned" | "current" | "partial";
export type MonthView = {
  key: string;
  label: string;
  total: number | null;
  target: number | null;
  /** Uncapped, floored; null without records or without a goal. */
  percent: number | null;
  status: MonthStatus;
  earned: boolean;
  isCurrent: boolean;
  /** A past month: its goal and reward no longer change. */
  finalized: boolean;
  observedDays: number;
  /** Turns cancelled in the month: shown apart, never toward the goal; null without records. */
  cancelled: number | null;
};
export type Point = { label: string; key: string; value: number | null; future: boolean };
export type Today = { completed: number | null; affectedSessions: number; currentIssues: number; approvalWaits: number; issues: (BoardIssue & { current: boolean })[]; observed: boolean };
/**
 * How the period's turns went, over its days whose counts are known (null without any): turns done
 * and those done without a wait for the owner, turns stopped (cancelled, failed or lost) of all that
 * ended, the owner's answered waits and those longer than five minutes. A share is a whole percent,
 * null when there is nothing to divide by.
 */
export type Care = { completed: number; solo: number; ended: number; stopped: number; waits: number; longWaits: number; soloPercent: number | null; stoppedPercent: number | null; longWaitPercent: number | null };
export type BoardView = {
  title: string;
  periodLabel: string;
  isQuarter: boolean;
  isCurrent: boolean;
  total: number | null;
  /** Turns cancelled in the period, apart from `total`; null without records. */
  cancelled: number | null;
  target: number | null;
  percent: number | null;
  stamps: { threshold: number; earned: boolean }[];
  series: Point[];
  months: MonthView[];
  hasRecords: boolean;
  coverageLabel: string;
  care: Care | null;
  today: Today;
};

const THRESHOLDS = [25, 50, 75, 100];
const pad = (n: number) => String(n).padStart(2, "0");
export const monthKey = (year: number, index: number) => `${year}-${pad(index + 1)}`;
const daysIn = (year: number, index: number) => new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
const sum = (values: (number | null)[]): number | null => {
  const seen = values.filter((value): value is number => value !== null);
  return seen.length === 0 ? null : seen.reduce((a, b) => a + b, 0);
};

/** One month's daily completed (or cancelled) turns, null for a day not observed, from the records of its year. */
function daily(records: ReadonlyMap<number, BoardRecord>, year: number, index: number, field: "completed" | "cancelled" = "completed"): (number | null)[] {
  const days = new Map((records.get(year)?.days ?? []).map((day) => [day.day, day[field]]));
  return Array.from({ length: daysIn(year, index) }, (_, d) => days.get(`${year}-${pad(index + 1)}-${pad(d + 1)}`) ?? null);
}

function monthView(records: ReadonlyMap<number, BoardRecord>, today: string, settings: BoardSettings, year: number, index: number): MonthView {
  const key = monthKey(year, index);
  const current = today.slice(0, 7);
  const future = key > current;
  const isCurrent = key === current;
  const values = daily(records, year, index);
  const total = future ? null : sum(values);
  const recorded = records.get(year)?.months.find((month) => month.month === key);
  // The current month follows the setting as it is now; a past one keeps the goal it ended with.
  const target = isCurrent || future ? settings.monthly_target : (recorded?.target ?? null);
  const percent = total === null || target === null ? null : Math.floor((total / target) * 100);
  const earned = total !== null && target !== null && total >= target;
  const status: MonthStatus = future ? "future" : total === null ? "empty" : earned ? "earned" : isCurrent ? "current" : "partial";
  return { key, label: t().board.month(index), total, target, percent, status, earned, isCurrent, finalized: key < current, observedDays: values.filter((value) => value !== null).length, cancelled: future ? null : sum(daily(records, year, index, "cancelled")) };
}

/** The twelve months of `year`. */
export function monthsOf(records: ReadonlyMap<number, BoardRecord>, today: string, settings: BoardSettings, year: number): MonthView[] {
  return Array.from({ length: 12 }, (_, index) => monthView(records, today, settings, year, index));
}

const share = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 100));

/** How the turns of the months `keys` went, from the observed days whose counts are known. */
function careOf(records: ReadonlyMap<number, BoardRecord>, keys: string[], today: string): Care | null {
  const days = keys.flatMap((key) => (records.get(Number(key.slice(0, 4)))?.days ?? []).filter((day) => day.day.slice(0, 7) === key && day.day <= today));
  let care: Care | null = null;
  for (const day of days) {
    if (day.solo === null || day.failed === null || day.waits === null || day.long_waits === null) continue;
    care ??= { completed: 0, solo: 0, ended: 0, stopped: 0, waits: 0, longWaits: 0, soloPercent: null, stoppedPercent: null, longWaitPercent: null };
    care.completed += day.completed;
    care.solo += day.solo;
    care.stopped += day.cancelled + day.failed;
    care.ended += day.completed + day.cancelled + day.failed;
    care.waits += day.waits;
    care.longWaits += day.long_waits;
  }
  return care === null ? null : { ...care, soloPercent: share(care.solo, care.completed), stoppedPercent: share(care.stopped, care.ended), longWaitPercent: share(care.longWaits, care.waits) };
}

function todayOf(record: BoardRecord | undefined, attention: Attention): Today {
  const current = new Set(attention.needs_you.filter((entry) => entry.signal === "error" || entry.signal === "lost").map((entry) => entry.session));
  const day = record?.days.find((entry) => entry.day === record.today);
  const issues = (record?.issues_today ?? []).map((issue) => ({ ...issue, current: current.has(issue.session) }));
  return {
    completed: day?.completed ?? null,
    affectedSessions: issues.length,
    currentIssues: current.size,
    approvalWaits: attention.needs_you.filter((entry) => entry.signal === "approval" || entry.signal === "input").length,
    issues,
    observed: day !== undefined || issues.length > 0,
  };
}

/** The board for the month `month` (YYYY-MM) or its quarter. `records` holds the daemon's record per year; `today` is the daemon's local day. */
export function boardView(records: ReadonlyMap<number, BoardRecord>, today: string, settings: BoardSettings, attention: Attention, period: Period, month: string): BoardView {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  const isQuarter = period === "quarter";
  const start = isQuarter ? Math.floor(index / 3) * 3 : index;
  const months = Array.from({ length: isQuarter ? 3 : 1 }, (_, offset) => monthView(records, today, settings, year, start + offset));
  const total = sum(months.map((m) => m.total));
  // A quarter with a month without a goal has no comparable goal.
  const targets = months.map((m) => m.target);
  const target = targets.every((value): value is number => value !== null) ? targets.reduce((a, b) => a + b, 0) : null;
  const percent = total === null || target === null ? null : Math.floor((total / target) * 100);
  const series: Point[] = isQuarter
    ? months.map((m) => ({ label: m.label, key: m.key, value: m.total, future: m.status === "future" }))
    : daily(records, year, index).map((value, d) => {
        const key = `${month}-${pad(d + 1)}`;
        return { label: String(d + 1), key, value, future: key > today };
      });
  const current = today.slice(0, 7);
  const isCurrent = months.some((m) => m.isCurrent);
  const hasRecords = total !== null;
  const lastDay = month === current ? Number(today.slice(8, 10)) : daysIn(year, index);
  const observedDays = months.reduce((n, m) => n + m.observedDays, 0);
  const missing = lastDay - observedDays;
  const words = t().board;
  const coverageLabel = !hasRecords
    ? months[0]!.key > current
      ? words.notStarted
      : words.noRecords
    : isQuarter
      ? words.quarterCoverage(months.filter((m) => m.total !== null).length, months.some((m) => m.status === "future"))
      : words.monthCoverage(index, lastDay, missing);
  return {
    title: isQuarter ? words.quarterTitle(year, Math.floor(index / 3) + 1) : words.monthTitle(year, index),
    periodLabel: isQuarter ? words.quarterly : words.monthly,
    isQuarter,
    isCurrent,
    total,
    cancelled: sum(months.map((m) => m.cancelled)),
    target,
    percent,
    stamps: THRESHOLDS.map((threshold) => ({ threshold, earned: total !== null && target !== null && (total / target) * 100 >= threshold })),
    series,
    months,
    hasRecords,
    coverageLabel,
    care: careOf(records, months.map((m) => m.key), today),
    today: todayOf(records.get(Number(today.slice(0, 4))), attention),
  };
}

/** The month `offset` steps (of one month, or three for a quarter) from `month`. */
export function shiftMonth(month: string, offset: number, period: Period): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + offset * (period === "quarter" ? 3 : 1);
  const y = year + Math.floor(index / 12);
  return monthKey(y, ((index % 12) + 12) % 12);
}
