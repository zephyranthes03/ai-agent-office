// The desktop app: joins the daemon that runs for this home, or starts one in a utility
// process; shows the browser UI in a window; keeps a tray icon with the count of sessions that need
// you; and turns the stream's `notification` events into clickable notifications. The window gets
// the UI the way a browser does, with a one-time launch code, and the main process reads
// the stream with a UI token of its own, so neither can send hooks or events. A click on a
// notification brings the window forward and opens the session's card through the page's address
// fragment, and the same fragment tells the page while the system refuses notifications; there is no
// preload script and no IPC. A notification makes the owner's sound (sound.ts), naming the species the
// office shows for the session. The tray, notifications and dialogs speak the
// owner's ui.language (from the stream's `settings`), else the system's languages; a language chosen
// in the window stays in the window.
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification as Toast, session, shell, Tray, utilityProcess } from "electron";
import type { MenuItemConstructorOptions, UtilityProcess } from "electron";
import { requestLaunchCode } from "@agent-office/cli/launch";
import { findDaemon, officeHome } from "@agent-office/cli/transport";
import { listDevices, requestPairCode, revokeDevice, spacedCode } from "@agent-office/cli/viewer";
import type { Device } from "@agent-office/cli/viewer";
import { parseViewerAddress } from "@agent-office/daemon";
import { createSseParser } from "@agent-office/ui/sse";
import { isLanguageChoice, resolveLanguage, setLanguage, t } from "@agent-office/ui/i18n";
import { DEFAULT_CAST, SPECIES, speciesOf } from "@agent-office/ui/model";
import type { Cast, Species } from "@agent-office/ui/model";
import { hasSound, play, soundDue, soundFor } from "./sound.ts";
import type { SoundChoice } from "./sound.ts";
import { fragmentFor, notificationText } from "./text.ts";
import type { Notification } from "./text.ts";

const RETRY_MS = [1000, 2000, 5000, 10_000];
const STOP_MS = 5000;
const HOUR_MS = 3_600_000;

const home = officeHome();
// `npm run app -- --viewer <address>`: the read-only viewer for phones and tablets, passed to a
// daemon the app starts (a daemon it joins keeps its own setting). Checked here so a typo is said at once.
const viewerAt = process.argv.indexOf("--viewer");
const viewerArg = viewerAt < 0 ? null : (process.argv[viewerAt + 1] ?? "");
const viewerProblem = viewerArg === null ? null : (() => {
  const parsed = parseViewerAddress(viewerArg);
  return "problem" in parsed ? parsed.problem : null;
})();
/** Paired viewer devices for the tray menu; null when the daemon has no viewer listener. */
let devices: Device[] | null = null;
/** The daemon this app started; null when it joined one that was already running. */
let owned: UtilityProcess | null = null;
let origin: string | null = null;
/** The daemon start the window's UI token belongs to; a restarted daemon forgets UI tokens. */
let windowFor: string | null = null;
/** The main process's own UI token and the daemon start it belongs to; reused across reconnects, since the daemon keeps only 16. */
let streamToken: { started: string; token: string } | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let needsYou = 0;
/** Notifications are off until this time (Infinity: until turned on again); in memory only. */
let mutedUntil: number | null = null;
let muteTimer: NodeJS.Timeout | null = null;
let quitting = false;
let warned = false;
/** Why the system refused the last notification (macOS: notifications not allowed for the app); null once one is shown. */
let blocked: string | null = null;
/** What the stream last said of the owner's settings and the sessions, for the species a notification's sound and text name. */
let cast: Cast = DEFAULT_CAST;
let soundChoice: SoundChoice = "chime";
const sessionsSeen = new Map<string, { agent: string; project: string | null }>();
/** What the app reads of a stream session (a standard event). */
type SessionFacts = { session: string; agent: string; project?: string | null };
/** The species chosen on a session's card (its note), by session. */
let chosenSpecies: Record<string, string | null> = {};
/** The species the tray's test notification cries as next, in the office's order. */
let testTurn = 0;
const stopping = new AbortController();
// Shown notifications are kept referenced until clicked or closed, or macOS may drop the click.
const shown = new Set<Toast>();

