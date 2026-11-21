// Draining the hooks' spool (`spool/<agent>.jsonl` and its overflow `.1`). A file is renamed to
// `.draining-<epoch ms>` first, so hooks start a new one; it is read and deleted only after a
// grace period, because a hook that opened the file just before the rename may still append to
// it (a hook lives at most 2 s). Files left over from a crash are read on the next pass. A file
// that cannot be drained (not a regular file, too large, unreadable) is renamed to `.bad` so it
// never blocks the files after it.
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LIVE = /^([a-z0-9][a-z0-9-]{0,63})\.jsonl(\.1)?$/;
const DRAINING = /^([a-z0-9][a-z0-9-]{0,63})\.jsonl(\.1)?\.draining-(\d+)$/;
/** Hooks rotate at 5 MiB; a drained file larger than this was not written by them. */
const DRAIN_MAX = 16 * 1024 * 1024;

/** Moves the live spool files aside for a later drain. */
export function rotateSpool(dir: string, nowMs: number): void {
  for (const name of readdirSync(dir)) {
    if (!LIVE.test(name)) continue;
    try {
      renameSync(join(dir, name), join(dir, `${name}.draining-${nowMs}`));
    } catch (error) {
      // A hook rotating `.jsonl` to `.1` at the same moment can make the name vanish; the next pass sees it.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export type Drain = { file: string; agent: string; lines: unknown[]; badLines: number };
export type DrainResult = { drains: Drain[]; quarantined: { file: string; reason: string }[] };

/** The drained files whose grace period is over, oldest first, with their parsed lines. */
export function readyDrains(dir: string, nowMs: number, graceMs: number): DrainResult {
  const ready: { file: string; agent: string; ms: number; overflow: boolean }[] = [];
  for (const name of readdirSync(dir)) {
    const match = DRAINING.exec(name);
    if (!match) continue;
    const ms = Number(match[3]);
    if (nowMs - ms >= graceMs) ready.push({ file: join(dir, name), agent: match[1]!, ms, overflow: match[2] !== undefined });
  }
  ready.sort((a, b) => a.ms - b.ms || Number(b.overflow) - Number(a.overflow));
  const drains: Drain[] = [];
  const quarantined: DrainResult["quarantined"] = [];
  for (const { file, agent } of ready) {
    let text: string | null = null;
    let reason = unreadable(file);
    if (reason === null) {
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        reason = `read_${(error as NodeJS.ErrnoException).code ?? "error"}`;
      }
    }
    if (text === null) {
      renameSync(file, `${file}.bad`);
      quarantined.push({ file, reason: reason ?? "unreadable" });
      continue;
    }
    const lines: unknown[] = [];
    let badLines = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        lines.push(JSON.parse(line));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        badLines++;
      }
    }
    drains.push({ file, agent, lines, badLines });
  }
  return { drains, quarantined };
}

/** Why a drain file cannot be read, or null when it can. */
function unreadable(file: string): string | null {
  const stat = lstatSync(file);
  if (!stat.isFile()) return "not_a_regular_file";
  if (stat.size > DRAIN_MAX) return "too_large";
  return null;
}

export function removeDrain(file: string): void {
  unlinkSync(file);
}

const QUARANTINED = /\.draining-(\d+)\.bad$/;

/** Deletes quarantined spool files older than `days` (their name carries the drain time). */
export function removeOldQuarantine(dir: string, nowMs: number, days: number): void {
  for (const name of readdirSync(dir)) {
    const match = QUARANTINED.exec(name);
    if (match && nowMs - Number(match[1]) > days * 86_400_000) rmSync(join(dir, name), { recursive: true, force: true });
  }
}
