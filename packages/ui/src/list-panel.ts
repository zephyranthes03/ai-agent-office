// The list beside the office and what stands on the scene for each session: the summary row's and
// the tabs' numbers, the list's rows (kept and moved, not rebuilt, so focus stays), and the buttons
// over the scene's colleagues with their markers. Each render reads the page's state as it is then.
import { byId, el } from "./dom.ts";
import { delegationStale, delegationWait, markerText, sceneTag, statusLine, targetLine, tone } from "./format.ts";
import type { LabelsShow, NeedsMarker, SceneTag } from "./format.ts";
import { t } from "./i18n/index.ts";
import { allTab, homeFiltered, listed, rowTime } from "./lists.ts";
import type { HomeFilter, ListChoice } from "./lists.ts";
import { agentLine } from "./model.ts";
import type { Office, SessionView } from "./model.ts";
import { accessibleName, portrait, star } from "./widgets.ts";
import type { PortraitUrl } from "./widgets.ts";

/** What the page holds when it renders. */
export type ListState = ListChoice & {
  office: Office;
  selectedId: string | null;
  /** Sessions on their way home, still standing in the scene. */
  departing: ReadonlyMap<string, SessionView>;
  seats: ReadonlyMap<string, string>;
  /** Whose name tags show without pointing, and when a needs-you marker grows stronger (the owner's settings). */
  labelsShow: LabelsShow;
  needsMarker: NeedsMarker;
  now: () => number;
  /** A start, stop or restart under way for a session, as the list's chip says it (none on the viewer). */
  controlChip?: (id: string) => string | null;
};

/** A scene tag's parts as nodes (the stylesheet puts the separators, and shows the project and agent instead of the name and signal on phones). */
function tagNodes(tag: SceneTag): HTMLElement[] {
  const nodes = [el("span", "tag-symbol", tag.symbol)];
  if (tag.name !== null) nodes.push(el("span", "tag-name", tag.name));
  if (tag.project !== null && tag.agent !== null) nodes.push(el("span", "tag-project", tag.project), el("span", "tag-agent", tag.agent));
  if (tag.text) nodes.push(el("span", "tag-text", tag.text));
  if (tag.waited !== null) nodes.push(el("span", "tag-waited", tag.waited));
  return nodes;
}

export type ListPanelDeps = {
  portraitUrl: PortraitUrl;
  select: (id: string, source: HTMLElement | null) => void;
  setHover: (id: string) => void;
  clearHover: (id: string) => void;
};

