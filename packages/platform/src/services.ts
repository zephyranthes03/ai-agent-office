// What controlling a background service needs of the operating system, under the external execution
// rules (docs/privacy-security.md): an absolute path found in fixed folders, no shell, an environment
// allowlist, a time and size limit. launchd is asked only for its job table (id, last status, label),
// so no job's arguments or environment are read; a port is mapped to the process listening on it.
import { spawn, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_OUTPUT = 1024 * 1024;

export type CommandOutcome = { outcome: "exited"; code: number; stdout: string; stderr: string } | { outcome: "timeout" } | { outcome: "failed"; code: string };

export type ServiceHost = {
  supported: boolean;
  /** The absolute path of a command, when it is in the fixed folders and only its owner or root can change it. */
  locate: (command: string) => string | null;
  run: (path: string, args: readonly string[], timeoutMs: number) => Promise<CommandOutcome>;
  /** launchd's loaded jobs: label → the job's process id (null when it has none now). */
  launchdJobs: () => Map<string, number | null>;
  /** The one process listening on a local TCP port, or null. */
  listenerOf: (port: number) => number | null;
  /** The one process holding a file open (a leading `~/` is the home folder), or null. */
  holderOf: (path: string) => number | null;
};

const folders = (home: string): string[] => ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin")];

/** Finds `name` in `dirs`; a file another user could replace does not count. */
export function locateCommand(name: string, dirs: readonly string[], uid: number): string | null {
  if (!NAME.test(name)) return null;
  for (const dir of dirs) {
    const candidate = join(dir, name);
    let mode: number;
    let owner: number;
    try {
      const info = statSync(realpathSync(candidate));
      mode = info.mode;
      owner = info.uid;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    if ((owner === uid || owner === 0) && (mode & 0o022) === 0 && (mode & 0o100) !== 0) return candidate;
  }
  return null;
}

/** `launchctl list` output → label → process id (`-` when the job has none). Other lines are skipped. */
export function parseLaunchctlList(output: string): Map<string, number | null> {
  const jobs = new Map<string, number | null>();
  for (const line of output.split("\n")) {
    const match = /^(-|\d+)\s+(?:-?\d+)\s+(\S+)\s*$/.exec(line);
    if (match) jobs.set(match[2]!, match[1] === "-" ? null : Number(match[1]));
  }
  return jobs;
}

/** `lsof -Fp` output → the only process id it names, or null when there is none or more than one. */
export function onlyProcess(output: string): number | null {
  const pids = output.split("\n").filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1)));
  return pids.length === 1 ? pids[0]! : null;
}

/** Runs a command with only the variables it needs; output past the limit is dropped. */
export function runCommand(path: string, args: readonly string[], timeoutMs: number, env: Record<string, string>): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(path, [...args], { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout = (stdout + text).slice(0, MAX_OUTPUT)));
    child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr = (stderr + text).slice(0, MAX_OUTPUT)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ outcome: "failed", code: error.code ?? error.name });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) resolve({ outcome: "timeout" });
      else if (code === null) resolve({ outcome: "failed", code: signal ?? "signal" });
      else resolve({ outcome: "exited", code, stdout, stderr });
    });
  });
}

export function createServiceHost(os: string = process.platform, home: string = homedir()): ServiceHost {
  if (os !== "darwin") return { supported: false, locate: () => null, run: async () => ({ outcome: "failed", code: "unsupported" }), launchdJobs: () => new Map(), listenerOf: () => null, holderOf: () => null };
  const dirs = folders(home);
  const env: Record<string, string> = { HOME: home, PATH: `${dirs.join(":")}:/usr/bin:/bin`, LANG: process.env["LANG"] ?? "en_US.UTF-8", NO_COLOR: "1", TERM: "dumb" };
  for (const name of ["USER", "LOGNAME", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    supported: true,
    locate: (command) => locateCommand(command, dirs, process.getuid!()),
    run: (path, args, timeoutMs) => runCommand(path, args, timeoutMs, env),
    launchdJobs() {
      const result = spawnSync("/bin/launchctl", ["list"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 5000, maxBuffer: MAX_OUTPUT });
      if (result.error) throw result.error;
      return parseLaunchctlList(result.stdout);
    },
    listenerOf(port) {
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
      const result = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C" }, timeout: 5000, maxBuffer: MAX_OUTPUT });
      if (result.error) throw result.error;
      return onlyProcess(result.stdout);
    },
    holderOf(path) {
      const file = path.startsWith("~/") ? join(home, path.slice(2)) : path;
      if (!file.startsWith("/") || file.includes("\0")) return null;
      const result = spawnSync("/usr/sbin/lsof", ["-Fp", "--", file], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C" }, timeout: 5000, maxBuffer: MAX_OUTPUT });
      if (result.error) throw result.error;
      return onlyProcess(result.stdout);
    },
  };
}
