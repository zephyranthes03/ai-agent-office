// The pieces the wall objects and their record dialogs are built from: a node builder, a month's
// reward plaque, the record's chart, progress bar and stamps, and the short lines of words around
// them. They draw what a board view says (board.ts) and judge nothing. The page allows no markup
// strings (Trusted Types) and no inline style attributes: everything is built as nodes, and styles go
// through the CSSOM.
import { t } from "./i18n/index.ts";
import type { BoardView, MonthView } from "./board.ts";

export const MONTH_NAMES = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

export const number = (value: number | null) => (value === null ? "—" : value.toLocaleString(t().locale));
export const percent = (value: number | null) => (value === null ? "—" : `${value}%`);
const clamp = (value: number | null) => Math.max(0, Math.min(100, value ?? 0));
export const monthIndex = (key: string) => Number(key.slice(5, 7)) - 1;

type Child = Node | string | null | false;
type Attributes = Record<string, string | number | undefined>;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) if (value !== undefined) node.setAttribute(name, String(value));
  for (const child of children) if (child !== null && child !== false) node.append(child);
  return node;
}
function s(tag: string, attributes: Attributes = {}, ...children: Child[]): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) if (value !== undefined) node.setAttribute(name, String(value));
  for (const child of children) if (child !== null && child !== false) node.append(child);
  return node;
}

/** A month's reward: a small arched plaque with a leaf, sun or star. */
export function awardArt(record: MonthView): SVGElement {
  const index = monthIndex(record.key);
  const autumn = index > 7;
  const color = autumn ? "#b68145" : "#718c59";
  const pale = autumn ? "#f0dfb5" : "#e0e7c7";
  const stroke = { fill: "none", stroke: "currentColor", "stroke-linecap": "round" };
  const emblem =
    index % 3 === 0
      ? [s("path", { d: "M44 27v34M44 42c-17-1-20-10-20-17 13 0 20 5 20 17M44 50c17-1 21-11 21-18-13 0-21 6-21 18", ...stroke, "stroke-width": 2.8 })]
      : index % 3 === 1
        ? [s("circle", { cx: 45, cy: 43, r: 10, fill: "none", stroke: "currentColor", "stroke-width": 2.8 }), s("path", { d: "M45 24v5m0 28v5M26 43h5m28 0h5M32 30l4 4m19 19 4 4m0-27-4 4M36 53l-4 4", ...stroke, "stroke-width": 2.5 })]
        : [s("path", { d: "m45 25 6 12 13 2-10 10 2 13-11-6-12 6 3-13-10-10 13-2Z", fill: "currentColor", opacity: 0.85 }), s("path", { d: "M22 46c-2 16 8 23 14 25M68 46c2 16-8 23-14 25", fill: "none", stroke: "currentColor", "stroke-width": 1.7 })];
  const art = s(
    "svg",
    { class: "award-art", viewBox: "0 0 90 110", "aria-hidden": "true" },
    s("path", { d: "M10 91V40C10 19 25 8 45 8s35 11 35 32v51Z", fill: "#cfad79" }),
    s("path", { d: "M15 88V40c0-18 13-27 30-27s30 9 30 27v48Z", fill: pale, stroke: "#faf4dc", "stroke-width": 1.4 }),
    s("path", { d: "M19 86V41c0-15 11-24 26-24s26 9 26 24v45", fill: "none", stroke: color, "stroke-opacity": 0.25 }),
    ...emblem,
    s("text", { x: 45, y: 80, "text-anchor": "middle", "font-family": "Georgia,serif", "font-size": 11, fill: color }, `${index + 1} · ${record.key.slice(0, 4)}`),
    s("rect", { x: 5, y: 91, width: 80, height: 8, rx: 2, fill: "#a28155" }),
    s("rect", { x: 2, y: 99, width: 86, height: 5, rx: 2, fill: "#b79767" }),
  );
  art.style.color = color;
  return art;
}

