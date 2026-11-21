// The full-window office: the list steps aside (a card still opens over it), and the browser goes
// full screen when it can. The choice is remembered on this device.
import { byId } from "./dom.ts";
import { t } from "./i18n/index.ts";
import { readChoice, writeChoice } from "./prefs.ts";

const OFFICE_ONLY_KEY = "agent-office.office-only";

/** `redraw` draws the scene again at the office's new size. */
export function createOfficeOnly(redraw: () => void) {
  const isOn = () => byId("app").classList.contains("office-only");
  function label(): void {
    byId("expand-office").textContent = isOn() ? t().app.showList : t().app.expand;
  }
  /** Turns the full-window office on or off; `fullScreen` also asks the browser for full screen when turning it on. */
  function set(on: boolean, fullScreen: boolean): void {
    byId("app").classList.toggle("office-only", on);
    byId("expand-office").setAttribute("aria-pressed", String(on));
    label();
    byId("list-handle").hidden = !on;
    writeChoice(OFFICE_ONLY_KEY, on ? "1" : null, "the view choice is not remembered");
    if (fullScreen && on && document.fullscreenElement === null && document.documentElement.requestFullscreen !== undefined) {
      document.documentElement.requestFullscreen().catch((error: unknown) => console.warn("agent-office: full screen refused", error));
    }
    if (!on && document.fullscreenElement !== null) document.exitFullscreen().catch((error: unknown) => console.warn("agent-office: leaving full screen failed", error));
    redraw();
  }
  /** Applies the remembered choice. Only reading it may fail quietly; applying it fails like the rest of the page's start. */
  function restore(): void {
    if (readChoice(OFFICE_ONLY_KEY, "the view choice is not readable", false, (stored) => stored === "1")) set(true, false);
    else label();
  }
  return { isOn, set, label, restore };
}
