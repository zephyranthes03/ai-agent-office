// The address fragment the desktop app's notification clicks use (a browser link works the same):
// `#session=<id>` opens that session's card, `#tab=needs|working|resting|waiting|all|home` shows a
// list tab, and with a session, `opened=<means>&reason=<reason>` says how the app's own open of it
// went (`none`: nothing could open it). `#notifications=blocked|allowed` is the app saying whether the
// system refuses its notifications.
import { TABS } from "./lists.ts";
import type { Tab } from "./lists.ts";

export type Fragment = { session: string | null; tab: Tab | null; opened: { means: string | null; reason: string | null } | null; notificationsBlocked: boolean | null };

/** What `hash` asks for, or null when it names no session, tab or notification state; a tab that is not one of the list's is left out. */
export function readFragment(hash: string): Fragment | null {
  const params = new URLSearchParams(hash.slice(1));
  const session = params.get("session");
  const tab = params.get("tab");
  const notifications = params.get("notifications");
  const notificationsBlocked = notifications === "blocked" ? true : notifications === "allowed" ? false : null;
  if (session === null && tab === null && notificationsBlocked === null) return null;
  const means = session === null ? null : params.get("opened");
  return {
    session,
    tab: TABS.includes(tab as Tab) ? (tab as Tab) : null,
    opened: means === null ? null : { means: means === "none" ? null : means, reason: params.get("reason") },
    notificationsBlocked,
  };
}