function startOwnDaemon(): Promise<number> {
  return new Promise((resolve, reject) => {
    const hostAt = process.argv.indexOf("--viewer-host");
    const host = hostAt < 0 ? undefined : process.argv[hostAt + 1];
    const args = viewerArg !== null && viewerProblem === null ? ["--viewer", viewerArg, ...(host === undefined ? [] : ["--viewer-host", host])] : [];
    const child = utilityProcess.fork(fileURLToPath(new URL("./daemon-process.ts", import.meta.url)), args, { serviceName: "agent-office daemon", stdio: "pipe" });
    let errors = "";
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => (errors = (errors + chunk.toString()).slice(-2000)));
    child.once("exit", (code) => {
      if (owned === child) owned = null;
      reject(new Error(`the daemon stopped (exit ${code})${errors ? `: ${errors.trim()}` : ""}`));
    });
    child.on("message", (message: { type?: unknown; port?: unknown }) => {
      if (message.type !== "ready" || typeof message.port !== "number") return;
      owned = child;
      resolve(message.port);
    });
  });
}

/** The running daemon's port: the one daemon.json names (it proves itself before any request), else a new one. */
async function ensureDaemon(): Promise<number> {
  const found = findDaemon(home);
  return "problem" in found ? startOwnDaemon() : found.port;
}

async function launchCode(): Promise<{ code: string; port: number }> {
  const daemon = findDaemon(home);
  if ("problem" in daemon) throw new Error(`the daemon is not reachable (${daemon.problem})`);
  const launch = await requestLaunchCode(home, daemon);
  if ("problem" in launch) throw new Error(launch.problem);
  return { code: launch.code, port: daemon.port };
}

/** When the daemon at `port` started (GET /v1/health needs no token). */
async function startedAt(port: number): Promise<string> {
  const reply = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: stopping.signal });
  if (reply.status !== 200) throw new Error(`health HTTP ${reply.status}`);
  return String(((await reply.json()) as { started_at?: unknown }).started_at);
}

