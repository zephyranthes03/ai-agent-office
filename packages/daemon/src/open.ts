// "Open session" (docs/notifications.md, focus order): take the user to where an agent runs, or open
// an ended session again. It only brings a window forward or starts the agent's own resume command
// in a new window; it never types into a session, approves or answers anything. Which means are
// tried comes from the adapter's descriptor (`open`, `open_cli`) and the facts the hooks reported
// (terminal identity, process, working folder); `planOpen` is pure, `openSession` runs the plan
// through the platform's desktop actions and stops at the first that works, and `SessionOpener`
// decides which session to open and when an open must wait.
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { descriptors } from "@agent-office/adapters";
import { ITERM_UUID, shellQuote } from "@agent-office/platform";
import type { Desktop, TerminalApp } from "@agent-office/platform";
import type { Launcher, Snapshot, Snapshots } from "@agent-office/core";
import type { SessionInfo } from "./store.ts";

export type OpenFacts = {
  session: string;
  agent: string;
  /** The session is active (its process is not known to be gone). */
  active: boolean;
  pid: number | null;
  cwd: string | null;
  terminal: Record<string, unknown> | null;
  /** The agent's own app link to this conversation, when it runs in that app and the link is known. */
  link?: string | null;
};

export type Attempt =
  | { means: "tmux"; tmux: string; pane: string }
  | { means: "iterm"; uuid: string }
  | { means: "terminal_tab" }
  /** The window of a VS Code-like editor that has the session's folder open. */
  | { means: "editor_window"; cwd: string }
  | { means: "app" }
  | { means: "link"; url: string }
  | { means: "resume"; app: TerminalApp; cwd: string; argv: string[] };

/** `means` is what worked (null: nothing); `command` is what the user can run by hand, when there is one. */
export type OpenResult = { means: Attempt["means"] | null; reason: "unsupported" | "ssh" | "not_found" | null; command: string | null };

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type OpenDescriptor = { open: readonly string[]; open_cli?: { command: string; args: readonly string[] } };

function descriptorOf(agent: string): OpenDescriptor | null {
  return Object.hasOwn(descriptors, agent) ? (descriptors[agent as keyof typeof descriptors] as OpenDescriptor) : null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** A working folder the hooks reported is used only as an absolute path without NUL. */
const usableCwd = (cwd: string | null): string | null => (cwd !== null && isAbsolute(cwd) && !cwd.includes("\0") ? cwd : null);

/** The resume command's words, or null when the descriptor has none or a value does not fit. */
export function resumeArgv(facts: OpenFacts): string[] | null {
  const cli = descriptorOf(facts.agent)?.open_cli;
  const cwd = usableCwd(facts.cwd);
  if (cli === undefined || !SESSION_ID.test(facts.session)) return null;
  const words: string[] = [cli.command];
  for (const arg of cli.args) {
    if (arg.includes("{cwd}") && cwd === null) return null;
    words.push(arg.replaceAll("{session}", facts.session).replaceAll("{cwd}", cwd ?? ""));
  }
  return words;
}

/** What to try, in order, for a top-level session. */
export function planOpen(facts: OpenFacts): Attempt[] {
  const descriptor = descriptorOf(facts.agent);
  if (descriptor === null) return [];
  const terminal = facts.terminal ?? {};
  const cwd = usableCwd(facts.cwd);
  const attempts: Attempt[] = [];
  if (facts.active && descriptor.open.includes("focus_window") && terminal["ssh"] !== true) {
    // The conversation itself in its app, before the app alone.
    if (facts.link) attempts.push({ means: "link", url: facts.link });
    const tmux = text(terminal["TMUX"]);
    const pane = text(terminal["TMUX_PANE"]);
    if (tmux !== null && pane !== null) attempts.push({ means: "tmux", tmux, pane });
    const uuid = text(terminal["ITERM_SESSION_ID"])?.split(":").pop() ?? null;
    if (uuid !== null && ITERM_UUID.test(uuid)) attempts.push({ means: "iterm", uuid });
    if (facts.pid !== null && text(terminal["TERM_PROGRAM"]) === "Apple_Terminal") attempts.push({ means: "terminal_tab" });
    // An editor has one process for all its windows (`VSCODE_PID` is the same in each): the window
    // is found by the session's folder, before the app alone.
    if (facts.pid !== null && text(terminal["VSCODE_PID"]) !== null && cwd !== null) attempts.push({ means: "editor_window", cwd });
    if (facts.pid !== null) attempts.push({ means: "app" });
  }
  // A session whose process is gone is opened again; a running one never is (two copies would conflict).
  const argv = resumeArgv(facts);
  if (!facts.active && descriptor.open.includes("cli") && terminal["ssh"] !== true && argv !== null && cwd !== null) {
    attempts.push({ means: "resume", app: text(terminal["TERM_PROGRAM"]) === "iTerm.app" ? "iTerm" : "Terminal", cwd, argv });
  }
  return attempts;
}

/** What to run by hand: change to the folder (when known), then resume. */
export function manualCommand(facts: OpenFacts): string | null {
  const argv = resumeArgv(facts);
  if (argv === null) return null;
  // Words are left bare only when no shell gives them a meaning (zsh expands a leading `=`).
  const quote = (word: string) => (/^[A-Za-z0-9._/@%+-][A-Za-z0-9._/:=@%+-]*$/.test(word) ? word : shellQuote(word));
  const run = argv.map(quote).join(" ");
  const cwd = usableCwd(facts.cwd);
  return cwd === null ? run : `cd ${quote(cwd)} && ${run}`;
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw error;
  }
};

