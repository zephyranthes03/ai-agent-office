// Bringing an agent's terminal forward, and opening a new terminal window, for "open session"
// (docs/notifications.md, focus order). macOS only for now: tmux, iTerm2 and Terminal through their
// own commands and AppleScript, any other app by activating its bundle. No value is ever pasted into
// a shell or a script: commands get argument lists, AppleScript gets its values as `argv`, and the
// one script file written for a new window quotes every word with `shellQuote`. Every command has a
// time limit. Elsewhere `supported` is false and every action reports that it did nothing.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lookupProcesses } from "./processes.ts";
import type { ProcessInfo } from "./processes.ts";

/** Runs a program with arguments (never through a shell) and resolves with its outcome. */
export type Runner = (command: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export type TerminalApp = "iTerm" | "Terminal";

export type Desktop = {
  supported: boolean;
  /** Selects the tmux window and pane (`TMUX` is `<socket>,<pid>,<index>`). */
  focusTmux: (tmux: string, pane: string) => Promise<boolean>;
  /** Selects the iTerm2 session with this unique id and brings its window forward. */
  focusIterm: (uuid: string) => Promise<boolean>;
  /** Selects the Terminal tab on this tty (`/dev/ttys005`) and brings its window forward. */
  focusTerminalTab: (tty: string) => Promise<boolean>;
  /** Brings an app forward by its bundle path. */
  activateApp: (bundle: string) => Promise<boolean>;
  /** Opens one of the agents' own app links (`claude://…`, `codex://…`), which the app handles. */
  openLink: (url: string) => Promise<boolean>;
  /** Opens a new window of `app` that changes to `cwd` and runs `argv` there, in the user's login shell. */
  openTerminal: (app: TerminalApp, cwd: string, argv: string[], extras?: LaunchExtras) => Promise<boolean>;
  /**
   * Brings forward the window of a VS Code-like editor (`bundle`) that has `cwd`, or a folder above
   * it, open: the editor's own command line is given that folder, which it answers by raising the
   * window that holds it. False when no window has it (nothing is opened anew) or the app is no editor.
   */
  focusEditorFolder: (bundle: string, cwd: string) => Promise<boolean>;
  /** The controlling terminal of a process (`/dev/ttys005`), or null. */
  ttyOf: (pid: number) => Promise<string | null>;
  /** The outermost app bundle among a process and its ancestors, or null. */
  appOf: (pid: number) => string | null;
};

/**
 * VS Code-like editors: the folder under `~/Library/Application Support` that keeps their window
 * state, and their command line inside the bundle. VS Code is verified (2026-11-01); the others
 * share its layout and are unverified.
 */
export const EDITORS: Record<string, { support: string; cli: string }> = {
  "Visual Studio Code.app": { support: "Code", cli: "code" },
  "Visual Studio Code - Insiders.app": { support: "Code - Insiders", cli: "code-insiders" },
  "Cursor.app": { support: "Cursor", cli: "cursor" },
  "VSCodium.app": { support: "VSCodium", cli: "codium" },
};

/**
 * The folders an editor's windows have open, from its window state (`storage.json`,
 * `windowsState.openedWindows[].folder`, file URLs); nothing else of the file is read. A file of
 * another shape gives none. The editors are macOS apps, so the URLs are read as POSIX paths whatever
 * system runs this.
 */
export function editorFolders(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return [];
  }
  const state = (value as { windowsState?: { openedWindows?: unknown } } | null)?.windowsState?.openedWindows;
  if (!Array.isArray(state)) return [];
  const folders = new Set<string>();
  for (const window of state) {
    const folder = (window as { folder?: unknown } | null)?.folder;
    if (typeof folder !== "string" || !folder.startsWith("file://")) continue;
    try {
      folders.add(fileURLToPath(folder, { windows: false }));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  return [...folders];
}

/** The open folder that is `cwd` or holds it (the nearest when several do), else null; POSIX paths, as editorFolders gives. */
export function folderHolding(folders: readonly string[], cwd: string): string | null {
  let best: string | null = null;
  for (const folder of folders) {
    if ((cwd === folder || cwd.startsWith(folder.endsWith("/") ? folder : `${folder}/`)) && (best === null || folder.length > best.length)) best = folder;
  }
  return best;
}

const TIMEOUT_MS = 5000;
/** iTerm2 session ids are UUIDs (`ITERM_SESSION_ID` is `w0t1p0:<uuid>`). */
export const ITERM_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const TTY = /^\/dev\/ttys?\d{1,4}$/;
/** The app links "open session" may hand to the system: the agents' own schemes, plain characters only. */
export const APP_LINK = /^(claude|codex):\/\/[A-Za-z0-9/?=._&-]{1,200}$/;
const TMUX_PANE = /^%\d{1,6}$/;

/** One word for a POSIX shell: single-quoted, with each `'` written as `'\''`. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * What a lifecycle control adds to a new window's script: the variables to remove before the agent
 * runs (markers another agent session leaves in a terminal it started), and a file the script writes
 * its own process id to right before `exec`, which keeps that id, so the id is the agent's.
 */
export type LaunchExtras = { unset?: readonly string[]; pidFile?: string };

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** The script a new window runs: removes itself, changes to the folder, then runs the command. */
export function resumeScript(cwd: string, argv: string[], extras: LaunchExtras = {}): string {
  const unset = (extras.unset ?? []).filter((name) => ENV_NAME.test(name));
  const lines = ["#!/bin/sh", 'rm -f -- "$0"', `cd -- ${shellQuote(cwd)} || exit 1`];
  if (unset.length > 0) lines.push(`unset ${unset.join(" ")}`);
  if (extras.pidFile !== undefined) lines.push(`printf '%s\\n' "$$" > ${shellQuote(extras.pidFile)} || exit 1`);
  lines.push(`exec ${argv.map(shellQuote).join(" ")}`);
  return `${lines.join("\n")}\n`;
}

/** `/Applications/ChatGPT.app/Contents/Resources/x/Helper.app/Contents/MacOS/x` → `/Applications/ChatGPT.app`. */
export function bundleOf(command: string): string | null {
  const at = command.indexOf(".app/");
  return at < 0 ? null : command.slice(0, at + 4);
}

const ITERM_FOCUS = `on run argv
  set target to item 1 of argv
  tell application id "com.googlecode.iterm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if unique id of s is target then
            tell w to select
            tell t to select
            tell s to select
            activate
            return "found"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

const TERMINAL_FOCUS = `on run argv
  set target to item 1 of argv
  tell application id "com.apple.Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is target then
          set selected tab of w to t
          set index of w to 1
          activate
          return "found"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

// A new iTerm2 window starts the user's login shell, which then runs the script (so PATH is the user's).
const ITERM_OPEN = `on run argv
  tell application id "com.googlecode.iterm2"
    set w to (create window with default profile)
    tell current session of w to write text (item 1 of argv)
    activate
  end tell
  return "found"
end run`;

const defaultRunner: Runner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: TIMEOUT_MS, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } }, (error, stdout) => resolve({ ok: error === null, stdout: String(stdout) }));
  });

