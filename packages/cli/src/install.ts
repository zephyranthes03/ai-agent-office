// `agent-office install-hooks <agent>` / `uninstall-hooks <agent>`: adds our hook entries to the
// agent's own settings file, or removes them, after showing exactly what changes. It writes only
// after confirmation (or --yes), keeps a private backup next to the file, keeps the file's mode,
// indentation and line endings, and never changes an entry that is not ours. Installing also
// writes the launcher at the fixed path the entries name; uninstalling leaves the launcher.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { addHooks, installerFor, isOurHandler, removeHooks, reporterInstallerFor } from "@agent-office/adapters";
import type { HookEdit, HookEntry, Installer } from "@agent-office/adapters";
import { officeHome, pathsFor, writeAtomic } from "@agent-office/daemon";
import { planLauncher, stableNodePath, writeLauncher } from "./install-launcher.ts";
import type { InstallContext } from "./install-launcher.ts";
import { reporterStatus, runReporterInstall } from "./install-reporter.ts";

export { launcherScript, stableNodePath } from "./install-launcher.ts";
export type { InstallContext } from "./install-launcher.ts";

export type InstallRequest = { action: "install" | "uninstall"; agent: string; dryRun: boolean; yes: boolean };

export function systemContext(): InstallContext {
  return {
    env: process.env,
    userHome: homedir(),
    officeHome: officeHome(),
    nodePath: stableNodePath(process.execPath),
    nodeVersion: process.versions.node,
    hookEntry: join(import.meta.dirname, "..", "bin", "agent-office-hook.mjs"),
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    agentVersion: (command) => {
      const run = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 });
      return run.status === 0 ? run.stdout : null;
    },
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: async (question) => {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await prompt.question(question)).trim());
      } catch (error) {
        // Ctrl-C or Ctrl-D at the prompt: a no.
        if ((error as NodeJS.ErrnoException).code === "ABORT_ERR") return false;
        throw error;
      } finally {
        prompt.close();
      }
    },
    out: (text) => process.stdout.write(text),
    now: Date.now,
  };
}

/** What the agent's settings file holds now. */
type SettingsFile = {
  /** The path the agent reads. */
  path: string;
  /** Where writes go: the file itself, or the target when `path` is a symbolic link. */
  target: string;
  text: string | null;
  value: unknown;
  mode: number;
};

/** The file a settings path leads to, and its text (null when there is none). */
function locate(path: string): { target: string; text: string | null } | { problem: string } {
  let target = path;
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    if (!existsSync(path)) return { problem: `${path} is a symbolic link to a file that does not exist` };
    target = realpathSync(path);
  }
  const stat = statSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return { target, text: null };
  if (!stat.isFile()) return { problem: `${path} is not a file` };
  return { target, text: readFileSync(target, "utf8") };
}

/** Where JSON.parse found the error, when it says, without the file text V8 may quote (it can hold secrets). */
function whereIn(error: SyntaxError): string {
  const where = /line \d+ column \d+/.exec(error.message)?.[0] ?? /position \d+/.exec(error.message)?.[0];
  return where === undefined ? "" : ` (at ${where})`;
}

/**
 * The agent's hooks file. `absent` marks the one problem that only means the agent is not set up
 * here; `exact: false` (reading, not saving back) accepts integers past 2^53.
 */
function readSettings(installer: Installer, ctx: Pick<InstallContext, "env" | "userHome">, { exact = true } = {}): SettingsFile | { problem: string; absent?: true } {
  const dir = ctx.env[installer.configDirEnv] || join(ctx.userHome, installer.defaultConfigDir);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return { problem: `${dir} is not a folder; is ${installer.agent} installed? (${installer.configDirEnv} is honoured)`, absent: true };
  const path = join(dir, installer.hooksFile);
  const found = locate(path);
  if ("problem" in found) return found;
  const { target, text } = found;
  if (text === null) return { path, target, text, value: {}, mode: 0o600 };
  let value: unknown = {};
  let inexact = false;
  if (text.trim() !== "") {
    try {
      // An integer beyond 2^53 would be saved back as a different number.
      value = JSON.parse(text, (_key, parsed: unknown, context?: { source?: string }) => {
        if (typeof parsed === "number" && !Number.isSafeInteger(parsed) && /^-?\d+$/.test(context?.source ?? "")) inexact = true;
        return parsed;
      });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { problem: `${path} is not valid JSON${whereIn(error)}; nothing was changed` };
    }
  }
  if (inexact && exact) return { problem: `${path} holds an integer too large to save back exactly; nothing was changed` };
  return { path, target, text, value, mode: statSync(target).mode & 0o777 };
}

