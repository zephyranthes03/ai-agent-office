// The weather outside the office's window (the design handoff 2026-11-10-office-weather §3, with the
// owner's rules of 2026-11-13), from what the office already knows, first rule first: rain while a
// session needs the owner (an approval or input wait, a failed or lost turn, a missed scheduled run),
// cloud while a turn runs long, night once nobody is in the office itself (everyone gone home or on a
// waiting room bench, where the quiet ones sit too, or no session at all), and clear otherwise — work
// going well and rest alike. Only the view outside changes; the room and its light stay as they are.
import type { Office } from "./model.ts";

export const WEATHERS = ["clear", "cloudy", "rain", "dark"] as const;
export type Weather = (typeof WEATHERS)[number];

export function weatherOf(office: Office): Weather {
  if (office.counts.needsYou > 0) return "rain";
  if (office.counts.long > 0) return "cloudy";
  const benched = new Set(office.waiting.map((view) => view.id));
  return office.inOffice.some((view) => !benched.has(view.id)) ? "clear" : "dark";
}
