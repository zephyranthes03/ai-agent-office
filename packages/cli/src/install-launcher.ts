// The launcher that `agent-office install-hooks` writes at a fixed path, and the checks before it:
// what an agent's hook settings or reporter file name, whichever form the agent takes.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { pathsFor, writeAtomic } from "@agent-office/daemon";

/** Everything the installer takes from the machine, so tests can give it a home of their own. */
export type InstallContext = {
  env: NodeJS.ProcessEnv;
  userHome: string;
  officeHome: string;
  nodePath: string;
  nodeVersion: string;
  /** The hook program the launcher runs. */
  hookEntry: string;
  platform: string;
  uid: number;
  /** What `<command> --version` printed, or null when it could not be run. */
  agentVersion: (command: string) => string | null;
  /** Whether a person can answer the confirmation question. */
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  out: (text: string) => void;
  now: () => number;
};

/**
 * The path to fix the launcher's Node by. Node resolves its own path, so under Homebrew it is the
 * keg (`<prefix>/Cellar/node@22/22.23.4/bin/node`), which the next upgrade of the formula removes
 * (2026-10-31: a revision bump took the launcher's Node away and every hook ran into nothing). The
 * formula's `opt` link follows upgrades, so when it leads to the same file the launcher names it.
 */
export function stableNodePath(execPath: string, fs: { existsSync: (path: string) => boolean; realpathSync: (path: string) => string } = { existsSync, realpathSync }): string {
  const keg = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  if (keg === null) return execPath;
  const linked = `${keg[1]}/opt/${keg[2]}/bin/node`;
  try {
    return fs.existsSync(linked) && fs.realpathSync(linked) === fs.realpathSync(execPath) ? linked : execPath;
  } catch (error) {
    // A link that leads nowhere, or a path we may not read: the keg's own path is still true now.
    if ((error as NodeJS.ErrnoException).code === undefined) throw error;
    return execPath;
  }
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The launcher: a POSIX shell script that execs the hook program, so the hook's parent stays the
 * agent. It fixes the office folder it was installed for, so hooks and the daemon agree on it
 * whatever the agent's environment holds. When the Node it was installed with is gone (an upgrade
 * removed it), a Node of a usable version on the agent's PATH runs the hook instead, and the
 * `launcher-fallback-node` mark tells `doctor` to ask for a reinstall; only when nothing can run
 * the hook does it leave `launcher-target-missing` and exit, silently, so it never fails the agent.
 */
export function launcherScript(nodePath: string, entry: string, home: string): string {
  return [
    "#!/bin/sh",
    "# agent-office hook launcher, written by `agent-office install-hooks`. Agents' hook settings name this",
    "# fixed path; reinstalling (later, the packaged app) replaces only this file. It runs the hook program",
    "# with the Node it was installed with, for the folder it was installed in, without the agent's",
    "# NODE_OPTIONS, and prints nothing. When that Node is gone (an upgrade), a Node 22.18 or later on the",
    "# PATH runs the hook and logs/launcher-fallback-node is touched (doctor asks to reinstall); when nothing",
    "# can run the hook it touches logs/launcher-target-missing and exits 0, so it never fails the agent.",
    "exec >/dev/null 2>&1",
    "umask 077",
    "unset NODE_OPTIONS",
    `AGENT_OFFICE_HOME=${quote(home)}`,
    "export AGENT_OFFICE_HOME",
    `node=${quote(nodePath)}`,
    `entry=${quote(entry)}`,
    'if [ ! -x "$node" ]; then',
    "  found=$(command -v node) || found=''",
    '  case "$found" in',
    '    /*) case "$("$found" --version)" in',
    '          v22.1[89].*|v22.[2-9][0-9].*|v2[3-9].*|v[3-9][0-9].*) node="$found"; : >"$AGENT_OFFICE_HOME/logs/launcher-fallback-node" ;;',
    "        esac ;;",
    "  esac",
    "fi",
    'if [ ! -x "$node" ] || [ ! -f "$entry" ]; then',
    '  : >"$AGENT_OFFICE_HOME/logs/launcher-target-missing"',
    "  exit 0",
    "fi",
    'exec "$node" "$entry" "$@"',
    "",
  ].join("\n");
}

const MIN_NODE = [22, 18];

