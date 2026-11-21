// The summary bar's limit and cost chips and the side panel's expandable usage section
// (`#usage-status`). Fetches `/v1/usage?days=30` and `/v1/limits` on the main screen (never on the
// viewer) and renders scrollable lists that scale to any number of services, projects and models.
import type { LimitsResponse, UsageResponse } from "@agent-office/core";
import { currentToken, viewerMode } from "./client.ts";
import { byId, el } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { readChoice, writeChoice } from "./prefs.ts";
import { parseUsageGroup, parseUsagePeriod, usageView } from "./usage.ts";
import type { UsageGroup, UsagePeriod } from "./usage.ts";

const PERIOD_KEY = "agent-office.usage-period";
const GROUP_KEY = "agent-office.usage-group";

export type UsagePanelDeps = {
  now: () => number;
  officeOnly: { isOn: () => boolean; set: (on: boolean, fullScreen: boolean) => void };
};

export function createUsagePanel({ now, officeOnly }: UsagePanelDeps) {
  let usage: UsageResponse | null = null;
  let limits: LimitsResponse | null = null;
  let period: UsagePeriod = readChoice(PERIOD_KEY, "the usage period is not readable", 7, parseUsagePeriod);
  let group: UsageGroup = readChoice(GROUP_KEY, "the usage grouping is not readable", "agent", parseUsageGroup);
  let loading = false;

  function render(): void {
    const details = byId<HTMLDetailsElement>("usage-status");
    const limitBtn = byId<HTMLButtonElement>("summary-limits");
    const costBtn = byId<HTMLButtonElement>("summary-cost");
    if (viewerMode) {
      details.hidden = true;
      limitBtn.hidden = true;
      costBtn.hidden = true;
      return;
    }
    const view = usageView(usage, limits, period, group, now());
    details.hidden = !view.hasData;
    limitBtn.hidden = view.summaryLimit === null;
    if (view.summaryLimit !== null) {
      limitBtn.textContent = view.summaryLimit.text;
      limitBtn.dataset["warn"] = String(Boolean(view.summaryLimit.warn));
      limitBtn.dataset["stale"] = String(Boolean(view.summaryLimit.stale));
    }
    costBtn.hidden = view.summaryCost === null;
    if (view.summaryCost !== null) {
      costBtn.textContent = view.summaryCost.text;
    }
    if (!view.hasData) return;

    byId("usage-summary").textContent = view.panelSummary;
    const limitsBox = byId("usage-limits");
    limitsBox.hidden = view.limits.length === 0;
    limitsBox.replaceChildren(
      ...view.limits.map((card) => {
        const item = el("div", "usage-limit-card");
        item.dataset["key"] = card.key;
        item.dataset["stale"] = String(card.stale);
        const head = el("div", "usage-limit-head");
        head.append(el("strong", "usage-limit-title", card.title));
        const metaParts = [card.reachedText, card.creditsText, card.measuredText].filter((part): part is string => part !== null);
        head.append(el("small", "usage-limit-meta", metaParts.join(" · ")));
        const winList = el("div", "usage-windows");
        for (const w of card.windows) {
          const row = el("div", "usage-window");
          row.dataset["window"] = w.window;
          row.dataset["warn"] = String(w.warn);
          const top = el("div", "usage-window-top");
          top.append(el("span", "usage-window-label", w.label), el("strong", "usage-window-pct", `${w.usedPercent}%`));
          if (w.resetText !== null) top.append(el("small", "usage-window-reset", w.resetText));
          const track = el("div", "progress-track usage-bar");
          const fill = el("span");
          fill.style.width = `${w.barPercent}%`;
          track.append(fill);
          row.append(top, track);
          winList.append(row);
        }
        item.append(head, winList);
        return item;
      }),
    );

    const words = t().usage;
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-usage-period]")) {
      const p = button.dataset["usagePeriod"] as "1" | "7" | "30";
      button.textContent = words.periods[p];
      button.setAttribute("aria-pressed", String(Number(p) === period));
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-usage-group]")) {
      const g = button.dataset["usageGroup"] as UsageGroup;
      button.textContent = words.groups[g];
      button.setAttribute("aria-pressed", String(g === group));
    }

    byId("usage-total").textContent = view.periodTotalText;
    const rowsBox = byId("usage-rows");
    rowsBox.hidden = view.rows.length === 0;
    rowsBox.replaceChildren(
      ...view.rows.map((row) => {
        const item = el("div", "usage-row");
        item.dataset["key"] = row.key;
        const head = el("div", "usage-row-head");
        head.append(el("strong", "usage-row-name", row.label), el("span", "usage-row-cost", row.costText));
        const sub = el("div", "usage-row-tokens", `${row.tokensText} · ${row.breakdownText}`);
        item.append(head, sub);
        return item;
      }),
    );
    byId("usage-note").textContent = view.noteText;
  }

  async function load(): Promise<void> {
    if (viewerMode || loading) return;
    const token = currentToken();
    if (token === null) return;
    loading = true;
    try {
      const headers = { authorization: `Bearer ${token}` };
      const [uReply, lReply] = await Promise.all([
        fetch("/v1/usage?days=30", { headers, cache: "no-store" }),
        fetch("/v1/limits", { headers, cache: "no-store" }),
      ]);
      if (uReply.ok) usage = (await uReply.json()) as UsageResponse;
      if (lReply.ok) limits = (await lReply.json()) as LimitsResponse;
      render();
    } catch (error) {
      console.warn("agent-office: usage unreachable", error);
    } finally {
      loading = false;
    }
  }

  function openPanel(): void {
    if (officeOnly.isOn()) officeOnly.set(false, false);
    const details = byId<HTMLDetailsElement>("usage-status");
    details.open = true;
    details.scrollIntoView({ block: "nearest" });
    void load();
  }

  function wire(on: (target: EventTarget, type: string, listener: EventListener) => void): void {
    on(byId("summary-limits"), "click", openPanel);
    on(byId("summary-cost"), "click", openPanel);
    on(byId("usage-status"), "toggle", () => {
      if (byId<HTMLDetailsElement>("usage-status").open) void load();
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-usage-period]")) {
      on(button, "click", () => {
        period = parseUsagePeriod(button.dataset["usagePeriod"] ?? "7");
        writeChoice(PERIOD_KEY, String(period), "the usage period is not remembered");
        render();
      });
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-usage-group]")) {
      on(button, "click", () => {
        group = parseUsageGroup(button.dataset["usageGroup"] ?? "agent");
        writeChoice(GROUP_KEY, group, "the usage grouping is not remembered");
        render();
      });
    }
  }

  return {
    load,
    render,
    wire,
    /** Test/direct setter for usage and limits data. */
    setData(nextUsage: UsageResponse | null, nextLimits: LimitsResponse | null): void {
      usage = nextUsage;
      limits = nextLimits;
      render();
    },
  };
}
