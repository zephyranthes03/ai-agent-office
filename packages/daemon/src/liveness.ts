// The process_scan strategy: is each session's agent process still running? The first check of a
// session verifies the parent process its hooks reported against the adapter's process names
// (exact, or an ancestor above a shell); later checks look that process up again and compare its
// start time, so a new process that got the same id does not count as the agent. The results feed
// the reducer as liveness reports (rule B3): an exact process that is gone ends its session. The
// first check also tells where the session runs, from the process's path (only the kind is kept).
import { descriptors } from "@agent-office/adapters";
import { executableName, verifyPid } from "@agent-office/platform";
import type { Platform, ProcessInfo } from "@agent-office/platform";
import type { Launcher } from "@agent-office/core";
import type { SessionInfo } from "./store.ts";

/**
 * Where a session runs, from its agent process's executable path and the hook's terminal facts: the
 * Claude or ChatGPT (Codex) desktop app, VS Code (its extension or its terminal), or another terminal;
 * null when nothing tells.
 */
export function launcherOf(command: string, terminal: Record<string, unknown> | null): Launcher | null {
  if (/\/Application Support\/Claude\/|\/Claude\.app\//.test(command)) return "claude-app";
  if (/\/(ChatGPT|Codex)\.app\//.test(command)) return "codex-app";
  if (/\/\.vscode(-insiders)?\/extensions\/|\/Visual Studio Code[^/]*\.app\//.test(command) || terminal?.["TERM_PROGRAM"] === "vscode") return "vscode";
  if (terminal !== null && ["TERM_PROGRAM", "TMUX", "ITERM_SESSION_ID", "WEZTERM_PANE", "KITTY_WINDOW_ID", "WT_SESSION"].some((key) => typeof terminal[key] === "string")) return "terminal";
  return null;
}

export type LivenessTarget = { session: string; agent: string; info: SessionInfo };
export type LivenessResult = { session: string; facts: Partial<SessionInfo>; report: { alive: boolean; confidence: "exact" | "ancestor" } | null };

function processNames(agent: string): readonly string[] {
  return Object.hasOwn(descriptors, agent) ? descriptors[agent as keyof typeof descriptors].process_names : [];
}

/** One pass over the sessions; `ps` runs once for the known processes, and per level for new checks. */
export function checkLiveness(targets: LivenessTarget[], platform: Platform): LivenessResult[] {
  if (!platform.processes || targets.length === 0) return [];
  const known = new Map<number, ProcessInfo | null>();
  const lookup = (pids: number[]): Map<number, ProcessInfo> => {
    const missing = pids.filter((pid) => !known.has(pid));
    if (missing.length > 0) {
      const found = platform.lookupProcesses(missing);
      for (const pid of missing) known.set(pid, found.get(pid) ?? null);
    }
    return new Map(pids.flatMap((pid) => {
      const info = known.get(pid);
      return info ? [[pid, info] as const] : [];
    }));
  };
  lookup(targets.filter((t) => t.info.pidConfidence === "exact" || t.info.pidConfidence === "ancestor").flatMap((t) => (t.info.pid === null ? [] : [t.info.pid])));

  return targets.flatMap((target): LivenessResult[] => {
    const names = processNames(target.agent);
    if (names.length === 0 || target.info.reportedPid === null) return [];
    let { pid, pidConfidence: confidence, pidStartedAt: startedAt } = target.info;
    const facts: Partial<SessionInfo> = {};
    if (confidence === null) {
      const check = verifyPid(target.info.reportedPid, names, lookup);
      ({ pid, confidence, startedAt } = { pid: check.pid, confidence: check.confidence, startedAt: check.startedAt });
      Object.assign(facts, { pid, pidConfidence: confidence, pidStartedAt: startedAt });
    }
    if (confidence !== "exact" && confidence !== "ancestor") return [{ session: target.session, facts, report: null }];
    const info = pid === null ? undefined : lookup([pid]).get(pid);
    const alive = info !== undefined && info.startedAt === startedAt && names.includes(executableName(info.command));
    // A process found gone is not checked again: its id may soon belong to another process.
    if (!alive) Object.assign(facts, { pid: null, pidConfidence: "unknown", pidStartedAt: null });
    // Where it runs, from the live process, once (sessions checked before it was recorded learn it too).
    else if (target.info.launcher === null) {
      const launcher = launcherOf(info.command, target.info.terminal);
      if (launcher !== null) facts.launcher = launcher;
    }
    return [{ session: target.session, facts, report: { alive, confidence } }];
  });
}
