// What a background service's own status command says, read from its output and nothing more: running
// or stopped, the process id or port when it gives one, and whether the service answered. Only the
// fields named here are looked at; command lines, addresses and paths in the same output are not read
// and nothing of it is kept. Output of any other shape is `unknown`, which turns that service's controls off.
export type ServiceFormat = "openclaw_json" | "hermes_list" | "opencode_text" | "codex_version";
export type ServiceReading = { state: "running"; pid: number | null; port: number | null; healthy: boolean | null } | { state: "stopped" } | { state: "unknown"; problem: string };

const SHAPE: ServiceReading = { state: "unknown", problem: "status_shape_unknown" };

function parsed(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

const object = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** `openclaw gateway status --json`, with or without its connection check. */
function openclaw(code: number, stdout: string): ServiceReading {
  const value = object(parsed(stdout));
  const runtime = object(object(value?.["service"])?.["runtime"]);
  if (code !== 0 || runtime === null) return SHAPE;
  if (runtime["status"] === "stopped") return { state: "stopped" };
  const pid = runtime["pid"];
  if (runtime["state"] !== "running" || typeof pid !== "number" || !Number.isInteger(pid)) return SHAPE;
  const rpc = object(value?.["rpc"]);
  return { state: "running", pid, port: null, healthy: rpc === null ? null : rpc["ok"] === true };
}

/** `hermes gateway list`: the current profile's line. */
function hermes(code: number, stdout: string): ServiceReading {
  const line = stdout.split("\n").find((text) => text.includes("(current)"));
  if (code !== 0 || line === undefined) return SHAPE;
  if (line.includes("not running")) return { state: "stopped" };
  const match = /\bPID (\d+)\b/.exec(line);
  return match === null ? SHAPE : { state: "running", pid: Number(match[1]), port: null, healthy: null };
}

/** `opencode service status`: `stopped`, or the local address it serves. */
function opencode(code: number, stdout: string): ServiceReading {
  const text = stdout.trim();
  if (code !== 0) return SHAPE;
  if (text === "stopped") return { state: "stopped" };
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(text);
  return match === null ? SHAPE : { state: "running", pid: null, port: Number(match[1]), healthy: null };
}

/** `codex app-server daemon version`: fails to connect when no daemon runs. */
function codex(code: number, stdout: string, stderr: string): ServiceReading {
  if (code !== 0) return stdout.trim() === "" && stderr.includes("failed to connect") ? { state: "stopped" } : SHAPE;
  return object(parsed(stdout))?.["status"] === "running" ? { state: "running", pid: null, port: null, healthy: null } : SHAPE;
}

export function readServiceStatus(format: ServiceFormat, code: number, stdout: string, stderr: string): ServiceReading {
  if (format === "openclaw_json") return openclaw(code, stdout);
  if (format === "hermes_list") return hermes(code, stdout);
  if (format === "opencode_text") return opencode(code, stdout);
  return codex(code, stdout, stderr);
}