export function createListPanel(deps: ListPanelDeps) {
  const { select, setHover, clearHover } = deps;
  /** The buttons over the scene's colleagues, by session (the page places them each frame). */
  const targets = new Map<string, HTMLButtonElement>();
  const rows = new Map<string, HTMLButtonElement>();

  function renderSummary({ office, showInternal, homeFilter, now }: ListState): void {
    byId("count-needs").textContent = String(office.counts.needsYou);
    byId("count-working").textContent = String(office.counts.working);
    byId("count-resting").textContent = String(office.counts.resting);
    byId("count-long").textContent = String(office.counts.long);
    byId("summary-needs").dataset["active"] = String(office.counts.needsYou > 0);
    // The whole office says someone needs you, for the corner of the eye: a still light at its edge.
    byId("office-panel").dataset["needs"] = String(office.counts.needsYou > 0);
    byId("tab-count-needs").textContent = String(office.counts.needsYou);
    byId("handle-count").textContent = String(office.counts.needsYou);
    byId("list-handle").dataset["active"] = String(office.counts.needsYou > 0);
    byId("tab-count-working").textContent = String(office.counts.working);
    byId("tab-count-resting").textContent = String(office.counts.resting);
    byId("count-waiting").textContent = String(office.counts.waiting);
    byId("tab-count-waiting").textContent = String(office.counts.waiting);
    byId("tab-count-all").textContent = String(allTab(office, showInternal).length);
    // Like the All tab's number follows its checkbox, the home tab's follows its conditions (not the search box).
    byId("tab-count-home").textContent = String(homeFiltered(office.home, homeFilter, now()).length);
    document.title = office.counts.needsYou > 0 ? `(${office.counts.needsYou}) agent office` : "agent office";
  }

  function renderList({ office, tab, query, homeFilter, showInternal, selectedId, now, controlChip }: ListState): void {
    const list = byId("session-list");
    const views = listed(office, { tab, query, homeFilter, showInternal }, now());
    const wanted = new Set(views.map((view) => view.id));
    for (const [id, row] of rows)
      if (!wanted.has(id)) {
        row.remove();
        rows.delete(id);
      }
    for (const [index, view] of views.entries()) {
      let row = rows.get(view.id);
      if (row === undefined) {
        row = el("button", "worker-row");
        row.type = "button";
        row.dataset["id"] = view.id;
        const id = view.id;
        row.addEventListener("click", () => select(id, rows.get(id) ?? null));
        row.addEventListener("pointerenter", () => setHover(id));
        row.addEventListener("pointerleave", () => clearHover(id));
        rows.set(view.id, row);
      }
      row.dataset["tone"] = tone(view);
      row.dataset["active"] = String(view.active);
      row.style.setProperty("--identity-color", view.identity.color);
      row.style.setProperty("--identity-ink", view.identity.ink);
      row.setAttribute("aria-pressed", String(selectedId === view.id));
      row.setAttribute("aria-label", accessibleName(view));
      const copy = el("span", "worker-copy");
      const name = el("span", "worker-name");
      name.append(...star(view), view.name, " ", el("span", "identity-code", view.identity.code));
      // A scheduler's run, or a task waiting for one, says so beside its name.
      if (view.event.origin === "scheduled") name.append(el("span", "worker-chip", t().list.scheduled));
      // Work handed to other sessions and not yet back: a chip wherever the session is listed; faded once a day has passed.
      const open = view.event.delegations?.open ?? [];
      if (open.length > 0) {
        const chip = el("span", "worker-chip delegation-chip", t().format.delegatedCount(open.length));
        chip.title = delegationWait(open);
        if (open.every((item) => delegationStale(item.since, now()))) chip.classList.add("is-stale");
        name.append(chip);
      }
      const control = controlChip?.(view.id) ?? null;
      if (control !== null) name.append(el("span", "worker-chip control-chip", control));
      name.append(el("small", undefined, agentLine(view)));
      const task = el("span", "worker-task", [statusLine(view), targetLine(view)].filter(Boolean).join(" · "));
      // A helper says whose it is, indented under that session.
      const parent = view.event.parent;
      row.dataset["child"] = String(parent !== null);
      if (parent !== null) copy.append(el("span", "worker-parent", `↳ ${office.all.find((item) => item.id === parent)?.name ?? parent}`));
      copy.append(name, task);
      const meta = el("span", "worker-meta");
      const mark = markerText(view.marker, now());
      const status = el("span", "worker-status", mark?.symbol ?? "·");
      status.setAttribute("aria-hidden", "true");
      meta.append(status, el("span", "worker-time", rowTime(view, now())));
      row.replaceChildren(portrait(view, deps.portraitUrl), copy, meta);
      // Move a row only when it is out of place: moving a focused row would drop keyboard focus.
      const at = list.children[index] ?? null;
      if (at !== row) list.insertBefore(row, at);
    }
    const empty = byId("list-empty");
    empty.hidden = views.length > 0;
    empty.textContent = query !== "" ? t().list.noMatch : t().list.empty[tab];
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      const on = button.dataset["tab"] === tab;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    }
    byId("home-filters").hidden = tab !== "home";
    byId("all-filters").hidden = tab !== "all";
    byId<HTMLInputElement>("show-internal").checked = showInternal;
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-home-filter]")) {
      const key = button.dataset["homeFilter"] as keyof HomeFilter;
      button.setAttribute("aria-pressed", String((homeFilter[key] ?? "") === button.dataset["value"]));
    }
    list.setAttribute("aria-labelledby", `tab-${tab}`);
  }

  function renderTargets({ office, departing, seats, selectedId, labelsShow, needsMarker, now }: ListState): void {
    const layer = byId("actor-targets");
    const shown = [...office.inOffice, ...[...departing.values()].filter((view) => !office.inOffice.some((item) => item.id === view.id))];
    const present = new Set(shown.map((view) => view.id));
    for (const [id, button] of targets)
      if (!present.has(id)) {
        button.remove();
        targets.delete(id);
      }
    for (const view of shown) {
      let button = targets.get(view.id);
      if (button === undefined) {
        button = el("button", "actor-target");
        button.type = "button";
        button.hidden = true;
        button.dataset["id"] = view.id;
        const id = view.id;
        button.addEventListener("pointerenter", () => setHover(id));
        button.addEventListener("pointerleave", () => clearHover(id));
        button.addEventListener("focus", () => setHover(id));
        button.addEventListener("blur", () => clearHover(id));
        button.addEventListener("click", () => select(id, targets.get(id) ?? null));
        targets.set(view.id, button);
        layer.append(button);
      }
      button.dataset["tone"] = tone(view);
      button.dataset["seat"] = seats.get(view.id) ?? "";
      button.dataset["marker"] = view.marker?.kind ?? "none";
      button.setAttribute("aria-label", accessibleName(view));
      button.setAttribute("aria-pressed", String(selectedId === view.id));
      button.style.setProperty("--identity-color", view.identity.color);
      button.style.setProperty("--identity-ink", view.identity.ink);
      const badge = el("span", "actor-badge");
      badge.setAttribute("aria-hidden", "true");
      const tag = sceneTag(view, now(), labelsShow, needsMarker);
      badge.hidden = tag === null || !tag.loud;
      const fatigued = view.marker?.kind === "long";
      badge.classList.toggle("fatigue", fatigued);
      if (tag !== null) {
        const nodes = tagNodes(tag);
        if (fatigued) {
          nodes[0]!.classList.add("fatigue-sweat");
          nodes[0]!.textContent = "";
        }
        badge.append(...nodes);
      }
      badge.classList.toggle("named", tag?.name != null);
      if (tag?.stage == null) delete button.dataset["stage"];
      else button.dataset["stage"] = String(tag.stage);
      button.dataset["label"] = labelsShow === "everyone" ? "always" : "pointing";
      const label = el("span", "actor-label");
      label.setAttribute("aria-hidden", "true");
      label.append(...star(view), el("span", "identity-name", view.name), el("span", "identity-code", view.identity.code));
      button.replaceChildren(badge, label);
    }
  }

  return { targets: targets as ReadonlyMap<string, HTMLButtonElement>, renderSummary, renderList, renderTargets };
}
