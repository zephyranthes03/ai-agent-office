// The loopback HTTP API. Every request must name this daemon's own address in `Host` (and in
// `Origin` when a browser sends one), which defeats DNS rebinding; no CORS headers are sent, so web
// pages cannot read anything. Every route except /v1/health, the launch-code exchange and the UI's
// static files needs a bearer token: the owner's token (the token file) for everything, or a UI
// token (ui-auth.ts) for the read routes only. Bodies are at most 16 KiB. Responses carry fixed
// error codes and never echo what was sent.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CHALLENGE_PATTERN, DAEMON_PROOF_PREFIX } from "@agent-office/core";
import type { StandardEvent, Warnings } from "@agent-office/core";
import type { Attention } from "./attention.ts";
import type { Ingestor, Prepared, Rejection } from "./ingest.ts";
import type { SceneSettings } from "./config.ts";
import type { Notes } from "./notes.ts";
import { parseNote } from "./notes.ts";
import type { Notification } from "./notifier.ts";
import type { OpenResult } from "./open.ts";
import type { UiAuth } from "./ui-auth.ts";
import type { ViewerAccess } from "./viewer.ts";
import { createStreams, decodeSegment, readBody, send, sendBodyError, serveUiFile, sseEvent } from "./http.ts";
import type { UsageCollector } from "./usage.ts";
import type { Board } from "./board.ts";
import type { Schedule } from "./schedule.ts";
import type { ControlName, ControlReply, ControlsState } from "./controls.ts";

const EVENTS_MAX = 100;
const AGENT = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ApiDeps = {
  token: string;
  ingestor: Ingestor;
  usage: UsageCollector;
  /** The office board's record of a local calendar year (null: the current one). */
  board: (year: number | null) => Board;
  attention: () => Attention;
  /** The scheduled tasks as last read from the agents' schedulers. */
  schedule: () => Schedule;
  health: () => object;
  log: (line: string) => void;
  ui: UiAuth;
  /** The folder of the built browser UI. */
  uiRoot: string;
  /** Opens a session ("unknown": no such session; "busy": an open of it is still running). */
  openSession: (id: string) => Promise<OpenResult | "unknown" | "busy">;
  /** The viewer listener's pairing and devices; null when the daemon runs without one. */
  viewer: { url: string; access: ViewerAccess } | null;
  notes: Notes;
  /** The owner's settings the screens need, sent when a stream opens. */
  settings: SceneSettings;
  /** What the screens should warn about, looked up fresh when a stream opens (hooks that do not reach the daemon). */
  warnings: () => Warnings;
  /** Called after a note changed (publishes the notes to every stream). */
  notesChanged: () => void;
  /** Lifecycle controls (controls.ts): the screens' view, a stop or restart, a start. */
  controls: { state: () => ControlsState; request: (session: string, control: "stop" | "restart", key: string, instance: unknown) => ControlReply; start: (agent: unknown, cwd: unknown, key: string) => ControlReply ; service: (agent: string, control: ControlName, key: string, instance: unknown) => ControlReply };
};
export type { Warnings };
export type Api = { server: Server; broadcast: (events: StandardEvent[]) => void; broadcastAttention: (list: Attention) => void; broadcastNotification: (notification: Notification) => void; broadcastNotes: (notes: Record<string, unknown>) => void; broadcastWarnings: (warnings: Warnings) => void; broadcastSchedule: (schedule: Schedule) => void; broadcastControls: (state: ControlsState) => void; shutdown: () => Promise<void> };

const digest = (value: string) => createHash("sha256").update(value).digest();

/** A control's answer: the request (202 new, 200 the same key again) or a fixed error code. */
function sendControl(res: ServerResponse, reply: ControlReply): void {
  if ("request" in reply) return send(res, reply.status, { request: reply.request });
  send(res, reply.status, { error: reply.error });
}

