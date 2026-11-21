// The page's connection to the daemon. The page proves it was opened by the daemon's owner with
// the one-time launch code in its URL fragment (from `agent-office ui`), trades it for a UI token,
// and reads the stream with that token in the Authorization header. No cookie is used: cookies are
// shared by every port of 127.0.0.1. The token is kept in this tab's sessionStorage, so a reload works
// and other tabs and origins never see it.
import type { FromOlderDaemon, SceneSettings, StandardEvent, Warnings } from "@agent-office/core";
import type { Attention, ControlsState, Notes, Schedule } from "./model.ts";
import type { Notice } from "./notice.ts";
import { createSseParser } from "./sse.ts";

const STORAGE_KEY = "agent-office.ui-token";
const LAUNCH = /^#launch=([0-9a-f]{64})$/;
const RETRY_MS = [1000, 2000, 5000, 10_000];

/** As the daemon sends them; older daemons leave out `cast`, `species`, `board`, `schedule` (and in it `rest_after_min`), `labels`, `needs_you_marker`, `needs_you_glow`, `language` and `notification_sound`. */
export type Settings = Pick<SceneSettings, "wander_after_s"> & Partial<Omit<SceneSettings, "wander_after_s" | "schedule">> & { schedule?: FromOlderDaemon<SceneSettings["schedule"], "rest_after_min"> };
export type Connection = "connecting" | "live" | "retrying" | "needs-launch" | "needs-pair" | "failed";
/** The daemon's `warnings` event: `hooks` when hooks are not, or may not be, reaching it (older daemons never send it). */
export type { Warnings };
export type StreamHandlers = {
  sessions: (sessions: StandardEvent[]) => void;
  session: (session: StandardEvent) => void;
  attention: (attention: Attention) => void;
  /** The scheduled tasks the agents' schedulers plan (older daemons never send it). */
  schedule: (schedule: Schedule) => void;
  notes: (notes: Notes) => void;
  /** The owner's settings the screen needs (scene.wander_after_s, scene.cast, species). */
  settings: (settings: Settings) => void;
  warnings: (warnings: Warnings) => void;
  /** Lifecycle controls: recent requests and what can be asked now (the main listener only; older daemons never send it). */
  controls: (state: ControlsState) => void;
  /** The daemon decided to notify (the viewer shows and sounds it; the desktop app shows its own). */
  notification: (notice: Notice) => void;
  status: (status: Connection) => void;
  /** Anything arrived on the stream, the daemon's 15-second keep-alive included: the connection is alive. */
  alive: () => void;
};

// Storage can be switched off (policies, some private windows): the token then lives for this page
// only, and a reload needs a new launch link. That is reported once, not hidden.
let tabStorage: Storage | undefined;
try {
  tabStorage = sessionStorage;
} catch (error) {
  console.warn("agent-office: session storage unavailable; a reload will need a new launch link", error);
}
let memory: string | null = null;

// On the read-only viewer (a phone or tablet), the page holds a device token instead, kept in this
// origin's localStorage so the device stays paired across reloads; revoking it on the computer ends it.
const DEVICE_KEY = "agent-office.device-token";
let deviceStorage: Storage | undefined;
try {
  deviceStorage = localStorage;
} catch (error) {
  console.warn("agent-office: local storage unavailable; this device will need a new code after a reload", error);
}

/** Whether this page is served by the viewer listener (decided once, by `detectMode`). */
export let viewerMode = false;

/** Asks the server which listener this is; the main API has no such file. */
export async function detectMode(): Promise<void> {
  const reply = await fetch("/mode.json", { cache: "no-store" });
  viewerMode = reply.ok && ((await reply.json()) as { mode?: unknown }).mode === "viewer";
}

/** The UI token this tab holds, for the page's one action (open session). */
export const currentToken = (): string | null => stored();

function stored(): string | null {
  const [storage, key] = viewerMode ? [deviceStorage, DEVICE_KEY] : [tabStorage, STORAGE_KEY];
  return storage === undefined ? memory : storage.getItem(key);
}

function store(token: string | null): void {
  memory = token;
  const [storage, key] = viewerMode ? [deviceStorage, DEVICE_KEY] : [tabStorage, STORAGE_KEY];
  if (storage === undefined) return;
  if (token === null) storage.removeItem(key);
  else storage.setItem(key, token);
}

/** Pairs this device with a code from the computer; false when the code is wrong or has lapsed. */
export async function pairDevice(code: string, name: string): Promise<boolean> {
  const reply = await fetch("/v1/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
  if (reply.status === 401) return false;
  if (reply.status !== 201) throw new Error(`pairing failed: HTTP ${reply.status}`);
  store(((await reply.json()) as { token: string }).token);
  return true;
}

/** A launch link that was refused: used already (perhaps by someone else) or older than a minute. */
export let launchRefused = false;

/** The UI token: traded from a launch code in the fragment, or kept from earlier in this tab. */
export async function authenticate(): Promise<string | null> {
  if (viewerMode) return stored();
  const launch = LAUNCH.exec(location.hash);
  if (launch !== null) {
    // The code works once; drop it from the address bar and history before using it.
    history.replaceState(null, "", location.pathname + location.search);
    const reply = await fetch("/v1/ui/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: launch[1] }) });
    if (reply.status === 201) {
      const token = ((await reply.json()) as { token: string }).token;
      store(token);
      return token;
    }
    if (reply.status !== 401) throw new Error(`launch failed: HTTP ${reply.status}`);
    launchRefused = true;
    // An expired or used code: fall back to a token this tab already has.
  }
  return stored();
}

/** Follows /v1/stream until `signal` aborts, reconnecting with back-off; each connect starts from the full lists. */
export async function follow(token: string, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    handlers.status(attempt === 0 ? "connecting" : "retrying");
    let reply: Response;
    try {
      reply = await fetch("/v1/stream", { headers: { authorization: `Bearer ${token}` }, signal, cache: "no-store" });
    } catch (error) {
      if (signal.aborted) return;
      console.warn("agent-office: stream unreachable", error);
      await pause(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]!, signal);
      continue;
    }
    if (reply.status === 401) {
      store(null);
      handlers.status(viewerMode ? "needs-pair" : "needs-launch");
      return;
    }
    if (!reply.ok || reply.body === null) {
      await pause(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]!, signal);
      continue;
    }
    const parse = createSseParser((name, data) => {
      const value: unknown = JSON.parse(data);
      if (name === "sessions") handlers.sessions(value as StandardEvent[]);
      else if (name === "session") handlers.session(value as StandardEvent);
      else if (name === "attention") handlers.attention(value as Attention);
      else if (name === "schedule") handlers.schedule(value as Schedule);
      else if (name === "notes") handlers.notes(value as Notes);
      else if (name === "settings") handlers.settings(value as Settings);
      else if (name === "warnings") handlers.warnings(value as Warnings);
      else if (name === "controls") handlers.controls(value as ControlsState);
      else if (name === "notification") handlers.notification(value as Notice);
    });
    const reader = reply.body.pipeThrough(new TextDecoderStream()).getReader();
    handlers.status("live");
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        handlers.alive();
        parse(value);
      }
    } catch (error) {
      if (signal.aborted) return;
      console.warn("agent-office: stream interrupted", error);
    }
    attempt = 1;
    await pause(RETRY_MS[0]!, signal);
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
