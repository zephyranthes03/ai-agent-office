// The small pieces a session is shown with in the list, the hover card and the pinned card: its
// portrait with its identity code, its status pill, the star of a watched session, and the name a
// screen reader announces.
import { el } from "./dom.ts";
import { markerText, statusLine, tone } from "./format.ts";
import { t } from "./i18n/index.ts";
import type { Identity } from "./identity.ts";
import { agentLine } from "./model.ts";
import type { SessionView, Species } from "./model.ts";

/** The scene's portrait image of a species in an identity's colours, or null until the art is ready. */
export type PortraitUrl = (species: Species, identity: Identity) => string | null;

export function portrait(view: SessionView, urlOf: PortraitUrl, large = false): HTMLSpanElement {
  const node = el("span", `portrait${large ? " large" : ""}`);
  node.setAttribute("aria-hidden", "true");
  node.dataset["species"] = view.species;
  node.style.setProperty("--identity-color", view.identity.color);
  node.style.setProperty("--identity-ink", view.identity.ink);
  const url = urlOf(view.species, view.identity);
  if (url !== null) node.style.backgroundImage = `url("${url}")`;
  node.append(el("span", "portrait-code", view.identity.code));
  return node;
}

export function pill(view: SessionView, nowMs: number): HTMLSpanElement {
  const node = el("span", "status-pill");
  node.dataset["tone"] = tone(view);
  const mark = markerText(view.marker, nowMs);
  if (mark !== null) {
    const symbol = el("span", undefined, mark.symbol);
    symbol.setAttribute("aria-hidden", "true");
    node.append(symbol, " ");
  }
  node.append(statusLine(view));
  return node;
}

/** A star before the name of a session the owner watches. */
export const star = (view: SessionView): HTMLElement[] => {
  if (!view.watched) return [];
  const mark = el("span", "watch-star", "★");
  mark.setAttribute("aria-label", t().card.watched);
  return [mark];
};

export const accessibleName = (view: SessionView) => `${view.name} · ${t().card.identity(view.identity.code)} · ${agentLine(view)} · ${statusLine(view)}`;
