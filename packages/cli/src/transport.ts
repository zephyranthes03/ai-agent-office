// How the hook program and `agent-office emit` reach the local daemon: find it through daemon.json,
// make the listener prove it holds the token before anything is sent, POST, and fall back to the
// spool folder, which the daemon drains on start and every 30 s. Node built-ins and core's
// hook-envelope only, because the hook loads this on every agent event.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_PROOF_PREFIX } from "@agent-office/core/hook-envelope";

const SPOOL_MAX = 5 * 1024 * 1024;

export function officeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["AGENT_OFFICE_HOME"] || join(homedir(), ".agent-office");
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Appends one line, moving the file to `<file>.1` first once it has reached `max` bytes. */
export function appendCapped(file: string, line: string, max: number): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (size >= max) {
    try {
      renameSync(file, `${file}.1`);
    } catch (error) {
      // Another writer rotated the same file a moment ago; append to the fresh one.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  appendFileSync(file, line, { mode: 0o600 });
}

/** One JSON line in `spool/<name>.jsonl`: hook envelopes under their agent's name, emitted events under `events`. */
export function spoolLine(home: string, name: string, value: unknown): void {
  const dir = join(home, "spool");
  ensureDir(dir);
  appendCapped(join(dir, `${name}.jsonl`), `${JSON.stringify(value)}\n`, SPOOL_MAX);
}

export type Daemon = { port: number; token: string };

/** The daemon named by `daemon.json`, if that process is alive and the token file exists. */
export function findDaemon(home: string): Daemon | { problem: string } {
  let info: { port?: unknown; pid?: unknown };
  let token: string;
  try {
    info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as typeof info;
    token = readFileSync(join(home, "token"), "utf8").trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { problem: code === "ENOENT" ? "daemon_down" : `daemon_unreadable ${error instanceof SyntaxError ? "SyntaxError" : (code ?? "Error")}` };
  }
  if (typeof info.port !== "number" || typeof info.pid !== "number" || token === "") return { problem: "daemon_info_invalid" };
  try {
    // Signal 0 only checks that the process exists; the proof below checks that it is the daemon.
    process.kill(info.pid, 0);
  } catch (error) {
    return { problem: `daemon_gone ${(error as NodeJS.ErrnoException).code ?? "Error"}` };
  }
  return { port: info.port, token };
}

export type Reply = { status: number; body: string } | { problem: string };

/** The hook's replies are a few bytes; a diagnostic read (the sessions list) can be larger. */
const REPLY_MAX = 4096;
const QUERY_REPLY_MAX = 1024 * 1024;

function send(port: number, method: "GET" | "POST", path: string, headers: Record<string, string | number>, body: string | null, deadline: number, maxReply = REPLY_MAX): Promise<Reply> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false });
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ problem: "post_timeout" });
    }, Math.max(0, deadline - Date.now()));
    req.on("response", (res) => {
      const parts: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= maxReply) {
          parts.push(chunk);
          return;
        }
        // Never a cut reply: a caller would read half a JSON document as the whole answer.
        clearTimeout(timer);
        req.destroy();
        resolve({ problem: "reply_too_large" });
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8") });
      });
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ problem: `post_${error.code ?? "error"}` });
    });
    req.end(body ?? undefined);
  });
}

/** Asks the listener to prove it holds the token, so neither the token nor metadata reaches an impostor. */
async function verifyDaemon(daemon: Daemon, deadline: number): Promise<true | { problem: string }> {
  const challenge = randomBytes(16).toString("hex");
  const reply = await send(daemon.port, "GET", `/v1/health?challenge=${challenge}`, {}, null, deadline);
  if ("problem" in reply) return reply;
  let proof: unknown;
  try {
    proof = (JSON.parse(reply.body) as { proof?: unknown }).proof;
  } catch (error) {
    if (error instanceof SyntaxError) return { problem: "daemon_unverified" };
    throw error;
  }
  const expected = createHmac("sha256", daemon.token).update(`${DAEMON_PROOF_PREFIX}${daemon.port}\n${challenge}`).digest();
  const given = typeof proof === "string" && /^[0-9a-f]{64}$/.test(proof) ? Buffer.from(proof, "hex") : null;
  return given !== null && timingSafeEqual(given, expected) ? true : { problem: "daemon_unverified" };
}

/** POSTs `body` to `path` (under /v1) after the daemon proved itself, within `deadline`. */
export async function deliver(daemon: Daemon, path: string, body: string, deadline: number): Promise<Reply> {
  const verified = await verifyDaemon(daemon, deadline);
  if (verified !== true) return verified;
  const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${daemon.token}` };
  return send(daemon.port, "POST", path, headers, body, deadline);
}

/**
 * `deliver`, and once more with the token read again when the daemon answers 401: it may have
 * written a new token since `daemon` was read.
 */
export async function deliverFresh(home: string, daemon: Daemon, path: string, body: string, deadline: number): Promise<Reply> {
  const result = await deliver(daemon, path, body, deadline);
  if (!("status" in result) || result.status !== 401) return result;
  const again = findDaemon(home);
  return "problem" in again ? result : deliver(again, path, body, deadline);
}

/** GETs `path` with the token after the daemon proved itself (diagnostics; the hook never reads). */
export async function query(daemon: Daemon, path: string, deadline: number): Promise<Reply> {
  const verified = await verifyDaemon(daemon, deadline);
  if (verified !== true) return verified;
  return send(daemon.port, "GET", path, { authorization: `Bearer ${daemon.token}` }, null, deadline, QUERY_REPLY_MAX);
}
