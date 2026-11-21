// The hover preview: a small card over the office about the colleague or row under the pointer. It
// appears a moment after the pointer arrives (never while a card is pinned or on a touch screen),
// lingers a moment after it leaves so the pointer can reach it, and follows its colleague as the scene
// moves. The page's state is read when it is used. Session text is always set as text.
import { byId, el } from "./dom.ts";
import { ago, toolLine } from "./format.ts";
import { t } from "./i18n/index.ts";
import { agentLine } from "./model.ts";
import type { Office } from "./model.ts";
import type { ActorBox } from "./scene.ts";
import { pill, star } from "./widgets.ts";

/** Delay before the preview shows for a hovered colleague, and before it hides once the pointer has left. */
export const SHOW_AFTER_MS = 220;
export const HIDE_AFTER_MS = 180;

export type PreviewDeps = {
  state: () => { office: Office; selectedId: string | null };
  /** Whether hovering may show it now (not on a phone-sized screen). */
  enabled: () => boolean;
  now: () => number;
  /** The scene's colleagues as drawn in the last frame. */
  actors: () => readonly ActorBox[] | undefined;
  /** The buttons over the scene's colleagues, which the preview describes while it is shown. */
  targets: ReadonlyMap<string, HTMLElement>;
};

export function createPreview({ state, enabled, now, actors, targets }: PreviewDeps) {
  let shownId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function show(id: string): void {
    const { office, selectedId } = state();
    const view = office.present.find((item) => item.id === id) ?? office.all.find((item) => item.id === id);
    if (view === undefined || selectedId !== null) return hide();
    shownId = id;
    const card = byId("preview-card");
    card.style.setProperty("--identity-color", view.identity.color);
    const name = el("p", "preview-name");
    name.append(...star(view), view.name);
    name.append(" ", el("span", "identity-code", view.identity.code));
    const line = el("div", "preview-state");
    line.append(pill(view, now()));
    const tool = toolLine(view);
    const parts: HTMLElement[] = [name, el("p", "preview-task", agentLine(view)), line, el("p", "preview-task", `${tool.label} · ${tool.value}`)];
    parts.push(el("p", "preview-facts", t().app.lastSignal(ago(view.event.ts, now()))), el("span", "preview-tip", t().app.clickForDetail));
    card.replaceChildren(...parts);
    card.hidden = false;
    targets.get(id)?.setAttribute("aria-describedby", "preview-card");
    place();
  }

  function hide(): void {
    clearTimeout(timer);
    if (shownId !== null) targets.get(shownId)?.removeAttribute("aria-describedby");
    shownId = null;
    byId("preview-card").hidden = true;
  }

  /** Puts the shown preview above its colleague, or below when there is no room above. */
  function place(): void {
    const box = actors()?.find((actor) => actor.id === shownId);
    const card = byId("preview-card");
    const stage = byId("stage");
    if (box === undefined) {
      // A row's preview without a character in view sits at the top of the stage.
      card.style.left = "12px";
      card.style.top = "48px";
      return;
    }
    card.style.left = `${Math.max(8, Math.min(box.anchorX - card.offsetWidth / 2, stage.clientWidth - card.offsetWidth - 8))}px`;
    const above = box.anchorY - card.offsetHeight - 12;
    card.style.top = `${above >= 10 ? above : Math.min(box.top + box.height + 12, stage.clientHeight - card.offsetHeight - 8)}px`;
  }

  return {
    /** The session the preview is about, null while hidden. */
    shownId: () => shownId,
    show,
    hide,
    place,
    /** The pointer reached a colleague or a row: show its preview after a moment. */
    enter(id: string): void {
      clearTimeout(timer);
      if (state().selectedId === null && enabled()) timer = setTimeout(() => show(id), SHOW_AFTER_MS);
    },
    /** The pointer left: hide after a moment, unless it reaches the preview first (`hold`). */
    leave(): void {
      clearTimeout(timer);
      timer = setTimeout(hide, HIDE_AFTER_MS);
    },
    /** The pointer is on the preview itself: keep it. */
    hold(): void {
      clearTimeout(timer);
    },
    destroy(): void {
      clearTimeout(timer);
    },
  };
}