function nodeTooOld(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major < MIN_NODE[0]! || (major === MIN_NODE[0] && minor < MIN_NODE[1]!);
}

const hasControl = (text: string): boolean => Array.from(text).some((ch) => (ch.codePointAt(0) ?? 0) < 32 || ch === "\u007f");

/**
 * Why someone other than the user could change what a folder of ours holds (its owner, write
 * bits, a symbolic link in its place); null when only the user can. Missing folders pass.
 */
function folderProblem(dir: string, uid: number): string | null {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) return `${dir} is not a plain folder`;
  if (stat.uid !== uid) return `${dir} belongs to another user`;
  if ((stat.mode & 0o022) !== 0) return `${dir} can be changed by other users (mode ${(stat.mode & 0o777).toString(8)})`;
  const parent = statSync(dirname(dir));
  // A folder anyone may write to lets anyone rename ours away, unless it is sticky (/tmp).
  if ((parent.mode & 0o002) !== 0 && (parent.mode & 0o1000) === 0) return `${dirname(dir)} can be changed by anyone`;
  return null;
}

/** Why someone other than the user or root could change a program the launcher runs, or its folder; null when nobody can. */
function programProblem(file: string, uid: number): string | null {
  for (const path of [file, dirname(file)]) {
    const stat = statSync(path);
    if (stat.uid !== uid && stat.uid !== 0) return `${path} belongs to another user`;
    if ((stat.mode & 0o002) !== 0) return `${path} can be changed by anyone`;
  }
  return null;
}

/** What installing means for the launcher: its path, its text (null when not installing) and whether it changes. */
export type LauncherPlan = { launcher: string; script: string | null; state: "new" | "updated" | "unchanged" };

/** The launcher for this request, or why it cannot be installed from here. */
export function planLauncher(action: "install" | "uninstall", ctx: InstallContext, agentProblem: (launcher: string) => string | null): LauncherPlan | { problem: string } {
  const paths = pathsFor(ctx.officeHome);
  const launcher = join(paths.bin, "agent-office-hook");
  if (action !== "install") return { launcher, script: null, state: "unchanged" };
  if (ctx.platform === "win32") return { problem: "Windows needs the packaged hook program (an .exe the agents can start without a shell); it comes with the desktop app" };
  if (nodeTooOld(ctx.nodeVersion)) return { problem: `the hook program needs Node 22.18 or later, and this is Node ${ctx.nodeVersion}` };
  for (const path of [launcher, ctx.nodePath, ctx.hookEntry]) {
    // A relative path in the agent's settings would be resolved against each session's folder.
    if (!isAbsolute(path) || hasControl(path)) return { problem: `${JSON.stringify(path)} is not a plain absolute path (set AGENT_OFFICE_HOME to one)` };
  }
  if (ctx.hookEntry.includes(`${sep}node_modules${sep}`)) return { problem: `the hook program ${ctx.hookEntry} is inside node_modules, where Node does not run TypeScript; run this from a checkout` };
  const problem = agentProblem(launcher) ?? programProblem(ctx.nodePath, ctx.uid) ?? programProblem(ctx.hookEntry, ctx.uid) ?? folderProblem(paths.home, ctx.uid) ?? folderProblem(paths.bin, ctx.uid);
  if (problem !== null) return { problem };
  const existing = lstatSync(launcher, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isFile()) return { problem: `${launcher} is not a file` };
  const script = launcherScript(ctx.nodePath, ctx.hookEntry, paths.home);
  const state = !existsSync(launcher) ? "new" : readFileSync(launcher, "utf8") === script && (statSync(launcher).mode & 0o777) === 0o700 ? "unchanged" : "updated";
  return { launcher, script, state };
}

/** Writes a launcher that changes; the reason when its folders stopped being safe since the plan. */
export function writeLauncher(plan: LauncherPlan, ctx: InstallContext): string | null {
  if (plan.script === null || plan.state === "unchanged") return null;
  const paths = pathsFor(ctx.officeHome);
  // logs/ too, where the launcher leaves its one sign of trouble.
  for (const dir of [paths.bin, paths.logs]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const problem = folderProblem(paths.home, ctx.uid) ?? folderProblem(paths.bin, ctx.uid);
  if (problem !== null) return problem;
  writeAtomic(plan.launcher, plan.script, 0o700);
  return null;
}