const NOTHING: Desktop = {
  supported: false,
  focusTmux: async () => false,
  focusIterm: async () => false,
  focusTerminalTab: async () => false,
  activateApp: async () => false,
  openLink: async () => false,
  openTerminal: async () => false,
  focusEditorFolder: async () => false,
  ttyOf: async () => null,
  appOf: () => null,
};

/**
 * The desktop actions of this operating system. `scriptsDir` is a private folder for the one-off
 * scripts a new window runs (they delete themselves when they start); `home` is where the editors
 * keep their window state.
 */
export function createDesktop(scriptsDir: string, os: string = process.platform, run: Runner = defaultRunner, lookup: (pids: number[]) => Map<number, ProcessInfo> = lookupProcesses, home: string = homedir()): Desktop {
  if (os !== "darwin") return NOTHING;
  const script = async (source: string, args: string[]) => {
    const result = await run("/usr/bin/osascript", ["-e", source, ...args]);
    return result.ok && result.stdout.trim() === "found";
  };
  return {
    supported: true,
    async focusTmux(tmux, pane) {
      const socket = tmux.split(",")[0] ?? "";
      if (!socket.startsWith("/") || !TMUX_PANE.test(pane)) return false;
      const window = await run("tmux", ["-S", socket, "select-window", "-t", pane]);
      return window.ok && (await run("tmux", ["-S", socket, "select-pane", "-t", pane])).ok;
    },
    focusIterm: (uuid) => (ITERM_UUID.test(uuid) ? script(ITERM_FOCUS, [uuid]) : Promise.resolve(false)),
    focusTerminalTab: (tty) => (TTY.test(tty) ? script(TERMINAL_FOCUS, [tty]) : Promise.resolve(false)),
    async activateApp(bundle) {
      if (!bundle.startsWith("/") || !bundle.endsWith(".app")) return false;
      return (await run("/usr/bin/open", ["-a", bundle])).ok;
    },
    async openLink(url) {
      return APP_LINK.test(url) && (await run("/usr/bin/open", [url])).ok;
    },
    async openTerminal(app, cwd, argv, extras = {}) {
      if (extras.pidFile !== undefined && (!extras.pidFile.startsWith("/") || extras.pidFile.includes("\0"))) return false;
      mkdirSync(scriptsDir, { recursive: true, mode: 0o700 });
      // mkdir does not tighten a folder that already exists.
      chmodSync(scriptsDir, 0o700);
      const file = join(scriptsDir, `open-${randomBytes(8).toString("hex")}.command`);
      writeFileSync(file, resumeScript(cwd, argv, extras), { mode: 0o700 });
      chmodSync(file, 0o700);
      const ok = app === "iTerm" ? await script(ITERM_OPEN, [shellQuote(file)]) : (await run("/usr/bin/open", ["-a", "Terminal", file])).ok;
      // A script that never ran cannot remove itself.
      if (!ok) rmSync(file, { force: true });
      return ok;
    },
    async ttyOf(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const result = await run("/bin/ps", ["-o", "tty=", "-p", String(pid)]);
      const name = result.stdout.trim();
      return result.ok && /^ttys?\d{1,4}$/.test(name) ? `/dev/${name}` : null;
    },
    async focusEditorFolder(bundle, cwd) {
      const editor = Object.hasOwn(EDITORS, basename(bundle)) ? EDITORS[basename(bundle)]! : null;
      if (editor === null || !bundle.startsWith("/")) return false;
      const cli = join(bundle, "Contents", "Resources", "app", "bin", editor.cli);
      const state = join(home, "Library", "Application Support", editor.support, "User", "globalStorage", "storage.json");
      let text: string;
      try {
        text = readFileSync(state, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return false;
        throw error;
      }
      const folder = folderHolding(editorFolders(text), cwd);
      if (folder === null || !existsSync(cli)) return false;
      return (await run(cli, [folder])).ok;
    },
    appOf(pid) {
      let current = pid;
      for (let depth = 0; depth < 24 && current > 1; depth++) {
        const info = lookup([current]).get(current);
        if (info === undefined) return null;
        const bundle = bundleOf(info.command);
        if (bundle !== null) return bundle;
        current = info.ppid;
      }
      return null;
    },
  };
}
