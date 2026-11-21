// The envelope the hook sends to the daemon: an allowlist of hook input fields, a short `detail`,
// the hook's process ids and its own terminal identity. Pure: the caller passes the parsed stdin,
// its own environment, the process facts, the id and the time. Everything not listed here is
// dropped inside the hook process, so prompts, tool inputs and outputs never reach the daemon.
import { clipDetail, DELEGATION_TOOLS, deriveDetail } from "./detail.ts";
import type { DetailLevel } from "./detail.ts";

export type { DetailLevel } from "./detail.ts";

export type EnvelopeEvent = {
  hook_event_name: string;
  session_id: string;
  cwd: string | null;
  transcript_path: string | null;
  permission_mode: string | null;
  prompt_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  notification_type: string | null;
  source: string | null;
  reason: string | null;
  turn_id: string | null;
  model: string | null;
  detail: string | null;
  /** For a tool the adapter declares as a `delegation` (it hands work to another session): the tool input's `target` and `initiation` enums, nothing else of the input. */
  tool_meta: { target: string | null; initiation: string | null } | null;
  /** On `Stop` and `SubagentStop`: how many entries of the input's `background_tasks` are the session's own work still running; nothing else of the list. Null when the input has no list. */
  background: number | null;
};

export type EnvelopeProcess = { ppid: number; hook_pid: number; uid: number | null; platform?: "darwin" | "linux" | "win32" };
export type EnvelopeTerminal = Partial<Record<(typeof TERMINAL_KEYS)[number], string>> & { ssh: boolean };

export type HookEnvelope = {
  schema_version: 1;
  hook_id: string;
  agent: string;
  observed_at: string;
  event: EnvelopeEvent;
  process: EnvelopeProcess;
  terminal: EnvelopeTerminal;
};

/** Forwarded field → maximum length (the hook-envelope schema). Longer values are dropped, not cut: a cut id or path is a wrong one. */
const COMMON_FIELDS = {
  hook_event_name: 64,
  session_id: 256,
  cwd: 1024,
  transcript_path: 1024,
  permission_mode: 32,
  prompt_id: 128,
  agent_id: 128,
  agent_type: 128,
  tool_name: 128,
  tool_use_id: 128,
  notification_type: 64,
  source: 32,
  reason: 32,
} as const;

/** Fields forwarded only for the agents that send them (as the public data-access page lists). */
const AGENT_FIELDS: Record<string, Partial<Record<"turn_id" | "model", number>>> = { codex: { turn_id: 128, model: 128 } };

/** The hook's own environment keys used for window focus, with their maximum lengths. Values of SSH_* are never sent. */
export const TERMINAL_KEYS = ["TERM_PROGRAM", "TMUX", "TMUX_PANE", "ITERM_SESSION_ID", "WEZTERM_PANE", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON", "WT_SESSION", "VSCODE_PID"] as const;
const TERMINAL_MAX: Record<(typeof TERMINAL_KEYS)[number], number> = {
  TERM_PROGRAM: 64,
  TMUX: 256,
  TMUX_PANE: 16,
  ITERM_SESSION_ID: 128,
  WEZTERM_PANE: 16,
  KITTY_WINDOW_ID: 16,
  KITTY_LISTEN_ON: 256,
  WT_SESSION: 128,
  VSCODE_PID: 16,
};

const PLATFORMS = new Set(["darwin", "linux", "win32"]);

/** A string within `max` characters, else null. */
function field(value: unknown, max: number): string | null {
  return typeof value === "string" && value !== "" && value.length <= max ? value : null;
}

export type EnvelopeInput = {
  /** The parsed hook stdin. */
  stdin: unknown;
  agent: string;
  /** The hook's own environment (pass `process.env` itself: on Windows its lookups ignore case). */
  env: Record<string, string | undefined>;
  proc: { ppid: number; pid: number; uid: number | null; platform: string };
  detailLevel: DetailLevel;
  hookId: string;
  observedAt: string;
};

/** The two enums of a delegation tool's input; each at most this long (they are words such as `cloud` or `user_asked`). */
const TOOL_META_MAX = 32;
function toolMetaOf(raw: Record<string, unknown>, tool: string | null): EnvelopeEvent["tool_meta"] {
  if (tool === null || !DELEGATION_TOOLS.has(tool)) return null;
  const input = raw["tool_input"];
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  return { target: field(record["target"], TOOL_META_MAX), initiation: field(record["initiation"], TOOL_META_MAX) };
}

/** Events whose input lists the session's background work (Claude Code's `Stop` and `SubagentStop`). */
const BACKGROUND_EVENTS = new Set(["Stop", "SubagentStop"]);
/**
 * Entries of `background_tasks` that are not work left running: a teammate stays listed as running for
 * the whole session even when idle, and the harness's own memory and auto-mode tasks are not the
 * session's. Claude Code sends its friendly label as `type` and the raw kind for others; both are listed.
 */
const NOT_BACKGROUND_WORK = new Set(["teammate", "in_process_teammate", "dream", "auto-mode scan", "auto_mode_scan", "memory import", "local_memory_import", "memory save", "post_turn_memory"]);
/** At most this many are counted; more says nothing more. */
const BACKGROUND_MAX = 99;
/** How many listed background tasks are work still running: each entry's `type` is read and nothing else (the list holds commands and descriptions). */
function backgroundOf(raw: Record<string, unknown>): number | null {
  const list = raw["background_tasks"];
  if (!Array.isArray(list)) return null;
  let count = 0;
  for (const entry of list) {
    const type = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)["type"] : undefined;
    if (typeof type === "string" && NOT_BACKGROUND_WORK.has(type)) continue;
    count += 1;
  }
  return Math.min(count, BACKGROUND_MAX);
}

