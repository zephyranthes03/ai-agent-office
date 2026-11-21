// The hook program: stdin → envelope → POST to the local daemon, or the spool when that fails.
// Budget: 1000 ms to verify the daemon and POST (500 ms after SessionEnd/Interrupt, which are
// spooled first), and everything given up 1800 ms after the process started, before the 2 s hard
// limit of the bin shim, however long this module took to load.
// Only the envelope leaves this process, and only to a listener that proved it knows the token.
// Errors are logged by code, never with input.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DETAIL_LEVELS } from "@agent-office/core/detail";
import { buildEnvelope, FINAL_EVENTS } from "@agent-office/core/hook-envelope";
import type { DetailLevel, HookEnvelope } from "@agent-office/core/hook-envelope";
import { appendCapped, deliverFresh, ensureDir, findDaemon, officeHome, spoolLine } from "./transport.ts";

const STARTED_AT = new Date().toISOString();
const STDIN_MAX = 16 * 1024 * 1024;
const STDIN_IDLE_MS = 50;
const LOG_MAX = 1024 * 1024;
const POST_MS = 1000;
const FINAL_POST_MS = 500;
const GIVE_UP_MS = 1800;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LEVELS = new Set<string>(DETAIL_LEVELS);

function log(home: string, code: string): void {
  const dir = join(home, "logs");
  ensureDir(dir);
  appendCapped(join(dir, "hook.log"), `${new Date().toISOString()} ${code}\n`, LOG_MAX);
}

/**
 * `privacy.detail_level`. No config file or no setting: `target`, the default. A file that cannot
 * be read as JSON, or a value that is not one of the levels: `tool`, so a broken setting
 * never shows more than the user may have chosen.
 */
export function readDetailLevel(home: string): DetailLevel {
  let text: string;
  try {
    text = readFileSync(join(home, "config.json"), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "target" : "tool";
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return "tool";
    throw error;
  }
  const level = (config as { privacy?: { detail_level?: unknown } } | null)?.privacy?.detail_level;
  if (level === undefined) return "target";
  return typeof level === "string" && LEVELS.has(level) ? (level as DetailLevel) : "tool";
}

/**
 * Reads stdin without blocking the event loop. Resolves with the parsed object at the end of
 * input, or, if the agent keeps the pipe open, once no data has come for a short while and the
 * bytes so far form JSON. Invalid JSON and input past the size cap resolve with a problem code.
 */
function readStdin(): Promise<{ value: unknown } | { problem: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let idle: NodeJS.Timeout | null = null;
    const finish = (result: { value: unknown } | { problem: string }) => {
      if (done) return;
      done = true;
      if (idle) clearTimeout(idle);
      process.stdin.pause();
      resolve(result);
    };
    const tryParse = (final: boolean) => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!final && !text.trimEnd().endsWith("}")) return;
      try {
        finish({ value: JSON.parse(text) });
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // The parser's message quotes the input, so only the error type is kept.
        if (final) finish({ problem: "stdin_invalid_json" });
      }
    };
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDIN_MAX) return finish({ problem: "stdin_too_large" });
      chunks.push(chunk);
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => tryParse(false), STDIN_IDLE_MS);
      idle.unref();
    });
    process.stdin.on("end", () => tryParse(true));
    process.stdin.on("error", (error: NodeJS.ErrnoException) => finish({ problem: `stdin_${error.code ?? "error"}` }));
  });
}

function spool(home: string, envelope: HookEnvelope): void {
  spoolLine(home, envelope.agent, envelope);
}

/** One hook call. Never throws for expected failures; the bin shim turns anything else into exit 0. */
export async function runHook(agent: string | undefined): Promise<void> {
  const home = officeHome();
  // `events` is the spool name of `agent-office emit`, never an agent's.
  if (agent === undefined || !AGENT_ID.test(agent) || agent === "events") return log(home, "agent_invalid");
  let envelope: HookEnvelope | null = null;
  let spooled = false;
  // Counted from the process's start (performance.now()), like the shim's watchdog, which spools nothing.
  const giveUp = setTimeout(() => {
    if (envelope && !spooled) {
      spool(home, envelope);
      spooled = true;
    }
    log(home, "gave_up");
    process.exit(0);
  }, Math.max(0, GIVE_UP_MS - performance.now()));
  giveUp.unref();

  const input = await readStdin();
  if ("problem" in input) return log(home, input.problem);
  envelope = buildEnvelope({
    stdin: input.value,
    agent,
    env: process.env,
    proc: { ppid: process.ppid, pid: process.pid, uid: typeof process.getuid === "function" ? process.getuid() : null, platform: process.platform },
    detailLevel: readDetailLevel(home),
    hookId: randomUUID(),
    observedAt: STARTED_AT,
  });
  if (envelope === null) return log(home, "event_unusable");

  const final = FINAL_EVENTS.has(envelope.event.hook_event_name);
  if (final) {
    try {
      spool(home, envelope);
      spooled = true;
    } catch (error) {
      // Still try to deliver it: a full disk must not cost the event when the daemon is up.
      log(home, `prespool_failed ${(error as NodeJS.ErrnoException).code ?? (error as Error).name}`);
    }
  }
  const daemon = findDaemon(home);
  if ("problem" in daemon) {
    if (!spooled) spool(home, envelope);
    spooled = true;
    return daemon.problem === "daemon_down" ? undefined : log(home, daemon.problem);
  }
  const body = JSON.stringify(envelope);
  const deadline = Date.now() + (final ? FINAL_POST_MS : POST_MS);
  const result = await deliverFresh(home, daemon, `/v1/hook/${agent}`, body, deadline);
  if ("status" in result && result.status === 202) return;
  if ("status" in result && [400, 401, 413].includes(result.status)) return log(home, `rejected ${result.status}`);
  if (!spooled) spool(home, envelope);
  spooled = true;
  log(home, "problem" in result ? result.problem : `status ${result.status}`);
}
