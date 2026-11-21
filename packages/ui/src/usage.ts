// What the summary row and the side panel's usage section show from `GET /v1/usage` and
// `GET /v1/limits` (usage-and-cost.md). Pure: takes the daemon's responses, the chosen
// period and grouping, and the clock, and returns the formatted view.
import { addDays, localDay } from "../../core/src/refresh.ts";
import type { LimitEntry, LimitsResponse, UsageDay, UsageResponse } from "@agent-office/core";
import { ago, duration } from "./format.ts";
import { t } from "./i18n/index.ts";
import { AGENT_NAMES } from "./model.ts";

export type UsagePeriod = 1 | 7 | 30;
export type UsageGroup = "agent" | "project" | "model";

export const USAGE_PERIODS: readonly UsagePeriod[] = [1, 7, 30];
export const USAGE_GROUPS: readonly UsageGroup[] = ["agent", "project", "model"];

/** Stale threshold for rate-limit observations (30 minutes, usage-and-cost.md §2.5). */
export const LIMIT_STALE_MS = 30 * 60_000;
/** Warning threshold for rate-limit windows (80 %, usage-and-cost.md §7). */
export const LIMIT_WARN_PERCENT = 80;

export type LimitWindowView = {
  window: string;
  label: string;
  usedPercent: number;
  barPercent: number;
  warn: boolean;
  resetText: string | null;
};

export type LimitCardView = {
  key: string;
  title: string;
  measuredText: string;
  stale: boolean;
  creditsText: string | null;
  reachedText: string | null;
  windows: LimitWindowView[];
};

export type UsageBreakdownRow = {
  key: string;
  label: string;
  costText: string;
  tokensText: string;
  breakdownText: string;
  totalTokens: number;
  costUsd: number | null;
  lowerBound: boolean;
};

export type UsageSummaryChip = {
  text: string;
  warn?: boolean;
  stale?: boolean;
};

export type UsageView = {
  hasData: boolean;
  summaryLimit: UsageSummaryChip | null;
  summaryCost: UsageSummaryChip | null;
  panelSummary: string;
  limits: LimitCardView[];
  periodTotalText: string;
  rows: UsageBreakdownRow[];
  noteText: string;
};

export function parseUsagePeriod(value: string | null): UsagePeriod {
  if (value === "1") return 1;
  if (value === "30") return 30;
  return 7;
}

export function parseUsageGroup(value: string | null): UsageGroup {
  if (value === "project" || value === "model") return value;
  return "agent";
}

/** Compact token count ("850", "12.4k", "1.5M"). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** Formats USD with two decimal places (or `< $0.01` shown as `0.01` when positive). */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "0.01";
  // Estimates have six decimal places. Restore that precision after summing before rounding to cents.
  const microdollars = Math.round(usd * 1_000_000);
  const cents = Math.round(microdollars / 10_000);
  return (cents / 100).toFixed(2);
}

function providerName(provider: string): string {
  return AGENT_NAMES[provider] ?? provider;
}

/** Labels a rate-limit window from `window_minutes` (usage-and-cost.md §2.4: never hard-code 5h/weekly). */
export function windowLabel(windowName: string, minutes: number | null): string {
  if (minutes !== null && minutes > 0) return duration(minutes * 60);
  const words = t().usage;
  return windowName === "primary" ? words.windowPrimary : windowName === "secondary" ? words.windowSecondary : windowName;
}

function resetTextOf(resetsAt: string | null, now: number): string | null {
  if (resetsAt === null) return null;
  const ms = Date.parse(resetsAt);
  if (Number.isNaN(ms)) return null;
  const words = t().usage;
  return ms <= now ? words.resetPassed : words.resetsIn(duration((ms - now) / 1000));
}

