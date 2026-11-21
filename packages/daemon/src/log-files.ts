// Finding and reading the agents' own log files, read-only: where the agents keep their state, the
// Claude Code transcripts and Codex rollouts by their folder layout (links are not followed), and
// reads with a byte cap that keep whole lines (a file's tail, a forward read from a cursor, its head).
// Used by the usage collector (usage.ts) and the transcript watch.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import { codexTurnMeta, transcriptMeta } from "@agent-office/adapters";
import type { CodexTurnMeta, TranscriptMeta } from "@agent-office/adapters";

/** Byte cap of a file's first read (the adapters' session-log strategies). */
export const TAIL_BYTES = 1024 * 1024;
/** A session id that can be a file name: no separators, no dots, so never `..`. */
export const SESSION_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Where the agents keep their own state: CLAUDE_CONFIG_DIR / CODEX_HOME, else the defaults. */
export type AgentHomes = { claude: string; codex: string };

export function agentHomes(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): AgentHomes {
  return { claude: env["CLAUDE_CONFIG_DIR"] || join(home, ".claude"), codex: env["CODEX_HOME"] || join(home, ".codex") };
}

/** The tail the transcript-metadata strategy reads (claude-code adapter, strategy 2). */
const META_TAIL_BYTES = 64 * 1024;

/**
 * The transcript metadata of the file a Claude Code hook named, or null. The path comes from a hook
 * envelope, so it is used only when it is a regular `.jsonl` file that really lies inside the
 * agent's `projects` folder; anything else is not opened.
 */
export function readTranscriptMeta(homes: AgentHomes, path: string): TranscriptMeta | null {
  if (!isAbsolute(path) || !path.endsWith(".jsonl")) return null;
  const projects = join(homes.claude, "projects");
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile() || !existsSync(projects)) return null;
  const real = realpathSync(path);
  if (!real.startsWith(realpathSync(projects) + sep)) return null;
  return transcriptMeta(readTail(real, META_TAIL_BYTES).text);
}

/**
 * The turn settings of the rollout a Codex hook named, or null, under the same rules: only a regular
 * `.jsonl` file that really lies inside the agent's `sessions` folder is opened. The tail is the
 * session-log strategy's 1 MiB: a turn's context line precedes everything the turn wrote.
 */
export function readCodexTurnMeta(homes: AgentHomes, path: string): CodexTurnMeta | null {
  if (!isAbsolute(path) || !path.endsWith(".jsonl")) return null;
  const sessions = join(homes.codex, "sessions");
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile() || !existsSync(sessions)) return null;
  const real = realpathSync(path);
  if (!real.startsWith(realpathSync(sessions) + sep)) return null;
  return codexTurnMeta(readTail(real, TAIL_BYTES).text);
}

/**
 * Opens a log file for reading: never through a symbolic link, never blocking on a FIFO, and only
 * when it is a regular file (`ENOTREG` otherwise), so a planted special file cannot stall the daemon.
 */
function openLog(file: string): { fd: number; size: number; mtimeMs: number } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw Object.assign(new Error(`not a regular file: ${basename(file)}`), { code: "ENOTREG" });
  }
  return { fd, size: stat.size, mtimeMs: stat.mtimeMs };
}

function readAt(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, start + read);
    if (n === 0) break;
    read += n;
  }
  return buffer.subarray(0, read);
}

/** Whole lines only: the bytes up to the last newline. */
const wholeLines = (bytes: Buffer): Buffer => bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);

/**
 * The last `max` bytes of a file, whole lines only: a cut first line and an unfinished last line are
 * left out. `end` is the byte after the last whole line, where a forward read continues.
 */
export function readTail(file: string, max: number): { text: string; fromStart: boolean; mtimeMs: number; size: number; end: number; cut: boolean } {
  const { fd, size, mtimeMs } = openLog(file);
  try {
    // One byte more than the cap, so a cut that falls exactly on a line start keeps that line.
    const start = Math.max(0, size - max - 1);
    let bytes = readAt(fd, start, size - start);
    const skipped = start > 0 ? bytes.indexOf(0x0a) + 1 : 0;
    bytes = wholeLines(bytes.subarray(skipped));
    // No line starts inside the window: `end` is still inside the cut line, which a forward read skips.
    return { text: bytes.toString("utf8"), fromStart: start === 0, mtimeMs, size, end: start + skipped + bytes.length, cut: start > 0 && skipped === 0 };
  } finally {
    closeSync(fd);
  }
}

