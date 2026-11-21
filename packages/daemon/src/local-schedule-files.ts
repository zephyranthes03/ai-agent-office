// Bounded read-only scheduler files and metadata validation shared by provider readers.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const SCHEDULE_BYTES = 1024 * 1024;
type ReadFailure = { outcome: "absent" | "unreadable" | "unsupported"; code: string | null };
export type ScheduleJsonRead = ReadFailure | { outcome: "ok"; value: unknown };
export class ScheduleShape extends Error {}
export function reject(code: string): never { throw new ScheduleShape(code); }

/** Validate every path component below the selected home before opening anything. */
export function checkedPath(home: string, file: string): string {
  const root = resolve(home);
  const target = resolve(root, file);
  const rel = relative(root, target);
  if (isAbsolute(file) || !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) reject("path");
  let path = root;
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) reject("symlink");
  if (!rootStat.isDirectory()) reject("home_not_directory");
  const parts = rel.split(sep);
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]!);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) reject("symlink");
    if (index < parts.length - 1 && !stat.isDirectory()) reject("parent_not_directory");
  }
  return target;
}

export function failure(error: unknown): ReadFailure {
  if (error instanceof ScheduleShape) return { outcome: "unsupported", code: error.message };
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return { outcome: "absent", code: null };
  if (typeof code === "string") return { outcome: "unreadable", code };
  throw error;
}

/** A bounded regular JSON file under an explicit provider home; never repairs or writes. */
export function readScheduleJson(home: string, file: string, maxBytes = SCHEDULE_BYTES): ScheduleJsonRead {
  let fd: number | null = null;
  try {
    const path = checkedPath(home, file);
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) reject("not_regular_file");
    if (stat.size > maxBytes) reject("file_too_large");
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) reject("file_too_large");
    try {
      return { outcome: "ok", value: JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown };
    } catch (error) {
      if (error instanceof SyntaxError) return { outcome: "unsupported", code: "invalid_json" };
      throw error;
    }
  } catch (error) {
    return failure(error);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function hasNewerStore(home: string, file: string): boolean {
  try {
    checkedPath(home, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject(field);
  return value as Record<string, unknown>;
}

/** Only allowlisted metadata reaches this function; never pass a prompt/output fallback. */
export function text(value: unknown, field: string, max = 64): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") reject(field);
  return Array.from(value).filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join("").trim().slice(0, max) || null;
}

export function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) reject("jobs.id");
  return value;
}

export function milliseconds(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) reject(field);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) reject(field);
  return date.toISOString();
}

/** Python ISO timestamps may have microseconds; an explicit offset prevents host-time guesses. */
export function iso(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") reject(field);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) reject(field);
  const [, year, month, day, hour, minute, second] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) reject(field);
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) reject(field);
  return new Date(stamp).toISOString();
}