function limitCardOf(entry: LimitEntry, now: number): LimitCardView {
  const words = t().usage;
  const observedMs = Date.parse(entry.observed_at);
  const stale = !Number.isNaN(observedMs) && now - observedMs >= LIMIT_STALE_MS;
  const parts = [providerName(entry.provider)];
  if (entry.limit_name !== null && entry.limit_name !== entry.provider) parts.push(entry.limit_name);
  if (entry.plan_type !== null) parts.push(entry.plan_type);
  return {
    key: `${entry.provider}:${entry.limit_id}`,
    title: parts.join(" · "),
    measuredText: words.measuredAgo(ago(entry.observed_at, now)),
    stale,
    creditsText: entry.credits_balance !== null ? words.credits(entry.credits_balance) : null,
    reachedText: entry.reached !== null ? words.quotaReached : null,
    windows: entry.windows.map((w) => {
      const pct = Math.round(w.used_percent);
      return {
        window: w.window,
        label: windowLabel(w.window, w.window_minutes),
        usedPercent: pct,
        barPercent: Math.max(0, Math.min(100, pct)),
        warn: w.used_percent >= LIMIT_WARN_PERCENT || entry.reached !== null,
        resetText: resetTextOf(w.resets_at, now),
      };
    }),
  };
}

type Bucket = {
  key: string;
  label: string;
  in: number;
  cachedIn: number;
  cacheWriteIn: number;
  out: number;
  pricedUsd: number;
  hasPriced: boolean;
  hasUnpricedTokens: boolean;
  incomplete: boolean;
};

function aggregateRows(days: readonly UsageDay[], group: UsageGroup): { total: Bucket; rows: UsageBreakdownRow[] } {
  const words = t().usage;
  const makeBucket = (key: string, label: string): Bucket => ({
    key,
    label,
    in: 0,
    cachedIn: 0,
    cacheWriteIn: 0,
    out: 0,
    pricedUsd: 0,
    hasPriced: false,
    hasUnpricedTokens: false,
    incomplete: false,
  });
  const total = makeBucket("total", "");
  const byKey = new Map<string, Bucket>();

  const add = (bucket: Bucket, row: UsageDay) => {
    const rowTokens = row.in + row.cached_in + row.cache_write_in + row.out;
    bucket.in += row.in;
    bucket.cachedIn += row.cached_in;
    bucket.cacheWriteIn += row.cache_write_in;
    bucket.out += row.out;
    if (!row.complete) bucket.incomplete = true;
    if (row.estimated_cost_usd !== null) {
      bucket.pricedUsd += row.estimated_cost_usd;
      bucket.hasPriced = true;
    } else if (rowTokens > 0) {
      bucket.hasUnpricedTokens = true;
    }
  };

  for (const row of days) {
    add(total, row);
    const key = group === "agent" ? row.agent : group === "project" ? (row.project ?? "") : (row.model ?? "");
    const label =
      group === "agent"
        ? providerName(row.agent)
        : group === "project"
          ? (row.project ?? words.unnamedProject)
          : (row.model ?? words.unnamedModel);
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = makeBucket(key, label);
      byKey.set(key, bucket);
    }
    add(bucket, row);
  }

  const toRow = (b: Bucket): UsageBreakdownRow => {
    const totalTokens = b.in + b.cachedIn + b.cacheWriteIn + b.out;
    const lowerBound = b.hasPriced && (b.hasUnpricedTokens || b.incomplete);
    const costUsd = b.hasPriced ? Math.round(b.pricedUsd * 1_000_000) / 1_000_000 : null;
    const costText = costUsd !== null ? words.estimated(formatUsd(costUsd), lowerBound) : words.noPrice;
    return {
      key: b.key,
      label: b.label,
      costText,
      tokensText: words.tokensShort(formatTokens(totalTokens)),
      breakdownText: words.tokensBreakdown(formatTokens(b.in), formatTokens(b.cachedIn + b.cacheWriteIn), formatTokens(b.out)),
      totalTokens,
      costUsd,
      lowerBound,
    };
  };

  const rows = [...byKey.values()]
    .filter((b) => b.in + b.cachedIn + b.cacheWriteIn + b.out > 0 || b.hasPriced)
    .map(toRow)
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.totalTokens - a.totalTokens || a.label.localeCompare(b.label));

  return { total, rows };
}

