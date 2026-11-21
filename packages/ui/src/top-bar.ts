// The top bar's notes: the stream's connection, the hooks' warning, in the desktop app whether the
// system refuses its notifications (with a way to its settings; the owner may close the note until the
// next start), whether the art loaded, and on the viewer when the stream last showed it is alive. Each keeps what it was last told, so it can be
// written again in another language.
import type { Connection, Warnings } from "./client.ts";
import { viewerMode } from "./client.ts";
import { byId } from "./dom.ts";
import { t } from "./i18n/index.ts";

export function createTopBar() {
  let connection: Connection = "connecting";
  let warnings: Warnings = { hooks: null };
  /** undefined: still loading; null: loaded; else why it failed. */
  let artProblem: string | null | undefined;
  /** When the stream last showed it is alive (data or the 15-second keep-alive). */
  let lastData: number | null = null;
  let notificationsBlocked = false;
  let blockedNoteClosed = false;

  // The app opens the system's notification settings when the page's fragment says so (packages/app/src/main.ts).
  byId("notify-settings").addEventListener("click", () => {
    location.hash = "notification-settings";
    history.replaceState(null, "", location.pathname + location.search);
  });
  byId("notify-dismiss").addEventListener("click", () => {
    blockedNoteClosed = true;
    renderNotificationsNote();
  });

  /** On the viewer, when the connection was last confirmed (at most about 15 s ago while it lives), so a stale screen is not taken for a live one. */
  function renderLastUpdate(): void {
    const label = byId("last-update");
    label.hidden = !viewerMode || lastData === null;
    if (lastData !== null) label.textContent = t().app.checkedAt(new Date(lastData).toLocaleTimeString(t().locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  }
  function renderConnection(): void {
    byId("connection-text").textContent = t().app.connection[connection];
    byId("connection").dataset["state"] = connection;
  }
  function renderWarnings(): void {
    const note = byId("hook-warning");
    const hooks = warnings.hooks;
    note.hidden = hooks === null;
    note.dataset["code"] = hooks?.code ?? "";
    note.textContent = hooks === null ? "" : hooks.code === "hooks-not-delivered" ? t().app.hooksNotDelivered : t().app.launcherMissing;
  }
  function renderNotificationsNote(): void {
    byId("notify-warning").hidden = !notificationsBlocked || blockedNoteClosed;
    byId("notify-warning-text").textContent = t().app.notificationsBlocked;
    byId("notify-settings").textContent = t().app.openNotificationSettings;
    byId("notify-dismiss").textContent = t().app.dismissNote;
  }
  function renderArtNote(): void {
    const note = byId("art-note");
    note.hidden = artProblem === null;
    note.textContent = artProblem === undefined ? t().app.artLoading : artProblem === null ? "" : t().app.artFailed(artProblem);
  }

  return {
    renderLastUpdate,
    /** The stream showed it is alive at `at` (written with the next render). */
    alive(at: number): void {
      lastData = at;
    },
    setConnection(status: Connection): void {
      connection = status;
      renderConnection();
    },
    setWarnings(next: Warnings): void {
      warnings = next;
      renderWarnings();
    },
    /** The desktop app said whether the system refuses its notifications. */
    setNotificationsBlocked(blocked: boolean): void {
      notificationsBlocked = blocked;
      renderNotificationsNote();
    },
    /** null once the art loaded, else why it failed. */
    setArt(problem: string | null): void {
      artProblem = problem;
      renderArtNote();
    },
    /** Writes the notes again in the language shown now. */
    relabel(): void {
      renderConnection();
      renderWarnings();
      renderNotificationsNote();
      renderArtNote();
    },
  };
}