/** The new file text, laid out like the old one: its indentation (or none, if it was one line) and line endings. */
function serialise(value: unknown, old: string | null): string {
  const blank = old === null || old.trim() === "";
  const oneLine = !blank && !old.trimEnd().includes("\n");
  const indent = old?.match(/\n([ \t]+)["}\]]/)?.[1] ?? "  ";
  const text = `${oneLine ? JSON.stringify(value) : JSON.stringify(value, null, indent)}${blank || /\n$/.test(old) ? "\n" : ""}`;
  // JSON.stringify escapes newlines inside strings, so every "\n" here is a line break.
  return !blank && old.includes("\r\n") ? text.replaceAll("\n", "\r\n") : text;
}

/** Changes as `+`/`-` lines, each distinct handler once with the events it is for. */
function describe(sign: string, entries: HookEntry[]): string {
  const byHandler = new Map<string, string[]>();
  for (const { event, handler } of entries) {
    const key = JSON.stringify(handler);
    byHandler.set(key, [...(byHandler.get(key) ?? []), event]);
  }
  return [...byHandler].map(([handler, events]) => `  ${sign} ${handler}\n      for ${events.join(", ")}\n`).join("");
}

/** How many of an agent's subscribed events have our handler, read-only (`agent-office doctor`). */
export function hookStatus(agent: string, ctx: Pick<InstallContext, "env" | "userHome">): { path: string; installed: number; expected: number } | { problem: string; absent?: true } {
  const reporter = reporterInstallerFor(agent);
  if (reporter !== undefined) return reporterStatus(reporter, ctx);
  const installer = installerFor(agent);
  if (installer === undefined) return { problem: `no adapter for ${agent}` };
  const settings = readSettings(installer, ctx, { exact: false });
  if ("problem" in settings) return settings;
  const expected = installer.entries("/agent-office-hook").map((entry) => entry.event);
  const hooks = (settings.value as { hooks?: Record<string, unknown> } | null)?.hooks;
  const groups = hooks !== null && typeof hooks === "object" ? hooks : {};
  const installed = expected.filter((event) => {
    const list = (groups as Record<string, unknown>)[event];
    return Array.isArray(list) && list.some((group) => Array.isArray((group as { hooks?: unknown })?.hooks) && ((group as { hooks: unknown[] }).hooks).some(isOurHandler));
  }).length;
  return { path: settings.path, installed, expected: expected.length };
}

export async function runInstall(request: InstallRequest, ctx: InstallContext): Promise<number> {
  const reporter = reporterInstallerFor(request.agent);
  if (reporter !== undefined) return runReporterInstall(request, reporter, ctx);
  const installer = installerFor(request.agent);
  if (installer === undefined) {
    ctx.out(`unknown agent ${JSON.stringify(request.agent)}; expected claude-code, codex, opencode or pi\n`);
    return 2;
  }
  const refuse = (reason: string) => {
    ctx.out(`Not ${request.action}ed: ${reason}\n`);
    return 1;
  };
  const paths = pathsFor(ctx.officeHome);
  const plan = planLauncher(request.action, ctx, installer.launcherProblem);
  if ("problem" in plan) return refuse(plan.problem);
  const { launcher, script, state: launcherState } = plan;

  const settings = readSettings(installer, ctx);
  if ("problem" in settings) return refuse(settings.problem);
  if (request.action === "uninstall" && settings.text === null) {
    ctx.out(`${settings.path} does not exist; no agent-office hooks to remove\n`);
    return 0;
  }
  const edit: HookEdit = request.action === "install" ? addHooks(settings.value, installer.entries(launcher)) : removeHooks(settings.value);
  if ("problem" in edit) return refuse(`${settings.path}: ${edit.problem}; nothing was changed`);
  const settingsChange = edit.added.length + edit.removed.length > 0;

  if (!settingsChange && launcherState === "unchanged") {
    ctx.out(request.action === "install" ? `${installer.agent}: agent-office hooks are already installed in ${settings.path}\n` : `${installer.agent}: no agent-office hooks in ${settings.path}\n`);
    return 0;
  }
  const backup = settingsChange && settings.text !== null ? `${settings.path}.agent-office-backup-${ctx.now()}` : null;
  ctx.out(`${installer.agent} hook settings: ${settings.path}${settings.target === settings.path ? "" : ` (link to ${settings.target})`}${settings.text === null ? " (new file)" : ""}\n`);
  if (!settingsChange) ctx.out("  no changes\n");
  ctx.out(describe("-", edit.removed));
  ctx.out(describe("+", edit.added));
  if (backup !== null) ctx.out(`  backup first (private copy): ${backup}\n`);
  if (script !== null) ctx.out(`Launcher ${launcher} (${launcherState}): runs ${ctx.nodePath} ${ctx.hookEntry}\n`);
  if (request.action === "uninstall") ctx.out(`The launcher ${launcher} stays; it does nothing unless an agent runs it.\n`);

  if (request.dryRun) return 0;
  if (!request.yes) {
    if (!ctx.interactive) return refuse("no terminal to confirm in; run again with --yes to apply, or with --dry-run to only show this");
    if (!(await ctx.ask("Apply these changes? [y/N] "))) return refuse("not confirmed");
  }

  try {
    // Nothing is written when the file moved or changed while the question was open.
    const now = locate(settings.path);
    if ("problem" in now || now.target !== settings.target || now.text !== settings.text) return refuse(`${settings.path} changed while waiting for confirmation; run again to see the new changes`);
    const launcherProblem = writeLauncher(plan, ctx);
    if (launcherProblem !== null) return refuse(launcherProblem);
    if (settingsChange) {
      // The backup may hold secrets (env, apiKeyHelper) and sits outside any folder the file was protected by.
      if (settings.text !== null && backup !== null) writeFileSync(backup, settings.text, { mode: 0o600, flag: "wx" });
      writeAtomic(settings.target, serialise(edit.next, settings.text), settings.mode);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined) throw error;
    return refuse(`could not write ${(error as NodeJS.ErrnoException).path ?? "a file"} (${code}); the settings file was not changed`);
  }
  if (request.action === "install") {
    ctx.out(`Installed. ${installer.afterInstall}\n`);
    ctx.out(`Hooks deliver to the daemon (agent-office daemon); while it is not running they wait in ${paths.spool} for it.\n`);
  } else {
    ctx.out(`Removed ${edit.removed.length} agent-office hook entr${edit.removed.length === 1 ? "y" : "ies"}.\n`);
  }
  return 0;
}
