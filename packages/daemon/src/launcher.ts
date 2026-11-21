// The hook launcher as the daemon and `doctor` see it: the Node and program it was written to run,
// and the two signs the launcher leaves in logs/ (it prints nothing, so these are all there is):
// `launcher-target-missing` when nothing could run the hook, `launcher-fallback-node` when a Node
// from the agent's PATH ran it instead of the one it was installed with.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./files.ts";

/** The values our launcher script fixes (it is ours: `name='value'` lines with shell quoting). */
export function launcherTargets(script: string): { node: string | null; entry: string | null } {
  const value = (name: string) => {
    const match = new RegExp(`^${name}='((?:[^']|'\\\\'')*)'$`, "m").exec(script);
    return match ? match[1]!.replaceAll("'\\''", "'") : null;
  };
  return { node: value("node"), entry: value("entry") };
}

export const launcherPath = (paths: Paths): string => join(paths.bin, "agent-office-hook");
export const MISSING_MARKER = "launcher-target-missing";
export const FALLBACK_MARKER = "launcher-fallback-node";

import type { HookWarning } from "@agent-office/core";
export type { HookWarning };

/** `lastSignalMs`: when the last signal from any hook was observed, null when none ever was. */
export function hookWarning(paths: Paths, lastSignalMs: number | null): HookWarning | null {
  const marker = statSync(join(paths.logs, MISSING_MARKER), { throwIfNoEntry: false });
  if (marker !== undefined && (lastSignalMs === null || marker.mtimeMs > lastSignalMs)) return { code: "hooks-not-delivered", since: marker.mtime.toISOString() };
  const launcher = launcherPath(paths);
  if (!existsSync(launcher)) return null;
  const { node, entry } = launcherTargets(readFileSync(launcher, "utf8"));
  // A launcher that is not ours is doctor's business, not a warning on every screen.
  if (node === null || entry === null) return null;
  if (!existsSync(node) || !existsSync(entry)) return { code: "launcher-target-missing", since: marker?.mtime.toISOString() ?? null };
  return null;
}
