// The read-only viewer listener of server mode (docs/events.md, "Viewer listener"): phones, tablets
// and desk screens on the user's own network watch the office here. It is off unless an address is
// given on the command line, binds only to loopback or private addresses, accepts no write of the
// main API, and needs a per-device token on every route except pairing and the UI's files. A name a
// proxy on this machine serves it under over HTTPS (`tailscale serve`, `--viewer-host`) is accepted
// beside the address; the only things a device can write are its pairing and its own web push
// subscription. Devices
// pair once with a short-lived code the owner shows (`agent-office pair`); only token digests are
// stored, and revoking a device ends its open streams. What it may see follows
// `remote_view.detail`; the working folder is never sent.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isIPv4, isIPv6 } from "node:net";
import type { StandardEvent } from "@agent-office/core";
import type { Attention } from "./attention.ts";
import type { SceneSettings } from "./config.ts";
import type { Notes } from "./notes.ts";
import type { Notification } from "./notifier.ts";
import { checkSubscription } from "./push.ts";
import { createStreams, decodeSegment, readBody, send, sendBodyError, serveUiFile, sseEvent } from "./http.ts";
import type { Store } from "./store.ts";

export const VIEWER_DEFAULT_PORT = 47650;
export type ViewerDetail = "status" | "targets" | "full";
/** `plain`: a LAN address, where traffic is not encrypted (a warning, not a refusal). */
export type ViewerAddress = { host: string; port: number; plain: boolean };

const ipv4 = (host: string) => host.split(".").map(Number) as [number, number, number, number];

/** Where a viewer may listen: loopback and private ranges only, never a wildcard or public address. */
export function parseViewerAddress(text: string): ViewerAddress | { problem: string } {
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  const v4 = /^([\d.]+)(?::(\d{1,5}))?$/.exec(text);
  const [host, portText] = bracketed ? [bracketed[1]!, bracketed[2]] : v4 ? [v4[1]!, v4[2]] : isIPv6(text) ? [text, undefined] : [null, undefined];
  if (host === null || (!isIPv4(host) && !isIPv6(host))) return { problem: "not an IP address (use a numeric address, [v6]:port for IPv6)" };
  const port = portText === undefined ? VIEWER_DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { problem: "port out of range" };
  if (isIPv4(host)) {
    const [a, b] = ipv4(host);
    if (a === 127) return { host, port, plain: false };
    if (a === 100 && b >= 64 && b <= 127) return { host, port, plain: false };
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return { host, port, plain: true };
    return { problem: a === 0 ? "a wildcard address would listen on every network" : "not a loopback or private address" };
  }
  const lower = host.toLowerCase();
  if (lower === "::1") return { host: lower, port, plain: false };
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return { host: lower, port, plain: true };
  return { problem: lower === "::" ? "a wildcard address would listen on every network" : "not a loopback or private address" };
}

/** A DNS name for `--viewer-host` (lower case), else null. */
export function parseViewerHost(text: string): string | null {
  const name = text.toLowerCase();
  return name.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(name) ? name : null;
}

/** The address as the `Host` header names it. */
export const hostHeader = (address: ViewerAddress) => `${isIPv6(address.host) ? `[${address.host}]` : address.host}:${address.port}`;

// No 0/O, 1/I/L: a code is read off one screen and typed on another.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_TTL_MS = 5 * 60_000;
const CODES_MAX = 3;
const FAILURES_MAX = 5;
const LOCK_MS = 30_000;
const ADDRESSES_MAX = 256;
/** A device unused this long is forgotten (a token left on a lost or reused browser stops working). */
export const DEVICE_IDLE_MS = 30 * 24 * 3600_000;
const NAME_MAX = 40;
const TOUCH_EVERY_MS = 60_000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export type DeviceListing = { id: string; name: string; created_at: string; last_seen_at: string | null };

/**
 * Pairing codes (in memory, single use, five minutes, at most three waiting) and the paired devices
 * (in the database, token digests only; forgotten after 30 days unused). Five wrong codes from one
 * network address lock that address out for 30 s: guessing stays hopeless (31^8 codes), and nobody
 * on the network can keep the owner's own code from working by failing on purpose.
 */
export class ViewerAccess {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly revoked: (id: string) => void;
  private readonly codes = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();
  private readonly byDigest = new Map<string, string>();
  private readonly touched = new Map<string, number>();
  private readonly seen = new Map<string, number>();

  constructor(store: Store, now: () => number, revoked: (id: string) => void) {
    this.store = store;
    this.now = now;
    this.revoked = revoked;
    for (const device of store.viewerDevices()) {
      this.byDigest.set(device.token_sha256, device.id);
      this.seen.set(device.id, Date.parse(device.last_seen_at ?? device.created_at));
    }
  }

  pairCode(): { code: string; expiresInS: number } {
    this.sweep();
    while (this.codes.size >= CODES_MAX) this.codes.delete(this.codes.keys().next().value!);
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    this.codes.set(code, this.now() + CODE_TTL_MS);
    return { code, expiresInS: CODE_TTL_MS / 1000 };
  }