/** Events whose `source` is forwarded: how a session started (pi's reporter sends pi's own event names). */
const SOURCE_EVENTS = new Set(["SessionStart", "session_start"]);
/** Events whose `reason` is forwarded: why a session ended, and pi's one-word outcome of a turn or a tool. */
const REASON_EVENTS = new Set(["SessionEnd", "session_shutdown", "agent_settled", "tool_execution_end"]);

/** The envelope for one hook call, or null when the input has no event name or usable session id. */
export function buildEnvelope(input: EnvelopeInput): HookEnvelope | null {
  const { stdin } = input;
  if (stdin === null || typeof stdin !== "object" || Array.isArray(stdin)) return null;
  const raw = stdin as Record<string, unknown>;
  const name = field(raw["hook_event_name"], COMMON_FIELDS.hook_event_name);
  const session = field(raw["session_id"], COMMON_FIELDS.session_id);
  if (name === null || session === null) return null;

  const extra = AGENT_FIELDS[input.agent] ?? {};
  const pick = (key: keyof typeof COMMON_FIELDS) => field(raw[key], COMMON_FIELDS[key]);
  const pickExtra = (key: "turn_id" | "model") => {
    const max = extra[key];
    return max === undefined ? null : field(raw[key], max);
  };
  const tool = pick("tool_name");
  const detail = input.detailLevel === "none" ? null : input.detailLevel === "tool" ? clipDetail(tool) : deriveDetail(raw, { description: input.detailLevel === "description" });
  // `source` belongs to a session's start and `reason` to the events below; on other events they are not forwarded.
  const source = SOURCE_EVENTS.has(name) ? pick("source") : null;
  const reason = REASON_EVENTS.has(name) ? pick("reason") : null;

  const terminal: EnvelopeTerminal = { ssh: Boolean(input.env["SSH_CONNECTION"] || input.env["SSH_TTY"]) };
  for (const key of TERMINAL_KEYS) {
    const value = field(input.env[key], TERMINAL_MAX[key]);
    if (value !== null) terminal[key] = value;
  }
  const proc: EnvelopeProcess = { ppid: input.proc.ppid, hook_pid: input.proc.pid, uid: input.proc.uid };
  if (PLATFORMS.has(input.proc.platform)) proc.platform = input.proc.platform as EnvelopeProcess["platform"] & string;

  return {
    schema_version: 1,
    hook_id: input.hookId,
    agent: input.agent,
    observed_at: input.observedAt,
    event: {
      hook_event_name: name,
      session_id: session,
      cwd: pick("cwd"),
      transcript_path: pick("transcript_path"),
      permission_mode: pick("permission_mode"),
      prompt_id: pick("prompt_id"),
      agent_id: pick("agent_id"),
      agent_type: pick("agent_type"),
      tool_name: tool,
      tool_use_id: pick("tool_use_id"),
      notification_type: pick("notification_type"),
      source,
      reason,
      turn_id: pickExtra("turn_id"),
      model: pickExtra("model"),
      detail,
      tool_meta: name === "PreToolUse" ? toolMetaOf(raw, tool) : null,
      background: BACKGROUND_EVENTS.has(name) ? backgroundOf(raw) : null,
    },
    process: proc,
    terminal,
  };
}

/** Hook events after which the agent may exit at once: the hook spools first and gives the POST less time. */
export const FINAL_EVENTS = new Set(["SessionEnd", "Interrupt", "session_shutdown"]);

/**
 * Before sending the token or an envelope, the hook asks the listener on the daemon's port to prove
 * it knows the token: `GET /v1/health?challenge=<hex>` must answer `proof` = HMAC-SHA256(token,
 * DAEMON_PROOF_PREFIX + port + "\n" + challenge), in hex, where port is the one the hook connected
 * to. A process that took over a stale port cannot answer, nor relay the daemon's answer for its port.
 */
export const DAEMON_PROOF_PREFIX = "agent-office daemon proof v1\n";
export const CHALLENGE_PATTERN = /^[0-9a-f]{32,128}$/;
