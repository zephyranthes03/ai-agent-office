// The daemon's folder (`~/.agent-office`, or AGENT_OFFICE_HOME) and the private files in it.
// Folders are 0700 and files 0600; on POSIX the daemon refuses to start when the token or the
// spool folder can be read by others. Windows has no such modes (its ACLs keep the profile
// private), so the check is skipped there.
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, constants, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Paths = {
  home: string;
  token: string;
  daemonJson: string;
  config: string;
  db: string;
  spool: string;
  logs: string;
  /** The hook launcher's folder; agents' hook settings name a program in it. */
  bin: string;
};

export function officeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["AGENT_OFFICE_HOME"] || join(homedir(), ".agent-office");
}

export function pathsFor(home: string): Paths {
  return {
    home,
    token: join(home, "token"),
    daemonJson: join(home, "daemon.json"),
    config: join(home, "config.json"),
    db: join(home, "agent-office.sqlite"),
    spool: join(home, "spool"),
    logs: join(home, "logs"),
    bin: join(home, "bin"),
  };
}

export function prepareFolders(paths: Paths): void {
  for (const dir of [paths.home, paths.spool, paths.logs]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Problems with the private files; empty when they are private (always empty on Windows). */
export function privacyProblems(paths: Paths, platform: string = process.platform): string[] {
  if (platform === "win32") return [];
  const problems: string[] = [];
  for (const [label, path] of [["token", paths.token], ["spool folder", paths.spool]] as const) {
    let mode: number;
    try {
      mode = statSync(path).mode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if ((mode & 0o077) !== 0) problems.push(`the ${label} ${path} can be read by other users (mode ${(mode & 0o777).toString(8)}); run: chmod ${label === "token" ? "600" : "700"} "${path}"`);
  }
  return problems;
}

/** The token hooks and clients present; created on first start (32 random bytes, hex, 0600). */
export function ensureToken(path: string): string {
  try {
    writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const token = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`the token file ${path} is not 64 hex characters; delete it to create a new one`);
  return token;
}

/** Creates an empty file with mode 0600 if it does not exist (SQLite would create it with the umask's mode). */
export function touchPrivate(path: string): void {
  closeSync(openSync(path, "a", 0o600));
}

/**
 * Writes through a temporary file in the same folder, flushed to disk before a rename, so readers
 * never see half a file and a crash leaves the old one. The file gets `mode` whatever the umask.
 * The temporary name is random and created exclusively, so a link planted there is never followed.
 */
export function writeAtomic(path: string, text: string, mode = 0o600): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    try {
      writeFileSync(fd, text);
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

const LOG_MAX = 1024 * 1024;

/** Daemon diagnostics (never hook content), 1 MiB with one rotation. */
export function createLog(paths: Paths): (line: string) => void {
  const file = join(paths.logs, "daemon.log");
  return (line) => {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (size >= LOG_MAX) renameSync(file, `${file}.1`);
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  };
}