  /** A device token for a valid code (spaces, hyphens and case ignored); null for a wrong one; "locked" while `from` is locked out. */
  pair(code: unknown, name: unknown, from: string): { token: string; device: DeviceListing } | null | "locked" {
    this.sweep();
    const now = this.now();
    const record = this.failures.get(from);
    if (record !== undefined && record.lockedUntil > now) return "locked";
    const typed = typeof code === "string" ? code.replace(/[\s-]/g, "").toUpperCase() : "";
    if (!this.codes.has(typed)) {
      const count = (record?.count ?? 0) + 1;
      if (!this.failures.has(from) && this.failures.size >= ADDRESSES_MAX) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(from, count >= FAILURES_MAX ? { count: 0, lockedUntil: now + LOCK_MS } : { count, lockedUntil: 0 });
      return null;
    }
    this.codes.delete(typed);
    this.failures.delete(from);
    const token = randomBytes(32).toString("hex");
    const created = new Date(this.now()).toISOString();
    const label = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, NAME_MAX) : "";
    const device = { id: randomBytes(4).toString("hex"), name: label === "" ? "기기" : label, created_at: created, last_seen_at: null };
    this.store.addViewerDevice({ id: device.id, name: device.name, token_sha256: sha256(token), created_at: created });
    this.byDigest.set(sha256(token), device.id);
    this.seen.set(device.id, now);
    return { token, device };
  }

  /** The device this bearer header belongs to, else null. */
  check(header: string | undefined): string | null {
    const match = /^Bearer ([0-9a-f]{64})$/.exec(header ?? "");
    const id = match === null ? undefined : this.byDigest.get(sha256(match[1]!));
    if (id === undefined) return null;
    const now = this.now();
    if (now - (this.seen.get(id) ?? now) > DEVICE_IDLE_MS) {
      this.revoke(id);
      return null;
    }
    this.seen.set(id, now);
    if (now - (this.touched.get(id) ?? 0) >= TOUCH_EVERY_MS) {
      this.touched.set(id, now);
      this.store.touchViewerDevice(id, new Date(now).toISOString());
    }
    return id;
  }

  devices(): DeviceListing[] {
    return this.store.viewerDevices().map(({ id, name, created_at, last_seen_at }) => ({ id, name, created_at, last_seen_at }));
  }

  /** Forgets the device and ends its streams; false when no such device exists. */
  revoke(id: string): boolean {
    if (!this.store.removeViewerDevice(id)) return false;
    for (const [digest, owner] of this.byDigest) if (owner === id) this.byDigest.delete(digest);
    this.touched.delete(id);
    this.seen.delete(id);
    this.revoked(id);
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, expires] of this.codes) if (expires <= now) this.codes.delete(code);
    for (const [address, record] of this.failures) if (record.count === 0 && record.lockedUntil <= now) this.failures.delete(address);
  }
}

/** A session as a viewer may see it: never the working folder; the wait's target from `targets`, the tool detail and the title at `full`. */
export function sessionForViewer(event: StandardEvent, level: ViewerDetail): StandardEvent {
  const { title, ...rest } = event;
  return {
    ...rest,
    ...(level === "full" && title !== undefined ? { title } : {}),
    cwd: null,
    detail: level === "full" ? event.detail : null,
    waiting_on: event.waiting_on === null ? null : { reason: event.waiting_on.reason, target: level === "status" ? null : event.waiting_on.target },
  };
}

export function notificationForViewer(notification: Notification, level: ViewerDetail): Notification {
  return { ...notification, target: level === "status" ? null : notification.target };
}

