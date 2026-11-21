// The list's own controls: the summary row's buttons and the tabs (the arrow keys go round them),
// the search box, whether the All tab lists the apps' own threads, and the home tab's conditions; the
// last two are remembered on this device. Showing a tab opens the side panel when it is closed.
import { byId } from "./dom.ts";
import { HOME_FILTER_DEFAULT, parseHomeFilter, TABS } from "./lists.ts";
import type { HomeFilter, ListChoice, Tab } from "./lists.ts";
import { readChoice, writeChoice } from "./prefs.ts";

const SHOW_INTERNAL_KEY = "agent-office.show-internal";
const HOME_FILTER_KEY = "agent-office.home-filter";

export type ListControlsDeps = {
  /** Adds a listener the page removes again when it is taken down. */
  on: (target: EventTarget, type: string, listener: EventListener) => void;
  /** The full-window office, which hides the side panel. */
  officeOnly: { isOn: () => boolean; set: (on: boolean, fullScreen: boolean) => void };
  /** A choice changed: the list alone, the counts as well (`counts`: a tab's number follows its conditions), or what the whole page shows (`page`). */
  changed: (what: "list" | "counts" | "page") => void;
};

export function createListControls({ on, officeOnly, changed }: ListControlsDeps) {
  let tab: Tab = "needs";
  let query = "";
  let showInternal = readChoice(SHOW_INTERNAL_KEY, "the All tab's setting is not readable", false, (stored) => stored === "true");
  let homeFilter: HomeFilter = readChoice(HOME_FILTER_KEY, "the home tab's conditions are not readable", { ...HOME_FILTER_DEFAULT }, parseHomeFilter);

  /**
   * Shows a tab, opening the side panel when it is closed; `toggle` closes the panel instead when that tab
   * is already the one shown (the owner's "탭 닫힘", 2026-11-01: the whole panel, not the list under the row).
   */
  function showTab(next: Tab, toggle = false): void {
    const closed = officeOnly.isOn();
    if (toggle && !closed && next === tab) officeOnly.set(true, false);
    else if (closed) officeOnly.set(false, false);
    tab = next;
    changed("list");
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(".summary-item[data-show]"))
    on(button, "click", () => {
      showTab(button.dataset["show"] as Tab);
      byId("session-list").scrollIntoView({ block: "nearest" });
    });
  on(byId("search"), "input", (event) => {
    query = (event.target as HTMLInputElement).value;
    changed("list");
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) on(button, "click", () => showTab(button.dataset["tab"] as Tab, true));
  on(byId<HTMLInputElement>("show-internal"), "change", () => {
    showInternal = byId<HTMLInputElement>("show-internal").checked;
    writeChoice(SHOW_INTERNAL_KEY, String(showInternal), "the All tab's setting is not remembered");
    changed("page");
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-home-filter]"))
    on(button, "click", () => {
      const key = button.dataset["homeFilter"] as keyof HomeFilter;
      const value = button.dataset["value"] ?? "";
      homeFilter = { ...homeFilter, [key]: key === "agent" ? (value === "" ? null : value) : value };
      writeChoice(HOME_FILTER_KEY, JSON.stringify(homeFilter), "the home tab's conditions are not remembered");
      changed("counts");
    });
  on(byId("list-panel").querySelector(".list-tabs")!, "keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== "ArrowRight" && key !== "ArrowLeft") return;
    showTab(TABS[(TABS.indexOf(tab) + (key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!);
    byId(`tab-${tab}`).focus();
  });

  return {
    /** What the list shows now. */
    choice: (): ListChoice => ({ tab, query, homeFilter, showInternal }),
    showTab,
  };
}