export type ForwardRead = { text: string; next: number; cut: boolean; capped: boolean; size: number; mtimeMs: number };

/**
 * Whole lines from byte `from`, at most `max` bytes. `next` is where the next read starts, `capped`
 * whether more of the file is waiting. When `cut`, the read starts inside a line and skips to the
 * next one; a single line longer than `max` is skipped that way.
 */
export function readForward(file: string, from: number, max: number, cut: boolean): ForwardRead {
  const { fd, size, mtimeMs } = openLog(file);
  try {
    const raw = readAt(fd, from, Math.max(0, Math.min(size - from, max)));
    const capped = size - from > max;
    const skip = cut ? raw.indexOf(0x0a) + 1 : 0;
    const bytes = wholeLines(raw.subarray(skip));
    // The window holds no line start (still inside a cut line), or one line fills all of it.
    if (skip === 0 && bytes.length === 0 && (cut || capped)) return { text: "", next: from + raw.length, cut: true, capped, size, mtimeMs };
    return { text: bytes.toString("utf8"), next: from + skip + bytes.length, cut: false, capped, size, mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** The first line of a file (a rollout's session_meta), read with its own small cap. */
export function readHead(file: string): string {
  const { fd } = openLog(file);
  try {
    const text = readAt(fd, 0, 64 * 1024).toString("utf8");
    const end = text.indexOf("\n");
    return end < 0 ? "" : text.slice(0, end + 1);
  } finally {
    closeSync(fd);
  }
}

export type FoundFile = { file: string; mtimeMs: number; size: number };

/** Told the error code of each folder that could not be listed (then skipped); without it, the error is thrown. */
export type Unlisted = (code: string) => void;

/** The entries of a folder; none when it does not exist. */
function entries(dir: string, unlisted: Unlisted | undefined): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    if (unlisted === undefined || typeof code !== "string") throw error;
    unlisted(code);
    return [];
  }
}

/** Regular files only (directory entries are not followed through links); a file gone since the listing is left out. */
function found(dir: string, names: Dirent[], match: (name: string) => boolean): FoundFile[] {
  return names.flatMap((entry) => {
    if (!entry.isFile() || !match(entry.name)) return [];
    const file = join(dir, entry.name);
    const stat = statSync(file, { throwIfNoEntry: false });
    return stat ? [{ file, mtimeMs: stat.mtimeMs, size: stat.size }] : [];
  });
}

/** The folders in `dir` whose names match: real folders only, a link to one is not followed. */
const subdirs = (dir: string, pattern: RegExp, unlisted: Unlisted | undefined): string[] =>
  entries(dir, unlisted).flatMap((entry) => (entry.isDirectory() && pattern.test(entry.name) ? [join(dir, entry.name)] : []));

/** Codex rollouts, in the layout Codex writes them: `sessions/YYYY/MM/DD/rollout-*.jsonl`. */
export function codexRollouts(codexHome: string, unlisted?: Unlisted): FoundFile[] {
  const days = subdirs(join(codexHome, "sessions"), /^\d{4}$/, unlisted).flatMap((year) => subdirs(year, /^\d{2}$/, unlisted).flatMap((month) => subdirs(month, /^\d{2}$/, unlisted)));
  return days.flatMap((day) => found(day, entries(day, unlisted), (name) => /^rollout-.*\.jsonl$/.test(name)));
}

/**
 * Claude Code transcripts, in the layout Claude Code writes them: `projects/<project>/<session>.jsonl`
 * and `projects/<project>/<session>/subagents/*.jsonl`. With `sessions`, only the files of those ids.
 */
export function claudeTranscripts(claudeHome: string, sessions?: ReadonlySet<string>, unlisted?: Unlisted): FoundFile[] {
  const wanted = (id: string) => sessions === undefined || sessions.has(id);
  return subdirs(join(claudeHome, "projects"), /^[^.]/, unlisted).flatMap((project) => {
    const names = entries(project, unlisted);
    const transcripts = found(project, names, (name) => name.endsWith(".jsonl") && wanted(name.slice(0, -".jsonl".length)));
    const subagents = names.flatMap((entry) => {
      if (!entry.isDirectory() || !wanted(entry.name)) return [];
      return subdirs(join(project, entry.name), /^subagents$/, unlisted).flatMap((dir) => found(dir, entries(dir, unlisted), (name) => name.endsWith(".jsonl")));
    });
    return [...transcripts, ...subagents];
  });
}
