// The pinned card's panel: in place of the list on a wide screen, a modal sheet over the page on a
// phone-sized one, with the rest of the page inert and the focus kept inside the sheet.
import { byId } from "./dom.ts";
import { t } from "./i18n/index.ts";

const modalParts = () => document.querySelectorAll<HTMLElement>(".topbar, .summary-bar, .office-panel, #list-panel, footer");

/** Shows the card's panel when a card is `open`, as a modal sheet on a `phone`-sized screen, and the hint for that screen. */
export function syncSheet(open: boolean, phone: boolean): void {
  const modal = open && phone;
  byId("detail-panel").hidden = !open;
  byId("list-panel").hidden = open && !phone;
  byId("sheet-backdrop").hidden = !modal;
  document.body.classList.toggle("sheet-open", modal);
  byId("interaction-hint").textContent = phone ? t().app.hintTouch : t().app.hintPointer;
  for (const part of modalParts()) part.inert = modal;
  const panel = byId("detail-panel");
  if (modal) {
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
  } else {
    panel.removeAttribute("role");
    panel.removeAttribute("aria-modal");
  }
}

/** Tab past the open sheet's last button comes back to its first, Shift+Tab before the first goes to the last. */
export function keepFocusInSheet(key: KeyboardEvent): void {
  const buttons = [...byId("detail-panel").querySelectorAll<HTMLButtonElement>("button")];
  const first = buttons[0];
  const last = buttons.at(-1);
  if (key.shiftKey && document.activeElement === first) {
    key.preventDefault();
    last?.focus();
  } else if (!key.shiftKey && document.activeElement === last) {
    key.preventDefault();
    first?.focus();
  }
}
