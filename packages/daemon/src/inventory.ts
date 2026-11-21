// The agent's own list of its running sessions (descriptor `lifecycle.inventory`), read only right
// before a lifecycle control, to bind a session id to the exact process the control will touch.
// Claude Code's `claude agents --json` (2.1.311, checked 2026-11-08) prints an array of objects with
// pid, sessionId, kind, status and startedAt besides the folder and a name; only pid, sessionId and
// kind are read, and nothing is kept. A session started from another agent's environment (a child
// session) is not listed, so it is never controlled. The command runs under the external execution rules (docs/privacy-security.md): an absolute
// path (the session's own executable), no shell, an environment allowlist, a time and size limit.
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

export type InventoryEntry = { pid: number; session: string; interactive: boolean };
export type Inventory = { outcome: "ok"; entries: InventoryEntry[] } | { outcome: "unavailable"; code: string };

const MAX_OUTPUT = 1024 * 1024;
const TIMEOUT_MS = 5000;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** `claude agents --json` output → its entries; anything of another shape is `unavailable`. */
export function parseClaudeAgents(stdout: string): Inventory {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { outcome: "unavailable", code: "not_json" };
  }
  if (!Array.isArray(value)) return { outcome: "unavailable", code: "not_a_list" };
  const entries: InventoryEntry[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") return { outcome: "unavailable", code: "entry_shape" };
    const { pid, sessionId, kind } = item as { pid?: unknown; sessionId?: unknown; kind?: unknown };
    if (!Number.isInteger(pid) || typeof sessionId !== "string" || !SESSION.test(sessionId)) return { outcome: "unavailable", code: "entry_shape" };
    entries.push({ pid: pid as number, session: sessionId, interactive: kind === "interactive" });
  }
  return { outcome: "ok", entries };
}

const PARSERS: Record<string, (stdout: string) => Inventory> = { "claude-code": parseClaudeAgents };

/** The variables the agent's own command may see: where its files are, and nothing else of the daemon's. */
function allowedEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", LANG: process.env["LANG"] ?? "en_US.UTF-8" };
  for (const name of ["HOME", "USER", "LOGNAME", "TMPDIR", "CLAUDE_CONFIG_DIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export type InventoryRunner = (agent: string, executable: string, args: readonly string[]) => Inventory;

/** Runs the agent's inventory command with its own executable and reads it. */
export const runInventory: InventoryRunner = (agent, executable, args) => {
  const parse = Object.hasOwn(PARSERS, agent) ? PARSERS[agent]! : null;
  if (parse === null) return { outcome: "unavailable", code: "no_parser" };
  if (!isAbsolute(executable) || executable.includes("\0")) return { outcome: "unavailable", code: "executable" };
  const result = spawnSync(executable, [...args], { encoding: "utf8", env: allowedEnv(), timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, stdio: ["ignore", "pipe", "ignore"] });
  if (result.error) return { outcome: "unavailable", code: (result.error as NodeJS.ErrnoException).code ?? result.error.name };
  if (result.status !== 0) return { outcome: "unavailable", code: `exit_${result.status ?? result.signal}` };
  return parse(result.stdout);
};

/**
 * What the inventory says about `session` at `pid`: listed there as an interactive session (`ok`),
 * listed at another process or the process listed with another session (`mismatch`), or absent.
 */
export function inventoryVerdict(inventory: InventoryEntry[], session: string, pid: number): "ok" | "mismatch" | "absent" {
  const bySession = inventory.find((entry) => entry.session === session);
  const byPid = inventory.find((entry) => entry.pid === pid);
  if (bySession === undefined && byPid === undefined) return "absent";
  if (bySession !== undefined && bySession.pid === pid && bySession.interactive && (byPid === undefined || byPid.session === session)) return "ok";
  return "mismatch";
}
