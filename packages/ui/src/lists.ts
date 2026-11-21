// The list beside the office: which sessions a tab shows for the search box and the home tab's
// conditions, in which order, the time each row shows, and the home tab's conditions as stored on
// this device. Pure: the page passes what it holds and renders the result.
import { ago, forHow } from "./format.ts";
import { agentLine, leftAt, withChildrenUnderParents } from "./model.ts";
import type { Office, SessionView } from "./model.ts";

export type Tab = "needs" | "working" | "resting" | "waiting" | "all" | "home";
/** The tabs in their order on screen (the arrow keys go round them). */
export const TABS: readonly Tab[] = ["needs", "working", "resting", "waiting", "all", "home"];

/** The home tab's conditions: an agent, a span back from now (by when the session left), and whether only sessions worth a look. */
export type HomeFilter = { agent: string | null; range: "1h" | "2h" | "today" | "all"; kind: "all" | "look" };
export const HOME_FILTER_DEFAULT: HomeFilter = { agent: null, range: "all", kind: "all" };
const RANGES: readonly HomeFilter["range"][] = ["1h", "2h", "today", "all"];
const RANGE_S: Record<HomeFilter["range"], number | null> = { "1h": 3600, "2h": 7200, today: null, all: null };

/** A session that left in a way worth a look: its process went mid-turn, or its last turn failed. Esc was the owner's own doing. */
export const worthALook = (view: SessionView): boolean => view.ended?.by === "lost" || view.event.result?.outcome === "failed";

/** The All tab: who is in the office (sessions gone home are on the home tab), plus the apps' own threads when the owner asks to see them. */
export const allTab = (office: Office, showInternal: boolean): SessionView[] => office.present.filter((view) => view.away === null && (showInternal || view.internal === null));

/** The home tab's rows under `filter`, at `now` (ms); "today" counts from this device's local midnight. */
export function homeFiltered(views: readonly SessionView[], filter: HomeFilter, now: number): SessionView[] {
  const span = RANGE_S[filter.range];
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const floor = span !== null ? now - span * 1000 : filter.range === "today" ? midnight.getTime() : null;
  return views.filter((view) => (filter.agent === null || view.event.agent === filter.agent) && (floor === null || Date.parse(leftAt(view)) >= floor) && (filter.kind === "all" || worthALook(view)));
}

/** Case-insensitive search over what a row shows: name tag, project, code, agent, state target, and the owner's description. */
export function matches(view: SessionView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [view.name, view.event.project ?? "", view.identity.code, agentLine(view), view.event.detail ?? "", view.event.waiting_on?.target ?? "", view.note?.description ?? ""].some((text) => text.toLowerCase().includes(needle));
}

export type ListChoice = { tab: Tab; query: string; homeFilter: HomeFilter; showInternal: boolean };

/**
 * The rows of a tab: the search box narrows them. On the office tabs a helper (subagent) is listed
 * right under the session it works for; the All tab puts the sessions the owner watches first (in
 * their usual order).
 */
export function listed(office: Office, { tab, query, homeFilter, showInternal }: ListChoice, nowMs: number): SessionView[] {
  const source = tab === "needs" ? office.needsYou : tab === "working" ? office.working : tab === "resting" ? office.resting : tab === "waiting" ? office.waiting : tab === "home" ? homeFiltered(office.home, homeFilter, nowMs) : allTab(office, showInternal);
  const found = source.filter((view) => matches(view, query));
  const ordered = tab === "needs" || tab === "home" ? found : withChildrenUnderParents(found);
  return tab === "all" ? [...ordered.filter((view) => view.watched), ...ordered.filter((view) => !view.watched)] : ordered;
}

/** A row's time: how long it has waited or run long, else how long ago it ended, finished or last changed. */
export function rowTime(view: SessionView, nowMs: number): string {
  if (view.needs !== null) return forHow(view.needs.since, nowMs);
  if (view.long !== null) return forHow(view.long.since, nowMs);
  if (view.ended !== null) return ago(view.ended.since, nowMs);
  if (view.ready !== null) return ago(view.ready.since, nowMs);
  return ago(view.event.ts, nowMs);
}

/**
 * The home tab's conditions from their stored text (null: none stored): fields of the wrong kind
 * fall back one by one to the defaults. Text that is not JSON throws, for the caller to report.
 */
export function parseHomeFilter(text: string | null): HomeFilter {
  const stored = JSON.parse(text ?? "null") as Partial<HomeFilter> | null;
  if (stored === null || typeof stored !== "object") return { ...HOME_FILTER_DEFAULT };
  return {
    agent: typeof stored.agent === "string" ? stored.agent : null,
    range: RANGES.includes(stored.range as HomeFilter["range"]) ? (stored.range as HomeFilter["range"]) : "all",
    kind: stored.kind === "look" ? "look" : "all",
  };
}
