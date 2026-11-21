// Process facts on macOS and Linux: id, parent id, start time and executable name, from one `ps`
// call on macOS and from `/proc/<pid>/stat` on Linux, and, for a lifecycle control, the path of the
// executable a process runs. Nothing else of a process is read (no arguments, no environment). The
// start time tells a process from a later one that got the same id.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export type ProcessInfo = { pid: number; ppid: number; startedAt: string; command: string };

const ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

/**
 * `ps -o pid=,ppid=,lstart=,comm=` output → processes by id. `lstart` is five fields in the C locale
 * ("Tue Oct 21 08:00:00 2026"); `comm` is the rest of the line and may hold spaces (a macOS path).
 * Lines of another shape are skipped.
 */
export function parsePs(output: string): Map<number, ProcessInfo> {
  const processes = new Map<number, ProcessInfo>();
  for (const line of output.split("\n")) {
    const match = ROW.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    processes.set(pid, { pid, ppid: Number(match[2]), startedAt: match[3]!.replace(/\s+/g, " "), command: match[4]! });
  }
  return processes;
}

/** The base name of an executable path (`/opt/homebrew/bin/node` → `node`). */
export const executableName = (command: string): string => command.split("/").pop() ?? command;

/** macOS never hands out a process id above this; `ps` refuses larger ones with a message. */
const DARWIN_PID_MAX = 99_999;

const PS = existsSync("/bin/ps") ? "/bin/ps" : "ps";

/**
 * What a finished `ps` call says. It exits 1 when none of the ids exists, which is an answer, not a
 * failure; exit 1 with a message (a `ps` that rejects the format, such as BusyBox's) is a failure.
 */
export function psAnswer(result: { status: number | null; stdout: string; stderr: string; error?: Error | undefined }): Map<number, ProcessInfo> {
  return parsePs(psOutput(result));
}

function psOutput(result: { status: number | null; stdout: string; stderr: string; error?: Error | undefined }): string {
  if (result.error) throw result.error;
  if (result.status !== 0 && !(result.status === 1 && result.stderr.trim() === "")) throw new Error(`ps exited with ${result.status}`);
  return result.stdout;
}

/**
 * Looks the processes up with `ps` (macOS); an id that is absent from the answer has no process.
 * Throws when `ps` itself cannot run, so a broken lookup is never mistaken for every process being gone.
 */
export function lookupProcesses(pids: number[]): Map<number, ProcessInfo> {
  const ids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0 && pid <= DARWIN_PID_MAX);
  if (ids.length === 0) return new Map();
  return psAnswer(spawnSync(PS, ["-o", "pid=,ppid=,lstart=,comm=", "-p", ids.join(",")], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C" }, timeout: 5000 }));
}

/**
 * `/proc/<pid>/stat` → the process, or undefined for text of another shape. The name (field 2) is in
 * parentheses and may hold spaces and parentheses itself, so the fields are counted from the last
 * `)`: the parent id is field 4 and the start time field 22, in clock ticks since boot. Unlike the
 * wall-clock time `ps` prints on Linux (boot time plus ticks), it does not move when the clock is
 * stepped (an NTP step, a VM or WSL resume), so it is kept as the `ticks:<n>` token.
 */
export function parseProcStat(text: string): ProcessInfo | undefined {
  const open = text.indexOf(" (");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = Number(text.slice(0, open));
  const fields = text.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const ticks = fields[19];
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || ticks === undefined || !/^\d+$/.test(ticks)) return undefined;
  return { pid, ppid, startedAt: `ticks:${ticks}`, command: text.slice(open + 2, close) };
}

/**
 * Looks the processes up in `/proc` (Linux); an id without a readable `stat` has no process. Throws
 * when `/proc` itself is missing, so a broken lookup is never mistaken for every process being gone.
 */
export function lookupProcfs(pids: number[], root = "/proc"): Map<number, ProcessInfo> {
  const ids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (ids.length === 0) return new Map();
  if (!existsSync(join(root, "self", "stat"))) throw new Error(`no process table at ${root}`);
  const processes = new Map<number, ProcessInfo>();
  for (const pid of ids) {
    let text: string;
    try {
      text = readFileSync(join(root, String(pid), "stat"), "utf8");
    } catch (error) {
      // ESRCH: the process ended while its file was being read.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") continue;
      throw error;
    }
    const info = parseProcStat(text.trim());
    if (info !== undefined && info.pid === pid) processes.set(pid, info);
  }
  return processes;
}