/** Bars per day (or month), or the running total against the goal; gaps stay gaps. */
export function chart(v: BoardView, today: string, { cumulative = false, compact = false } = {}): SVGElement {
  const width = 260, top = 7, bottom = 61, left = 3, right = 257;
  let running = 0;
  const points = v.series.map((point) => {
    if (point.value === null) return point;
    running += point.value;
    return { ...point, value: cumulative ? running : point.value };
  });
  const max = Math.max(1, ...points.map((point) => point.value ?? 0), cumulative ? (v.target ?? 0) : 0);
  const x = (i: number) => left + (i * (right - left)) / Math.max(1, points.length - 1);
  const y = (value: number) => bottom - (value / max) * (bottom - top);
  const shapes: SVGElement[] = [
    s("line", { x1: 0, y1: bottom, x2: 260, y2: bottom, stroke: "#b7c1a4", "stroke-width": 0.7 }),
    s("line", { x1: 0, y1: top + 24, x2: 260, y2: top + 24, stroke: "#cbd2bc", "stroke-width": 0.6, "stroke-dasharray": "2 4" }),
  ];
  if (cumulative) {
    let segment: string[] = [];
    const flush = () => {
      if (segment.length > 1) shapes.push(s("polyline", { points: segment.join(" "), fill: "none", stroke: "#7a9568", "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round" }));
      segment = [];
    };
    points.forEach((point, i) => {
      if (point.value === null) {
        flush();
        if (!point.future) shapes.push(s("line", { x1: x(i), y1: bottom - 3, x2: x(i), y2: bottom, stroke: "#afb89b", "stroke-width": 2 }));
        return;
      }
      segment.push(`${x(i)},${y(point.value)}`);
      shapes.push(s("circle", { cx: x(i), cy: y(point.value), r: v.isQuarter ? 3 : 1.4, fill: "#718b5f" }));
    });
    flush();
    if (v.target !== null) shapes.push(s("line", { x1: 0, y1: y(v.target), x2: 260, y2: y(v.target), stroke: "#bd9b65", "stroke-width": 1, "stroke-dasharray": "4 4" }));
  } else {
    const cell = width / points.length;
    const bar = Math.min(v.isQuarter ? 30 : 5, cell * 0.62);
    points.forEach((point, i) => {
      const bx = cell * i + (cell - bar) / 2;
      if (point.value === null) shapes.push(s("rect", { x: bx, y: bottom - 3, width: bar, height: 3, fill: "none", stroke: "#b5bea4", "stroke-width": 0.7, "stroke-dasharray": point.future ? "1 2" : undefined }));
      else shapes.push(s("rect", { x: bx, y: y(point.value), width: bar, height: Math.max(1, bottom - y(point.value)), rx: Math.min(bar / 2, 2), fill: point.key === today ? "#b89759" : "#91a47d" }));
    });
  }
  const label = t().wall.chartLabel(v.title, cumulative, v.coverageLabel, number(v.total));
  return s("svg", { class: compact ? "sparkline compact" : "sparkline", viewBox: `0 0 ${width} 70`, role: "img", "aria-label": label }, ...shapes);
}
export function progress(v: BoardView): HTMLElement {
  const fill = h("span");
  fill.style.width = `${clamp(v.percent)}%`;
  return h("div", { class: "progress-track", role: "progressbar", "aria-label": t().wall.goalProgress(v.periodLabel), "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": clamp(v.percent), "aria-valuetext": t().wall.turnsOf(number(v.total), number(v.target)) }, fill);
}
export function smallStamps(v: BoardView): HTMLElement | null {
  if (v.target === null || !v.hasRecords) return null;
  return h("div", { class: "board-stamps" }, ...v.stamps.map((stamp) => h("span", { class: stamp.earned ? "board-stamp earned" : "board-stamp" }, `${stamp.threshold}%`)));
}
export function stamps(v: BoardView): Node[] {
  if (v.target === null || !v.hasRecords) return [];
  return [
    h("p", { class: "milestone-caption" }, v.isQuarter ? t().wall.quarterStamps : t().wall.monthStamps),
    h("div", { class: "milestones" }, ...v.stamps.map((stamp) => h("div", { class: stamp.earned ? "milestone earned" : "milestone", "aria-label": t().wall.stamp(stamp.threshold, stamp.earned) }, h("span", { class: "milestone-icon" }, stamp.earned ? "✳" : "·"), h("span", {}, `${stamp.threshold}%`)))),
  ];
}
export const periodMonths = (v: BoardView) => h("div", { class: "period-months" }, ...v.months.map((m) => h("div", { class: m.status === "future" ? "future" : undefined }, m.label, h("b", {}, number(m.total)))));
/** Cancelled turns, apart from the count (the owner stopped them: neither a failure nor a completion). */
export const cancelledLine = (cancelled: number | null) => (cancelled === null ? null : h("p", { class: "record-cancelled" }, t().wall.cancelled(number(cancelled))));
/** Labelled figures in a row; a figure may carry a small line under it (what it is made of). */
export const metrics = (items: [string, string, string?][]) => h("div", { class: "detail-metrics" }, ...items.map(([label, value, detail]) => h("p", {}, label, h("b", {}, value), detail !== undefined && h("small", {}, detail))));
export const note = (...lines: string[]) => h("p", { class: "record-note" }, ...lines.flatMap((line, i) => (i === 0 ? [line] : [h("br"), line])));
export const empty = (mark: string, ...lines: string[]) => h("div", { class: "record-empty" }, h("span", {}, mark), ...lines.flatMap((line, i) => (i === 0 ? [line] : [h("br"), line])));
export function rewardText(m: MonthView): string {
  const words = t().wall;
  if (m.status === "future") return words.rewardFuture;
  if (m.total === null) return words.rewardNoRecords;
  if (m.target === null) return words.rewardNoGoal;
  if (m.earned) return m.isCurrent ? words.rewardEarnedCurrent : words.rewardEarned;
  return m.isCurrent ? words.rewardCollecting : words.rewardKept;
}
export const pendingMark = (m: MonthView) => (m.status === "future" ? "·" : m.total === null ? "—" : m.target === null ? "○" : "✧");