/** Routes of the main API that change something: the viewer answers 405, never 404, so it is clear they exist elsewhere. */
const MAIN_WRITES = [/^\/v1\/services\/[^/]+\/controls\/[^/]+$/, /^\/v1\/hook\/[^/]+$/, /^\/v1\/events$/, /^\/v1\/ui\/(launch|session)$/, /^\/v1\/sessions\/[^/]+\/(open|note|dismiss)$/, /^\/v1\/sessions\/[^/]+\/controls\/[^/]+$/, /^\/v1\/controls(\/start)?$/, /^\/v1\/viewer\//];

export type ViewerDeps = {
  address: ViewerAddress;
  /** A name the viewer is served under over HTTPS by a proxy on this machine (`--viewer-host`), or null. */
  hostName: string | null;
  level: ViewerDetail;
  uiRoot: string;
  access: ViewerAccess;
  sessions: () => StandardEvent[];
  attention: () => Attention;
  /** What the owner can run on the computer to continue a session (no folder), or "unknown". */
  resume: (id: string) => string | null | "unknown";
  /** This machine's name, shown so a phone says which computer to go to. */
  machine: string;
  version: string;
  log: (line: string) => void;
  notes: Notes;
  settings: SceneSettings;
  /** Web push: the key devices subscribe with, and their subscriptions (stored per device). */
  push: { publicKey: () => string; subscribed: (device: string) => boolean; put: (device: string, target: { endpoint: string; p256dh: string; auth: string }) => void; remove: (device: string) => void };
};

export function createViewerApi(deps: ViewerDeps) {
  const streams = createStreams<string>();
  const server: Server = createHttpServer({ requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 1000, keepAliveTimeout: 5000 });
  // A flood of connections from the network must not use up the descriptors the daemon needs for its
  // database and the main API.
  server.maxConnections = 64;
  const own = hostHeader(deps.address).toLowerCase();
  const hosts = new Set([own, ...(deps.hostName === null ? [] : [deps.hostName, `${deps.hostName}:443`])]);
  const origins = new Set([`http://${own}`, ...(deps.hostName === null ? [] : [`https://${deps.hostName}`])]);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has((req.headers.host ?? "").toLowerCase())) return send(res, 403, { error: "host_not_allowed" });
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin.toLowerCase())) return send(res, 403, { error: "origin_not_allowed" });
    const url = new URL(req.url ?? "/", "http://viewer");
    const path = url.pathname;
    const method = req.method ?? "GET";
    // Tells the page it is the viewer (pair with a code, no actions); nothing secret.
    if (path === "/mode.json") return method === "GET" ? send(res, 200, { mode: "viewer" }) : send(res, 405, { error: "method_not_allowed" });
    if (!path.startsWith("/v1/")) return serveUiFile(res, deps.uiRoot, path, method);
    if (path === "/v1/pair") {
      if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      const body = await readBody(req);
      if ("status" in body) return sendBodyError(res, body);
      const value = body.value !== null && typeof body.value === "object" ? (body.value as { code?: unknown; name?: unknown }) : {};
      const paired = deps.access.pair(value.code, value.name, req.socket.remoteAddress ?? "unknown");
      if (paired === "locked") return send(res, 429, { error: "too_many_tries" }, { "retry-after": "30" });
      return paired === null ? send(res, 401, { error: "pair_code_invalid" }) : send(res, 201, paired);
    }
    if (MAIN_WRITES.some((route) => route.test(path))) return send(res, 405, { error: "method_not_allowed" });
    const device = deps.access.check(req.headers.authorization);
    if (device === null) return send(res, 401, { error: "unauthorized" });
    if (path === "/v1/push") {
      if (method === "GET") return send(res, 200, { key: deps.push.publicKey(), subscribed: deps.push.subscribed(device) });
      if (method === "DELETE") {
        deps.push.remove(device);
        return send(res, 200, { subscribed: false });
      }
      if (method !== "PUT") return send(res, 405, { error: "method_not_allowed" });
      const body = await readBody(req);
      if ("status" in body) return sendBodyError(res, body);
      const target = checkSubscription(body.value);
      if ("problem" in target) return send(res, 400, { error: `subscription_${target.problem}` });
      deps.push.put(device, target);
      return send(res, 200, { subscribed: true });
    }
    if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
    if (path === "/v1/health") return send(res, 200, { version: deps.version, machine: deps.machine, detail: deps.level });
    if (path === "/v1/sessions") return send(res, 200, { sessions: deps.sessions().map((event) => sessionForViewer(event, deps.level)) });
    if (path === "/v1/attention") return send(res, 200, deps.attention());
    if (path === "/v1/notes") return send(res, 200, { notes: deps.notes.forViewer(deps.level === "full") });
    const resume = /^\/v1\/sessions\/([^/]+)\/resume$/.exec(path);
    if (resume) {
      const segment = decodeSegment(resume[1]!);
      if ("problem" in segment) return send(res, 404, { error: "not_found" });
      const id = segment.value;
      const command = deps.resume(id);
      return command === "unknown" ? send(res, 404, { error: "not_found" }) : send(res, 200, { command });
    }
    if (path === "/v1/stream") {
      const sessions = deps.sessions().map((event) => sessionForViewer(event, deps.level));
      // One device cannot take every stream slot from the others.
      return streams.open(req, res, device, sseEvent("sessions", sessions) + sseEvent("attention", deps.attention()) + sseEvent("notes", deps.notes.forViewer(deps.level === "full")) + sseEvent("settings", deps.settings), 4);
    }
    return send(res, 404, { error: "not_found" });
  }

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: unknown) => {
      deps.log(`viewer_request_failed ${(error as Error).name}`);
      if (!res.headersSent) send(res, 500, { error: "internal" });
      else res.destroy();
    });
  });

  return {
    server,
    broadcast(events: StandardEvent[]): void {
      for (const event of events) streams.send(sseEvent("session", sessionForViewer(event, deps.level)));
    },
    broadcastAttention(list: Attention): void {
      streams.send(sseEvent("attention", list));
    },
    broadcastNotification(notification: Notification): void {
      streams.send(sseEvent("notification", notificationForViewer(notification, deps.level)));
    },
    broadcastNotes(): void {
      streams.send(sseEvent("notes", deps.notes.forViewer(deps.level === "full")));
    },
    /** Ends a revoked device's streams. */
    drop(device: string): void {
      streams.close((tag) => tag === device);
    },
    shutdown(): Promise<void> {
      streams.close();
      streams.stop();
      if (!server.listening) return Promise.resolve();
      const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      server.closeAllConnections();
      return closed;
    },
  };
}