/** Every process on this machine (macOS): one `ps -A` call. Throws when `ps` itself cannot run. */
export function listProcesses(): Map<number, ProcessInfo> {
  return psAnswer(spawnSync(PS, ["-A", "-o", "pid=,ppid=,lstart=,comm="], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C" }, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }));
}

/** Every process in `/proc` (Linux). Throws when `/proc` itself is missing. */
export function listProcfs(root = "/proc"): Map<number, ProcessInfo> {
  if (!existsSync(join(root, "self", "stat"))) throw new Error(`no process table at ${root}`);
  const ids = readdirSync(root).filter((name) => /^\d+$/.test(name)).map(Number);
  return lookupProcfs(ids, root);
}

/** The processes below `root` in `table`: its children, theirs, and so on, at most `max` of them. */
export function descendantsIn(table: ReadonlyMap<number, ProcessInfo>, root: number, max = 512): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const info of table.values()) {
    if (info.pid === root || info.pid <= 1) continue;
    const list = children.get(info.ppid);
    if (list === undefined) children.set(info.ppid, [info]);
    else list.push(info);
  }
  const found: ProcessInfo[] = [];
  const queue = [...(children.get(root) ?? [])];
  const seen = new Set<number>([root]);
  while (queue.length > 0 && found.length < max) {
    const next = queue.shift()!;
    if (seen.has(next.pid)) continue;
    seen.add(next.pid);
    found.push(next);
    queue.push(...(children.get(next.pid) ?? []));
  }
  return found;
}

/** The executable a process runs, or why it is not known: the process is gone, belongs to another user, or the answer had another shape. */
export type ExecutableAnswer = { path: string } | { missing: "gone" | "not_permitted" | "unknown" };

/**
 * The executable file a process runs, as an absolute path: macOS asks `lsof` for the process's
 * text file (no arguments or environment are read), Linux reads `/proc/<pid>/exe`.
 */
export function executablePathOf(pid: number, os: string = process.platform): ExecutableAnswer {
  if (!Number.isInteger(pid) || pid <= 1) return { missing: "unknown" };
  if (os === "linux") {
    try {
      return { path: readlinkSync(join("/proc", String(pid), "exe")) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return { missing: "gone" };
      if (code === "EACCES" || code === "EPERM") return { missing: "not_permitted" };
      throw error;
    }
  }
  if (!existsSync("/usr/sbin/lsof")) return { missing: "unknown" };
  const result = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C" }, timeout: 5000 });
  if (result.error) throw result.error;
  const path = firstTextFile(result.stdout);
  // lsof prints nothing for a process that is gone, or that it may not look at.
  return path === null ? { missing: "unknown" } : { path };
}

/** `lsof -Fn` output → the first file name of the process's text files (its executable), if absolute. */
export function firstTextFile(output: string): string | null {
  const line = output.split("\n").find((entry) => entry.startsWith("n/"));
  return line === undefined ? null : line.slice(1);
}

/** Whether a process has a controlling terminal, or why it is not known. */
export type TtyAnswer = { tty: boolean } | { missing: "gone" | "unknown" };

/** `ps -o tty=` output → its answer: a terminal's name, `??` for none, nothing when the process is gone. */
export function ttyFromPs(output: string): TtyAnswer {
  const name = output.trim();
  return name === "" ? { missing: "gone" } : { tty: !name.startsWith("?") };
}

/** `/proc/<pid>/stat` → its answer: field 7 is the terminal's device number, 0 for none (counted from the last `)`, as in parseProcStat). */
export function ttyFromProcStat(text: string): TtyAnswer {
  const close = text.lastIndexOf(")");
  const device = close < 0 ? undefined : text.slice(close + 2).split(" ")[4];
  return device === undefined || !/^-?\d+$/.test(device) ? { missing: "unknown" } : { tty: device !== "0" };
}

/** Whether `pid` has a controlling terminal: macOS asks `ps`, Linux reads `/proc/<pid>/stat`. */
export function controllingTty(pid: number, os: string = process.platform, root = "/proc"): TtyAnswer {
  if (!Number.isInteger(pid) || pid <= 1) return { missing: "unknown" };
  if (os === "linux") {
    let text: string;
    try {
      text = readFileSync(join(root, String(pid), "stat"), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return { missing: "gone" };
      throw error;
    }
    return ttyFromProcStat(text.trim());
  }
  return ttyFromPs(psOutput(spawnSync(PS, ["-o", "tty=", "-p", String(pid)], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C" }, timeout: 5000 })));
}

export type SignalTarget = { pid: number; startedAt: string; names: readonly string[] };
export type SignalOutcome = "signalled" | "gone" | "mismatch" | "not_permitted";

/**
 * Sends `signal` to exactly one process, the one `target` describes: it is looked up again right
 * before, and nothing is sent unless it still has the same start time and one of `names` as its
 * executable. Never a process group, never this process, its parent or init. `gone`: no such
 * process; `mismatch`: another process now has the id; `not_permitted`: it belongs to someone else.
 */
export function signalExact(target: SignalTarget, signal: "SIGTERM" | "SIGHUP" | "SIGINT", lookup: (pids: number[]) => Map<number, ProcessInfo>, kill: (pid: number, signal: string) => void = (pid, sig) => process.kill(pid, sig)): SignalOutcome {
  if (!Number.isInteger(target.pid) || target.pid <= 1 || target.pid === process.pid || target.pid === process.ppid) return "mismatch";
  const info = lookup([target.pid]).get(target.pid);
  if (info === undefined) return "gone";
  if (info.startedAt !== target.startedAt || !target.names.includes(executableName(info.command))) return "mismatch";
  try {
    kill(target.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "not_permitted";
    throw error;
  }
  return "signalled";
}
