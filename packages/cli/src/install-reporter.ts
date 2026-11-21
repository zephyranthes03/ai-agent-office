// `install-hooks` for an agent that loads plugin files from a folder: one file of ours is placed
// there, after showing it, and no settings file is touched. Only a file that carries our marker is
// ever replaced or removed.
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { composeReporter, isOurReporter, REPORTER_FILE } from "@agent-office/adapters";
import type { ReporterInstaller } from "@agent-office/adapters";
import { pathsFor, writeAtomic } from "@agent-office/daemon";
import { planLauncher, writeLauncher } from "./install-launcher.ts";
import type { InstallContext } from "./install-launcher.ts";

const ADAPTERS = join(import.meta.dirname, "..", "..", "adapters");

type Request = { action: "install" | "uninstall"; agent: string; dryRun: boolean; yes: boolean };
type Found = { path: string; text: string | null } | { problem: string; absent?: true };

/** Where the reporter goes and what is there now; `absent` means the agent is not set up on this machine. */
function findReporter(installer: ReporterInstaller, ctx: Pick<InstallContext, "env" | "userHome">): Found {
  const dir = installer.configDir(ctx.env, ctx.userHome);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return { problem: `${dir} is not a folder; is ${installer.agent} installed?`, absent: true };
  const path = join(dir, installer.folder, REPORTER_FILE);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return { path, text: null };
  if (!stat.isFile()) return { problem: `${path} is not a plain file; nothing was changed` };
  const text = readFileSync(path, "utf8");
  return isOurReporter(text) ? { path, text } : { problem: `${path} exists and was not written by agent-office; nothing was changed` };
}

/** Whether our file is in place, in the terms `doctor` reports for hook settings. */
export function reporterStatus(installer: ReporterInstaller, ctx: Pick<InstallContext, "env" | "userHome">): { path: string; installed: number; expected: number } | { problem: string; absent?: true } {
  const found = findReporter(installer, ctx);
  return "problem" in found ? found : { path: found.path, installed: found.text === null ? 0 : 1, expected: 1 };
}

/** Why the installed agent cannot load the file; null when it can. */
function versionProblem(installer: ReporterInstaller, ctx: InstallContext): string | null {
  if (installer.minVersion === undefined) return null;
  const { command, major } = installer.minVersion;
  const found = /(\d+)\.\d+/.exec(ctx.agentVersion(command) ?? "");
  if (found === null) return `could not read the version of ${command}, and the file needs ${major}.0 or later`;
  return Number(found[1]) < major ? `${command} ${found[0]} is older than ${major}.0, which this file needs` : null;
}

export async function runReporterInstall(request: Request, installer: ReporterInstaller, ctx: InstallContext): Promise<number> {
  const refuse = (reason: string) => {
    ctx.out(`Not ${request.action}ed: ${reason}\n`);
    return 1;
  };
  const found = findReporter(installer, ctx);
  if ("problem" in found) return refuse(found.problem);
  const plan = planLauncher(request.action, ctx, () => null);
  if ("problem" in plan) return refuse(plan.problem);
  if (request.action === "uninstall" && found.text === null) {
    ctx.out(`${installer.agent}: no agent-office reporter at ${found.path}\n`);
    return 0;
  }
  const problem = request.action === "install" ? versionProblem(installer, ctx) : null;
  if (problem !== null) return refuse(problem);

  const [runtime, part] = installer.sources.map((source) => readFileSync(join(ADAPTERS, source), "utf8")) as [string, string];
  const wanted = request.action === "install" ? composeReporter(runtime, part, plan.launcher) : null;
  if (wanted === found.text && plan.state === "unchanged") {
    ctx.out(`${installer.agent}: the agent-office reporter is already installed at ${found.path}\n`);
    return 0;
  }
  ctx.out(`${installer.agent} reporter: ${found.path} (${wanted === null ? "remove" : found.text === null ? "new file" : wanted === found.text ? "unchanged" : "replace our older file"})\n`);
  if (wanted !== null) {
    ctx.out(`  sends event names, tool names, the session id and folder to ${plan.launcher}; no settings file is changed\n`);
    if (plan.state !== "unchanged") ctx.out(`Launcher ${plan.launcher} (${plan.state}): runs ${ctx.nodePath} ${ctx.hookEntry}\n`);
  } else {
    ctx.out(`The launcher ${plan.launcher} stays; it does nothing unless an agent runs it.\n`);
  }

  if (request.dryRun) return 0;
  if (!request.yes) {
    if (!ctx.interactive) return refuse("no terminal to confirm in; run again with --yes to apply, or with --dry-run to only show this");
    if (!(await ctx.ask("Apply these changes? [y/N] "))) return refuse("not confirmed");
  }

  try {
    // Nothing is written when the file changed while the question was open.
    const now = findReporter(installer, ctx);
    if ("problem" in now || now.text !== found.text) return refuse(`${found.path} changed while waiting for confirmation; run again to see the new changes`);
    if (wanted === null) {
      rmSync(found.path);
      ctx.out(`Removed ${found.path}.\n`);
      return 0;
    }
    const launcherProblem = writeLauncher(plan, ctx);
    if (launcherProblem !== null) return refuse(launcherProblem);
    if (wanted !== found.text) {
      mkdirSync(dirname(found.path), { recursive: true });
      writeAtomic(found.path, wanted, 0o600);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined) throw error;
    return refuse(`could not write ${(error as NodeJS.ErrnoException).path ?? "a file"} (${code})`);
  }
  ctx.out(`Installed. ${installer.afterInstall}\n`);
  ctx.out(`Reports reach the daemon (agent-office daemon); while it is not running they wait in ${pathsFor(ctx.officeHome).spool} for it.\n`);
  return 0;
}