export function usageView(
  usage: UsageResponse | null,
  limits: LimitsResponse | null,
  period: UsagePeriod,
  group: UsageGroup,
  now: number,
): UsageView {
  const words = t().usage;
  const limitCards = (limits?.limits ?? []).map((entry) => limitCardOf(entry, now));

  // Pick the highest-usage window across all limit entries for the top summary bar's single chip.
  let summaryLimit: UsageSummaryChip | null = null;
  if (limitCards.length > 0) {
    let bestCard = limitCards[0]!;
    let bestWin = bestCard.windows[0];
    for (const card of limitCards) {
      for (const win of card.windows) {
        if (bestWin === undefined || win.usedPercent > bestWin.usedPercent) {
          bestCard = card;
          bestWin = win;
        }
      }
    }
    if (bestWin !== undefined) {
      const shortName = bestCard.title.split(" · ")[0]!;
      summaryLimit = {
        text: words.summaryLimit(shortName, bestWin.usedPercent, limitCards.length - 1),
        warn: limitCards.some((c) => c.windows.some((w) => w.warn)),
        stale: limitCards.every((c) => c.stale),
      };
    }
  }

  const allDays = usage?.days ?? [];
  const tz = usage?.tz ?? "UTC";
  const dayStartsAt = usage?.day_starts_at ?? "00:00";
  const today = localDay(new Date(now).toISOString(), tz, dayStartsAt);
  const firstDay = addDays(today, -(period - 1));
  const todayRows = allDays.filter((row) => row.day === today);
  const periodRows = allDays.filter((row) => row.day >= firstDay && row.day <= today);

  const todayAgg = aggregateRows(todayRows, "agent");
  const todayTokens = todayAgg.total.in + todayAgg.total.cachedIn + todayAgg.total.cacheWriteIn + todayAgg.total.out;
  const todayLower = todayAgg.total.hasPriced && (todayAgg.total.hasUnpricedTokens || todayAgg.total.incomplete);
  const todayValue = todayAgg.total.hasPriced
    ? words.estimated(formatUsd(todayAgg.total.pricedUsd), todayLower)
    : todayTokens > 0
      ? words.tokensShort(formatTokens(todayTokens))
      : null;

  const hasUsageRows = allDays.some((r) => r.in + r.cached_in + r.cache_write_in + r.out > 0);
  const hasData = limitCards.length > 0 || hasUsageRows;

  const summaryCost: UsageSummaryChip | null =
    todayValue !== null
      ? { text: words.summaryToday(todayValue) }
      : hasUsageRows
        ? { text: words.summaryToday(words.estimated("0.00", false)) }
        : null;

  const periodAgg = aggregateRows(periodRows, group);
  const periodTokens = periodAgg.total.in + periodAgg.total.cachedIn + periodAgg.total.cacheWriteIn + periodAgg.total.out;
  const periodLower = periodAgg.total.hasPriced && (periodAgg.total.hasUnpricedTokens || periodAgg.total.incomplete);
  const periodCostPart = periodAgg.total.hasPriced ? words.estimated(formatUsd(periodAgg.total.pricedUsd), periodLower) : words.noPrice;
  const periodLabel = words.periods[String(period) as "1" | "7" | "30"];
  const periodTotalText =
    periodTokens > 0 || periodAgg.total.hasPriced
      ? `${periodLabel} · ${periodCostPart} · ${words.tokensShort(formatTokens(periodTokens))}`
      : `${periodLabel} · ${words.emptyPeriod}`;

  const headline = todayValue !== null ? words.summaryToday(todayValue) : summaryLimit !== null ? summaryLimit.text : periodCostPart;
  const panelSummary = hasData ? `${words.title} · ${headline}` : words.title;

  return {
    hasData,
    summaryLimit,
    summaryCost,
    panelSummary,
    limits: limitCards,
    periodTotalText,
    rows: periodAgg.rows,
    noteText: words.estimateNote(usage?.pricing?.version ?? null, usage?.pricing?.source === "custom"),
  };
}