const sameOrigin = (url: string) => origin !== null && URL.canParse(url) && new URL(url).origin === origin;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: "agent office",
    backgroundColor: "#f3efe4",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!sameOrigin(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!sameOrigin(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // The page's "open the notification settings" (shown only while the system refuses notifications) sets this fragment.
  contents.on("did-navigate-in-page", (_event, url) => {
    if (sameOrigin(url) && new URL(url).hash === "#notification-settings") void openNotificationSettings();
  });
  win.once("ready-to-show", () => win.show());
  // Closing the window keeps the app in the tray; "Quit" in the tray menu quits.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  return win;
}

/** Loads the office into the window with a fresh launch code (first start, or the daemon restarted). */
async function loadOffice(port: number, started: string): Promise<void> {
  const { code } = await launchCode();
  origin = `http://127.0.0.1:${port}`;
  window ??= createWindow();
  await window.loadURL(`${origin}/#launch=${code}`);
  if (blocked !== null) tellPageBlocked();
  windowFor = started;
}

/** Brings the window forward; `fragment` (`session=<id>`, `tab=needs`) is handed to the page without a reload. */
function reveal(fragment: string | null): void {
  if (window === null || origin === null) return;
  if (fragment !== null) void window.loadURL(`${origin}/#${fragment}`);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}

/**
 * A notification click goes to the session itself: the daemon brings its terminal forward (or opens it
 * again), and the card is loaded behind it with the result. Only when that did not work does the
 * window come forward, so it never covers the terminal the user was sent to.
 */
async function openFromNotification(n: Notification): Promise<void> {
  if (n.opens === "queue" || origin === null || streamToken === null) return reveal(fragmentFor(n));
  let result: { means: string | null; reason: string | null } = { means: null, reason: null };
  try {
    const reply = await fetch(`${origin}/v1/sessions/${encodeURIComponent(n.session)}/open`, { method: "POST", headers: { authorization: `Bearer ${streamToken.token}` }, signal: stopping.signal });
    if (reply.status === 200) result = (await reply.json()) as typeof result;
    else console.warn(`agent-office: open session HTTP ${reply.status}`);
  } catch (error) {
    console.warn("agent-office: open session failed", error);
  }
  const fragment = `${fragmentFor(n)}&opened=${result.means ?? "none"}${result.reason === null ? "" : `&reason=${result.reason}`}`;
  if (result.means === null) return reveal(fragment);
  if (window !== null) void window.loadURL(`${origin}/#${fragment}`);
}

const muted = () => mutedUntil !== null && Date.now() < mutedUntil;

function mute(until: number | null): void {
  mutedUntil = until;
  if (muteTimer !== null) clearTimeout(muteTimer);
  muteTimer = until !== null && Number.isFinite(until) ? setTimeout(() => mute(null), until - Date.now()) : null;
  refreshTray();
}

/** The species the office shows for a notification's session (the same rule as the screen's); null when the app has not seen the session, as for a missed scheduled task. */
function speciesFor(n: Notification): Species | null {
  const seen = sessionsSeen.get(n.session);
  if (n.signal === "schedule_missed" || seen === undefined) return null;
  return speciesOf(n.session, seen.agent, cast, chosenSpecies[n.session] ?? null, seen.project);
}

/** The page shows a note while the system refuses notifications (the address fragment, as for clicks). */
function tellPageBlocked(): void {
  if (window !== null && origin !== null) void window.loadURL(`${origin}/#notifications=${blocked === null ? "allowed" : "blocked"}`);
}

/** `test`: the tray's test notification, shown even while notifications are paused. */
function notify(n: Notification, species: Species | null = speciesFor(n), test = false): void {
  if ((!test && muted()) || !Toast.isSupported()) return;
  const { title, body } = notificationText(n, species);
  const sound = soundFor(soundChoice, species, hasSound);
  const audible = sound !== null && soundDue(Date.now());
  const toast = new Toast({ title, body, silent: !audible || sound !== "system" });
  if (audible && sound !== "system") play(sound.file).catch((error: unknown) => console.warn("agent-office: notification sound failed", error));
  shown.add(toast);
  toast.on("click", () => {
    shown.delete(toast);
    void openFromNotification(n);
  });
  toast.on("close", () => shown.delete(toast));
  toast.on("show", () => {
    if (blocked === null) return;
    blocked = null;
    refreshTray();
    tellPageBlocked();
  });
  // A refused notification is reported, never dropped silently: logged, and the tray menu says so.
  toast.on("failed", (_event, error) => {
    shown.delete(toast);
    console.warn("agent-office: notification refused by the system", error);
    const first = blocked === null;
    blocked = error;
    refreshTray();
    if (first) tellPageBlocked();
  });
  toast.show();
}

/** The language of the tray, notifications and dialogs: the owner's ui.language (undefined until the stream says, or from an older daemon), else the system's languages. */
function useLanguage(owner: unknown): void {
  setLanguage(resolveLanguage("auto", isLanguageChoice(owner) ? owner : undefined, app.getPreferredSystemLanguages()));
}

function refreshTray(): void {
  if (tray === null) return;
  const words = t().desktop;
  if (process.platform === "darwin") tray.setTitle(needsYou > 0 ? String(needsYou) : "");
  tray.setToolTip(needsYou > 0 ? words.trayNeedsYou(needsYou) : "agent office");
  const until = mutedUntil !== null && Number.isFinite(mutedUntil) ? new Date(mutedUntil).toLocaleTimeString(t().locale, { hour: "2-digit", minute: "2-digit" }) : null;
  const items: MenuItemConstructorOptions[] = [
    { label: words.open, click: () => reveal(null) },
    { label: words.showNeedsYou(needsYou), click: () => reveal("tab=needs") },
    { type: "separator" },
    ...(muted()
      ? [{ label: until === null ? words.unmute : words.unmuteUntil(until), click: () => mute(null) }]
      : [
          { label: words.muteHour, click: () => mute(Date.now() + HOUR_MS) },
          { label: words.muteUntilOn, click: () => mute(Number.POSITIVE_INFINITY) },
        ]),
    ...(blocked === null ? [] : [{ label: words.blocked, click: () => void openNotificationSettings() }]),
    { label: words.testNotification, click: () => testNotification() },
    { type: "separator" },
    { label: words.pair, click: () => void pairDevice().catch((error: unknown) => console.warn("agent-office: pairing", error)) },
    ...(devices === null || devices.length === 0
      ? []
      : [{ label: words.devices(devices.length), submenu: devices.map((device) => ({ label: words.unpair(device.name, device.created_at.slice(5, 10).replace("-", "/")), click: () => void revoke(device).catch((error: unknown) => console.warn("agent-office: revoke", error)) })) }]),
    { type: "separator" },
    { label: words.quit, click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/** A sample approval wait with the owner's sound; with cries, each test cries as the next species. */
function testNotification(): void {
  const species = soundChoice === "animal" ? SPECIES[testTurn++ % SPECIES.length]! : null;
  notify({ id: `test-${Date.now()}`, kind: "needs_you", signal: "approval", session: "", since: new Date().toISOString(), agent: "claude-code", title: t().desktop.testTitle, target: null, turn_s: null, opens: "queue" }, species, true);
}

/** Shows a code and the address a phone or tablet opens to pair (the viewer listener). */
async function pairDevice(): Promise<void> {
  const daemon = findDaemon(home);
  const pair = "problem" in daemon ? daemon : await requestPairCode(home, daemon);
  const words = t().desktop;
  const detail = "code" in pair ? words.pairHow(pair.url, spacedCode(pair.code), Math.round(pair.expiresInS / 60)) : "viewerOff" in pair ? words.viewerOff : words.noCode(pair.problem);
  await dialog.showMessageBox({ type: "info", message: words.pairTitle, detail, buttons: [words.ok] });
  await refreshDevices();
}

async function revoke(device: Device): Promise<void> {
  const daemon = findDaemon(home);
  const done = "problem" in daemon ? daemon : await revokeDevice(home, daemon, device.id);
  if (done !== true) console.warn("agent-office: revoke failed", done);
  await refreshDevices();
}

/** Reads the paired devices for the tray menu (on start, after pairing or revoking, and every minute). */
async function refreshDevices(): Promise<void> {
  const daemon = findDaemon(home);
  const found = "problem" in daemon ? null : await listDevices(daemon);
  devices = Array.isArray(found) ? found : null;
  refreshTray();
}

/** The system's notification settings, where the app can be allowed to notify. */
async function openNotificationSettings(): Promise<void> {
  if (process.platform === "darwin") await shell.openExternal("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
}

/** A UI token for the main process's own stream. */
async function uiToken(): Promise<string> {
  const { code, port } = await launchCode();
  const reply = await fetch(`http://127.0.0.1:${port}/v1/ui/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }), signal: stopping.signal });
  if (reply.status !== 201) throw new Error(`ui session HTTP ${reply.status}`);
  return ((await reply.json()) as { token: string }).token;
}

/** Reads the stream until it ends: the tray count from `attention`, the language, cast and sound from `settings`, each session's agent and project and each note's species (for the species a notification names), notifications from `notification`. */
async function readStream(port: number, token: string, connected: () => void): Promise<void> {
  const reply = await fetch(`http://127.0.0.1:${port}/v1/stream`, { headers: { authorization: `Bearer ${token}` }, signal: stopping.signal });
  // A token the daemon no longer knows is replaced on the next attempt.
  if (reply.status === 401) streamToken = null;
  if (reply.status !== 200 || reply.body === null) throw new Error(`stream HTTP ${reply.status}`);
  connected();
  const parse = createSseParser((name, data) => {
    if (name === "attention") {
      needsYou = (JSON.parse(data) as { needs_you: unknown[] }).needs_you.length;
      refreshTray();
    } else if (name === "settings") {
      const settings = JSON.parse(data) as { language?: unknown; cast?: Cast["cast"]; species?: Cast["species"]; notification_sound?: SoundChoice };
      useLanguage(settings.language);
      // An older daemon sends no cast or sound: the defaults.
      cast = { cast: settings.cast ?? DEFAULT_CAST.cast, species: settings.species ?? DEFAULT_CAST.species };
      soundChoice = settings.notification_sound ?? "chime";
      refreshTray();
    } else if (name === "sessions") {
      sessionsSeen.clear();
      for (const event of JSON.parse(data) as SessionFacts[]) sessionsSeen.set(event.session, { agent: event.agent, project: event.project ?? null });
    } else if (name === "session") {
      const event = JSON.parse(data) as SessionFacts;
      sessionsSeen.set(event.session, { agent: event.agent, project: event.project ?? null });
    } else if (name === "notes") {
      const notes = JSON.parse(data) as Record<string, { species?: string | null }>;
      chosenSpecies = Object.fromEntries(Object.entries(notes).map(([id, note]) => [id, note.species ?? null]));
    } else if (name === "notification") notify(JSON.parse(data) as Notification);
  });
  const decoder = new TextDecoder();
  for await (const chunk of reply.body) parse(decoder.decode(chunk, { stream: true }));
}

/** Keeps a daemon, the window and the stream going until the app quits, retrying with back-off. */
async function run(): Promise<void> {
  let attempt = 0;
  while (!quitting) {
    try {
      const port = await ensureDaemon();
      const started = await startedAt(port);
      if (windowFor !== started) await loadOffice(port, started);
      if (streamToken?.started !== started) streamToken = { started, token: await uiToken() };
      await readStream(port, streamToken.token, () => {
        attempt = 0;
        refreshDevices().catch((error: unknown) => console.warn("agent-office: devices", error));
      });
    } catch (error) {
      if (quitting) return;
      console.warn("agent-office: daemon connection lost", error);
      if (!warned && window === null) {
        warned = true;
        dialog.showErrorBox("agent office", t().desktop.daemonUnreachable(error instanceof Error ? error.message : String(error)));
      }
    }
    if (quitting) return;
    needsYou = 0;
    refreshTray();
    await sleep(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]!, undefined, { signal: stopping.signal }).catch((error: unknown) => {
      if (!stopping.signal.aborted) throw error;
    });
  }
}

// One app per office home: the profile (and with it the single-instance lock) lives in the home's
// private folder, so a second app for the same home hands over to the first, and another home
// (tests, a second office) runs its own.
app.setPath("userData", join(home, "app"));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => reveal(null));
  app.on("activate", () => reveal(null));
  // The window stays hidden in the tray; only "Quit" in the tray menu quits.
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", () => {
    quitting = true;
    stopping.abort();
  });
  // A daemon the app started stops with it; one it joined keeps running.
  app.on("will-quit", (event) => {
    const child = owned;
    if (child === null) return;
    event.preventDefault();
    owned = null;
    const timer = setTimeout(() => child.kill(), STOP_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      app.quit();
    });
    child.postMessage({ type: "stop" });
  });
  // Not awaited at the top level: an ES module entry that awaits `ready` would never see it.
  void app.whenReady().then(() => {
    // The page asks for almost nothing: camera, notifications from the page and the like are refused.
    // Only writing to the clipboard (the card's "copy" of a resume command) is allowed.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "clipboard-sanitized-write"));
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === "clipboard-sanitized-write");
    useLanguage(undefined);
    const icon = nativeImage.createFromPath(fileURLToPath(new URL("../assets/trayTemplate.png", import.meta.url)));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    refreshTray();
    if (viewerProblem !== null) dialog.showErrorBox("agent office", `--viewer ${viewerArg}: ${viewerProblem}\n${t().desktop.withoutViewer}`);
    void run();
    setInterval(() => void refreshDevices().catch((error: unknown) => console.warn("agent-office: devices", error)), 60_000).unref();
  });
}