export function createApi(deps: ApiDeps): Api {
  const tokenDigest = digest(deps.token);
  const streams = createStreams<null>();
  // A request must arrive within 5 s; the timeout checker runs every second (Node's default is 30 s).
  const server: Server = createHttpServer({ requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 1000 });

  const port = () => (server.address() as AddressInfo).port;
  const ownHosts = () => [`127.0.0.1:${port()}`, `localhost:${port()}`];
  /** Who presents this bearer token: the owner (the token file), the browser UI, or nobody. */
  const caller = (header: string | undefined): "owner" | "ui" | null => {
    const match = /^Bearer (\S+)$/.exec(header ?? "");
    if (match === null) return null;
    if (timingSafeEqual(digest(match[1]!), tokenDigest)) return "owner";
    return deps.ui.check(match[1]!) ? "ui" : null;
  };


  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!ownHosts().includes(host)) return send(res, 403, { error: "host_not_allowed" });
    const origin = req.headers.origin;
    if (origin !== undefined && !ownHosts().map((h) => `http://${h}`).includes(origin.toLowerCase())) return send(res, 403, { error: "origin_not_allowed" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/v1/health") {
      if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      // A hook proves it is talking to this daemon before it sends the token (hook-envelope.ts).
      const challenge = url.searchParams.get("challenge");
      // The port is part of the proof, so a listener on another (stale) port cannot pass our proof off as its own.
      const proof = challenge !== null && CHALLENGE_PATTERN.test(challenge) ? createHmac("sha256", deps.token).update(`${DAEMON_PROOF_PREFIX}${port()}\n${challenge}`).digest("hex") : undefined;
      return send(res, 200, proof === undefined ? deps.health() : { ...deps.health(), proof });
    }
    if (path === "/v1/ui/session") {
      // A page trades the one-time launch code from its URL fragment for a UI token.
      if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      const body = await readBody(req);
      if ("status" in body) return sendBodyError(res, body);
      const code = body.value !== null && typeof body.value === "object" ? (body.value as { code?: unknown }).code : undefined;
      const uiToken = deps.ui.redeem(code);
      return uiToken === null ? send(res, 401, { error: "launch_code_invalid" }) : send(res, 201, { token: uiToken });
    }
    if (!path.startsWith("/v1/")) return serveUiFile(res, deps.uiRoot, path, method);
    const who = caller(req.headers.authorization);
    if (who === null) return send(res, 401, { error: "unauthorized" });
    if (path === "/v1/ui/launch") {
      // Only a program that read the token file may start a UI session.
      if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      if (who !== "owner") return send(res, 403, { error: "forbidden" });
      const launch = deps.ui.launch();
      return send(res, 201, { code: launch.code, expires_in_s: launch.expiresInS });
    }

    if (path.startsWith("/v1/viewer/")) {
      // Pairing devices and revoking them is the owner's alone (the CLI and the app read the token file).
      if (who !== "owner") return send(res, 403, { error: "forbidden" });
      if (deps.viewer === null) return send(res, 409, { error: "viewer_off" });
      const { access, url: viewerUrl } = deps.viewer;
      if (path === "/v1/viewer/pair-code") {
        if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
        const pair = access.pairCode();
        return send(res, 201, { code: pair.code, expires_in_s: pair.expiresInS, url: viewerUrl });
      }
      if (path === "/v1/viewer/devices") return method === "GET" ? send(res, 200, { devices: access.devices(), url: viewerUrl }) : send(res, 405, { error: "method_not_allowed" });
      const revoke = /^\/v1\/viewer\/devices\/([0-9a-f]{8})\/revoke$/.exec(path);
      if (revoke) {
        if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
        return access.revoke(revoke[1]!) ? send(res, 200, { ok: true }) : send(res, 404, { error: "not_found" });
      }
      return send(res, 404, { error: "not_found" });
    }

    const hookRoute = /^\/v1\/hook\/([^/]+)$/.exec(path);
    if (hookRoute) {
      if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      if (who !== "owner") return send(res, 403, { error: "forbidden" });
      if (!AGENT.test(hookRoute[1]!)) return send(res, 404, { error: "not_found" });
      const body = await readBody(req);
      if ("status" in body) return sendBodyError(res, body);
      const prepared = deps.ingestor.prepareEnvelope(hookRoute[1]!, body.value);
      if ("code" in prepared) return send(res, 400, { error: prepared.code });
      // 503 when the database write failed: the hook spools, and the duplicate is recognised later.
      return deps.ingestor.apply([prepared]) ? send(res, 202, { ok: true }) : send(res, 503, { error: "store_unavailable" });
    }
    if (path === "/v1/events") {
      if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      if (who !== "owner") return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if ("status" in body) return sendBodyError(res, body);
      const items = Array.isArray(body.value) ? body.value : [body.value];
      if (items.length === 0 || items.length > EVENTS_MAX) return send(res, 400, { error: "batch_size" });
      const prepared = items.map((item) => deps.ingestor.prepareEvent(item));
      if (!deps.ingestor.apply(prepared.filter((item): item is Prepared => !("code" in item)))) return send(res, 503, { error: "store_unavailable" });
      const results = prepared.map((item, index) => ("code" in item ? { index, ok: false, error: (item as Rejection).code } : { index, ok: true }));
      return send(res, 202, { results });
    }
    if (path === "/v1/notes") return method === "GET" ? send(res, 200, { notes: deps.notes.all() }) : send(res, 405, { error: "method_not_allowed" });
    const noteRoute = /^\/v1\/sessions\/([^/]+)\/note$/.exec(path);
    if (noteRoute) {
      // The owner's nickname, description and flags for a session, written from the computer only.
      if (method !== "PUT") return send(res, 405, { error: "method_not_allowed" });
      const segment = decodeSegment(noteRoute[1]!);
      if ("problem" in segment) return send(res, 404, { error: "not_found" });
      const id = segment.value;
      if (!Object.hasOwn(deps.ingestor.snapshots(), id)) return send(res, 404, { error: "not_found" });
      const body = await readBody(req);
      if ("status" in body) return sendBodyError(res, body);
      const note = parseNote(body.value);
      if (note === null) return send(res, 400, { error: "invalid_note" });
      deps.notes.set(id, note);
      deps.notesChanged();
      return send(res, 200, { note: deps.notes.get(id) ?? null });
    }
    const dismissRoute = /^\/v1\/sessions\/([^/]+)\/dismiss$/.exec(path);
    if (dismissRoute) {
      // The owner sends a session home: the office lets it go until it signals again (the agent is not touched).
      if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      const segment = decodeSegment(dismissRoute[1]!);
      if ("problem" in segment) return send(res, 404, { error: "not_found" });
      const id = segment.value;
      const result = deps.ingestor.dismiss(id);
      if (result === "unknown") return send(res, 404, { error: "not_found" });
      if (result === "refused") return send(res, 409, { error: "not_dismissible" });
      return result === "stored" ? send(res, 200, { ok: true }) : send(res, 503, { error: "store_unavailable" });
    }
    const controlRoute = /^\/v1\/sessions\/([^/]+)\/controls\/([^/]+)$/.exec(path);
    if (controlRoute) {
      // Stop or restart a session's agent process (the agent is asked to end by one signal; no answer, no prompt).
      if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      const segment = decodeSegment(controlRoute[1]!);
      if ("problem" in segment) return send(res, 404, { error: "not_found" });
      const control = controlRoute[2]!;
      if ((control !== "stop" && control !== "restart") || !Object.hasOwn(deps.ingestor.snapshots(), segment.value)) return send(res, 404, { error: "not_found" });
      const body = await readBody(req);
      if ("status" in body) return sendBodyError(res, body);
      const instance = body.value !== null && typeof body.value === "object" ? (body.value as { instance?: unknown }).instance : undefined;
      return sendControl(res, deps.controls.request(segment.value, control, String(req.headers["idempotency-key"] ?? ""), instance));
    }
    const serviceRoute = /^\/v1\/services\/([^/]+)\/controls\/([^/]+)$/.exec(path);
    if (serviceRoute) {
      // Start, stop or restart a background service with its own command.
      if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      const segment = decodeSegment(serviceRoute[1]!);
      if ("problem" in segment) return send(res, 404, { error: "not_found" });
      const control = serviceRoute[2]!;
      if (control !== "start" && control !== "stop" && control !== "restart") return send(res, 404, { error: "not_found" });
      const body = await readBody(req);
      if ("status" in body) return sendBodyError(res, body);
      const instance = body.value !== null && typeof body.value === "object" ? (body.value as { instance?: unknown }).instance : undefined;
      return sendControl(res, deps.controls.service(segment.value, control, String(req.headers["idempotency-key"] ?? ""), instance));
    }
    if (path === "/v1/controls/start") {
      if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      const body = await readBody(req);
      if ("status" in body) return sendBodyError(res, body);
      const value = body.value !== null && typeof body.value === "object" ? (body.value as { agent?: unknown; cwd?: unknown }) : {};
      return sendControl(res, deps.controls.start(value.agent, value.cwd, String(req.headers["idempotency-key"] ?? "")));
    }
    if (path === "/v1/controls") return method === "GET" ? send(res, 200, deps.controls.state()) : send(res, 405, { error: "method_not_allowed" });
    const openRoute = /^\/v1\/sessions\/([^/]+)\/open$/.exec(path);
    if (openRoute) {
      // The UI's one action: bring the session's window forward or open it again (never an answer to the agent).
      if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      const segment = decodeSegment(openRoute[1]!);
      if ("problem" in segment) return send(res, 404, { error: "not_found" });
      const id = segment.value;
      const result = await deps.openSession(id);
      if (result === "unknown") return send(res, 404, { error: "not_found" });
      if (result === "busy") return send(res, 409, { error: "busy" });
      return send(res, 200, result);
    }
    if (path === "/v1/usage") {
      if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      const days = Number(url.searchParams.get("days") ?? "7");
      if (!Number.isInteger(days) || days < 1 || days > 400) return send(res, 400, { error: "days" });
      return send(res, 200, deps.usage.usage(days));
    }
    if (path === "/v1/board") {
      if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      const raw = url.searchParams.get("year");
      if (raw !== null && !/^\d{4}$/.test(raw)) return send(res, 400, { error: "year" });
      return send(res, 200, deps.board(raw === null ? null : Number(raw)));
    }
    if (path === "/v1/limits") {
      if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      return send(res, 200, deps.usage.limits());
    }
    if (path === "/v1/sessions") {
      if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      return send(res, 200, { sessions: deps.ingestor.sessions() });
    }
    if (path === "/v1/attention") {
      if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      return send(res, 200, deps.attention());
    }
    if (path === "/v1/schedule") {
      if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      return send(res, 200, deps.schedule());
    }
    if (path === "/v1/stream") {
      if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      return streams.open(req, res, null, sseEvent("sessions", deps.ingestor.sessions()) + sseEvent("attention", deps.attention()) + sseEvent("schedule", deps.schedule()) + sseEvent("notes", deps.notes.all()) + sseEvent("settings", deps.settings) + sseEvent("warnings", deps.warnings()) + sseEvent("controls", deps.controls.state()));
    }
    return send(res, 404, { error: "not_found" });
  }

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: unknown) => {
      deps.log(`request_failed ${(error as Error).name}`);
      if (!res.headersSent) send(res, 500, { error: "internal" });
      else res.destroy();
    });
    res.on("finish", () => {
      if (res.getHeader("connection") === "close") req.socket.destroy();
    });
  });

  return {
    server,
    broadcast(events) {
      for (const event of events) streams.send(sseEvent("session", event));
    },
    broadcastAttention(list) {
      streams.send(sseEvent("attention", list));
    },
    broadcastNotification(notification) {
      streams.send(sseEvent("notification", notification));
    },
    broadcastNotes(notes) {
      streams.send(sseEvent("notes", notes));
    },
    broadcastWarnings(warnings) {
      streams.send(sseEvent("warnings", warnings));
    },
    broadcastSchedule(schedule) {
      streams.send(sseEvent("schedule", schedule));
    },
    broadcastControls(state) {
      streams.send(sseEvent("controls", state));
    },
    /** Stops listening and ends every connection, including streams and half-sent requests. */
    shutdown() {
      streams.close();
      streams.stop();
      const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      server.closeAllConnections();
      return closed;
    },
  };
}