/** Tries the plan until one means works. */
export async function openSession(facts: OpenFacts, desktop: Desktop): Promise<OpenResult> {
  const ssh = facts.terminal?.["ssh"] === true;
  const fallback = (reason: OpenResult["reason"]): OpenResult => ({ means: null, reason, command: facts.active && !ssh ? null : manualCommand(facts) });
  if (ssh) return fallback("ssh");
  if (!desktop.supported) return fallback("unsupported");
  for (const attempt of planOpen(facts)) {
    let ok: boolean;
    if (attempt.means === "tmux") {
      ok = await desktop.focusTmux(attempt.tmux, attempt.pane);
      const app = ok && facts.pid !== null ? desktop.appOf(facts.pid) : null;
      if (app !== null) await desktop.activateApp(app);
    } else if (attempt.means === "iterm") ok = await desktop.focusIterm(attempt.uuid);
    else if (attempt.means === "terminal_tab") {
      const tty = facts.pid === null ? null : await desktop.ttyOf(facts.pid);
      ok = tty !== null && (await desktop.focusTerminalTab(tty));
    } else if (attempt.means === "link") ok = await desktop.openLink(attempt.url);
    else if (attempt.means === "editor_window") {
      const app = facts.pid === null ? null : desktop.appOf(facts.pid);
      ok = app !== null && isDirectory(attempt.cwd) && (await desktop.focusEditorFolder(app, attempt.cwd));
    } else if (attempt.means === "app") {
      const app = facts.pid === null ? null : desktop.appOf(facts.pid);
      ok = app !== null && (await desktop.activateApp(app));
    } else ok = isDirectory(attempt.cwd) && (await desktop.openTerminal(attempt.app, attempt.cwd, attempt.argv));
    if (ok) return { means: attempt.means, reason: null, command: null };
  }
  return fallback("not_found");
}

/**
 * The top-level session of `id`: up its parents, at most eight steps; a parent the daemon no longer
 * knows ends the walk where it is. Undefined for an id it does not know.
 */
export function topSession(snapshots: Snapshots, id: string): Snapshot | undefined {
  let top = snapshots[id];
  for (let depth = 0; top?.parent && depth < 8; depth++) top = snapshots[top.parent] ?? top;
  return top;
}

/** A resumed session is not resumed again for this long, unless its new process reports first. */
export const RESUME_HOLD_MS = 60_000;

export type OpenerDeps = {
  snapshots: () => Snapshots;
  infoOf: (id: string) => SessionInfo | undefined;
  /** Whether a thread is one the agent's app runs for itself: the app has nothing to open for it. */
  isInternal: (id: string) => boolean;
  /** The agent's own app link to a conversation (app-links.ts); it may throw when the app's records cannot be read. */
  appLink: (agent: string, launcher: Launcher | null, session: string) => string | null;
  desktop: Desktop;
  now: () => number;
  log: (line: string) => void;
};

/**
 * "Open session" for the API and notification clicks: the top-level session's facts, one open per
 * session at a time. A resumed session stays "ended" until its new process sends a hook; until then
 * (or for RESUME_HOLD_MS) it is not resumed again, so a notification click and the card's button
 * cannot start two.
 */
export class SessionOpener {
  private readonly deps: OpenerDeps;
  private readonly opening = new Set<string>();
  private readonly resumedAt = new Map<string, number>();

  constructor(deps: OpenerDeps) {
    this.deps = deps;
  }

  /** "unknown": no such session; "busy": an open of it still runs, or it was resumed just now. */
  async open(id: string): Promise<OpenResult | "unknown" | "busy"> {
    const { now, log } = this.deps;
    const top = topSession(this.deps.snapshots(), id);
    if (top === undefined) return "unknown";
    if (this.opening.has(top.session)) return "busy";
    const resumed = this.resumedAt.get(top.session);
    if (top.lifecycle === "active" || (resumed !== undefined && now() - resumed >= RESUME_HOLD_MS)) this.resumedAt.delete(top.session);
    else if (resumed !== undefined) return "busy";
    this.opening.add(top.session);
    try {
      const info = this.deps.infoOf(top.session);
      const known = info?.pidConfidence === "exact" || info?.pidConfidence === "ancestor";
      const active = top.lifecycle === "active";
      let link: string | null = null;
      try {
        // No link to a thread the app does not list: the app has nothing to open and says so.
        link = active && !this.deps.isInternal(top.session) ? this.deps.appLink(top.agent, info?.launcher ?? null, top.session) : null;
      } catch (error) {
        // The app's own records could not be read: the app is still brought forward without the link.
        log(`app_link_unreadable ${(error as NodeJS.ErrnoException).code ?? (error as Error).name}`);
      }
      const result = await openSession({ session: top.session, agent: top.agent, active, pid: known ? (info?.pid ?? null) : null, cwd: info?.cwd ?? null, terminal: info?.terminal ?? null, link }, this.deps.desktop);
      if (result.means === "resume") this.resumedAt.set(top.session, now());
      return result;
    } finally {
      this.opening.delete(top.session);
    }
  }
}
