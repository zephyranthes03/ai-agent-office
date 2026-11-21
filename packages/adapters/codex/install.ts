// Our hook entries in Codex's user hooks file (~/.codex/hooks.json, or CODEX_HOME). Codex takes a
// command string (no args), so the launcher path must need no quoting; SessionEnd and Interrupt
// hooks may take at most 3 s. Codex runs a new or changed hook only after the user trusts it.
import descriptor from "./descriptor.json" with { type: "json" };
import type { Installer } from "../install-common.ts";

/** Codex caps these events' hook timeout at 3 s (and warns about a longer one). */
const SHORT_EVENTS = new Set(["SessionEnd", "Interrupt"]);
/** An absolute POSIX path that no shell would split or expand. */
const PLAIN_PATH = /^\/[A-Za-z0-9_./+-]+$/;

export const codexInstaller: Installer = {
  agent: "codex",
  configDirEnv: "CODEX_HOME",
  defaultConfigDir: ".codex",
  hooksFile: "hooks.json",
  afterInstall: "Codex skips new hooks until you trust them: open Codex, run /hooks and trust the agent-office-hook entries. config.toml is not read or changed.",
  launcherProblem: (launcher) =>
    PLAIN_PATH.test(launcher) ? null : `the hook path ${JSON.stringify(launcher)} has characters other than ASCII letters, digits and ._+-/, and Codex takes the hook as one command string, which may go through a shell; set AGENT_OFFICE_HOME to such a path`,
  entries: (launcher) =>
    descriptor.hook_events.map((event) => ({ event, handler: { type: "command", command: `${launcher} codex`, timeout: SHORT_EVENTS.has(event) ? 3 : 5 } })),
};
