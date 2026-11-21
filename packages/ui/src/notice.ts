// What a notification says, on every screen that shows one: the desktop app's notifications, the
// viewer's banner and its web push (sw.ts). The daemon decides when to notify and has already
// removed what screen-share mode and the viewer's detail level hide; this only puts the fields into
// the screen's own words, in the language shown: what happened first, then whose it is (the name
// tag's name: the nickname, else the project, else the agent), and in the body the agent, what the
// wait is about (or how long the finished turn took) and the species the office shows, so a cry and
// its colleague go together.
import { duration, signalLabel } from "./format.ts";
import { t } from "./i18n/index.ts";
import { AGENT_NAMES, speciesName } from "./model.ts";
import type { Notification as Notice } from "@agent-office/core";
import type { Species } from "./model.ts";

/** The stream's `notification` event. */
export type { Notice };

export function noticeText(n: Notice, species: Species | null = null): { title: string; body: string } {
  const agent = AGENT_NAMES[n.agent] ?? n.agent;
  const words = t().desktop;
  const what = n.signal === "ready" ? words.finishedTurn : signalLabel(n.signal);
  const title = `${what} · ${n.title ?? agent}`;
  const about = n.signal === "ready" ? (n.turn_s === null ? words.durationUnknown : words.took(duration(n.turn_s))) : n.target;
  return { title, body: [agent, about, species === null ? null : speciesName(species)].filter((part) => part !== null).join(" · ") };
}

/** The page's address fragment a notification opens (app.ts reads it). */
export function noticeFragment(n: Notice): string {
  return n.opens === "queue" ? "tab=needs" : `session=${encodeURIComponent(n.session)}`;
}
