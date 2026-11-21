// The platform layer: what the daemon needs from the operating system, behind one interface, so
// nothing else calls child_process or OS-specific APIs. Processes for now (macOS through `ps`, Linux
// through `/proc`; Windows is not implemented yet and reports no capability), and the one signal a
// lifecycle control sends to one exactly identified process.
import { controllingTty, executableName, executablePathOf, listProcesses, listProcfs, lookupProcesses, lookupProcfs, signalExact } from "./processes.ts";
import type { ExecutableAnswer, ProcessInfo, SignalOutcome, SignalTarget, TtyAnswer } from "./processes.ts";

export type { ExecutableAnswer, ProcessInfo, SignalOutcome, SignalTarget, TtyAnswer } from "./processes.ts";
export { controllingTty, descendantsIn, executableName, firstTextFile, lookupProcfs, parseProcStat, parsePs, psAnswer, signalExact, ttyFromProcStat, ttyFromPs } from "./processes.ts";

export type Platform = {
  /** Whether process lookups work here. */
  processes: boolean;
  /** The given processes that exist, by id. */
  lookupProcesses: (pids: number[]) => Map<number, ProcessInfo>;
};

/**
 * What a lifecycle control needs of the operating system: every process (for what a stopped process
 * leaves behind), the executable a process runs, whether it has a controlling terminal, and one
 * signal to one exactly identified process.
 */
export type ProcessControl = {
  supported: boolean;
  list: () => Map<number, ProcessInfo>;
  executablePath: (pid: number) => ExecutableAnswer;
  controllingTty: (pid: number) => TtyAnswer;
  signal: (target: SignalTarget, signal: "SIGTERM" | "SIGHUP" | "SIGINT") => SignalOutcome;
};

export function createProcessControl(os: string = process.platform): ProcessControl {
  if (os === "darwin") return { supported: true, list: listProcesses, executablePath: (pid) => executablePathOf(pid, os), controllingTty: (pid) => controllingTty(pid, os), signal: (target, sig) => signalExact(target, sig, lookupProcesses) };
  if (os === "linux") return { supported: true, list: () => listProcfs(), executablePath: (pid) => executablePathOf(pid, os), controllingTty: (pid) => controllingTty(pid, os), signal: (target, sig) => signalExact(target, sig, (pids) => lookupProcfs(pids)) };
  return { supported: false, list: () => new Map(), executablePath: () => ({ missing: "unknown" }), controllingTty: () => ({ missing: "unknown" }), signal: () => "mismatch" };
}

export function createPlatform(os: string = process.platform): Platform {
  if (os === "darwin") return { processes: true, lookupProcesses };
  if (os === "linux") return { processes: true, lookupProcesses: (pids) => lookupProcfs(pids) };
  return { processes: false, lookupProcesses: () => new Map() };
}

export type PidCheck = { pid: number; confidence: "exact" | "ancestor"; startedAt: string } | { pid: null; confidence: "unknown"; startedAt: null };

/**
 * Which process a session's hook reported as its parent really is the agent: the reported process
 * when its executable is one of the adapter's `process_names` (`exact`), else the nearest ancestor
 * that is (`ancestor`; a shell between agent and hook), within a few levels; else `unknown`.
 */
export function verifyPid(reported: number, names: readonly string[], lookup: (pids: number[]) => Map<number, ProcessInfo>, maxDepth = 6): PidCheck {
  let pid = reported;
  for (let depth = 0; depth <= maxDepth && pid > 1; depth++) {
    const info = lookup([pid]).get(pid);
    if (info === undefined) break;
    if (names.includes(executableName(info.command))) return { pid, confidence: depth === 0 ? "exact" : "ancestor", startedAt: info.startedAt };
    pid = info.ppid;
  }
  return { pid: null, confidence: "unknown", startedAt: null };
}

export type { CommandOutcome, ServiceHost } from "./services.ts";
export { createServiceHost, locateCommand, onlyProcess, parseLaunchctlList, runCommand } from "./services.ts";
export type { Desktop, LaunchExtras, Runner, TerminalApp } from "./desktop.ts";
export { APP_LINK, bundleOf, createDesktop, EDITORS, editorFolders, folderHolding, ITERM_UUID, resumeScript, shellQuote } from "./desktop.ts";
