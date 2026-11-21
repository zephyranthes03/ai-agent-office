// OpenCode 2.2.6's native experimental scheduler. Only metadata columns are selected:
// action, check and state contain prompts, commands or output and are never read.
// last_fired_at records admission to the session inbox, not execution or completion.
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Automation, AutomationsRead } from "./schedule-source.ts";

const COLUMNS = ["id", "session_id", "name", "when", "tz", "status", "next_due_at", "last_fired_at", "last_outcome", "retry_at"] as const;
const OUTCOMES = ["fired", "late", "checked", "expired", "skipped", "disabled", "failed"];
const LIMIT = 2048;

/** Stable/prod/dev/beta/next use opencode.db. Other compiled release channels need an explicit DB path. */
export function defaultOpenCodeDbPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const data = join(env["XDG_DATA_HOME"] || join(home, ".local", "share"), "opencode");
  const file = env["OPENCODE_DB"] ?? "opencode.db";
  return file === ":memory:" ? file : resolve(data, file);
}

class ShapeError extends Error {}
const invalid = (field: string): never => { throw new ShapeError(`schedule.${field}`); };
const clean = (value: string): string => value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").slice(0, 64);
function text(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.trim() === "") return invalid(field);
  return value;
}
function time(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return invalid(field);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return invalid(field);
  return date.toISOString();
}
function rule(value: unknown, timezone: string): NonNullable<Automation["rule"]> {
  if (typeof value !== "string") return invalid("when");
  let row: unknown;
  try { row = JSON.parse(value); } catch (error) {
    if (error instanceof SyntaxError) return invalid("when");
    throw error;
  }
  if (row === null || typeof row !== "object" || Array.isArray(row)) return invalid("when");
  const raw = row as Record<string, unknown>;
  if (!["cron", "every", "in", "at"].includes(raw["type"] as string)) return invalid("when.type");
  const type = raw["type"] as "cron" | "every" | "in" | "at";
  const expression = text(raw[type], `when.${type}`)!;
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(expression)) return invalid(`when.${type}`);
  return { kind: type === "cron" ? "cron" : type === "every" ? "interval" : "at", expression: type === "in" ? `in ${expression}` : expression, timezone };
}

export function readOpenCodeSchedules(dbPath: string): AutomationsRead {
  const none = { automations: [], runs: [] };
  if (dbPath === ":memory:") return { outcome: "unsupported", code: "schedule.in_memory", ...none };
  let db: DatabaseSync | undefined;
  try {
    const info = lstatSync(dbPath, { throwIfNoEntry: false });
    if (info === undefined) return { outcome: "absent", code: null, ...none };
    if (!info.isFile() || info.isSymbolicLink()) return { outcome: "unsupported", code: "schedule.not_regular_file", ...none };
    db = new DatabaseSync(dbPath, { readOnly: true });
    const columns = new Set((db.prepare("PRAGMA table_info(schedule)").all() as { name: string }[]).map((column) => column.name));
    if (columns.size === 0) return { outcome: "unsupported", code: "schedule", ...none };
    for (const column of COLUMNS) if (!columns.has(column)) return { outcome: "unsupported", code: `schedule.${column}`, ...none };
    // Bound both the number of rows and the returned strings. An oversized metadata
    // field becomes a visible schema failure, never a silently truncated identity.
    const bounded = (column: string, size: number) => `CASE WHEN length("${column}") <= ${size} THEN "${column}" ELSE NULL END AS "${column}", length("${column}") > ${size} AS "${column}_oversized"`;
    const select = [bounded("id", 256), bounded("session_id", 256), bounded("name", 4096), bounded("when", 4096), bounded("tz", 128), bounded("status", 64), '"next_due_at"', '"last_fired_at"', bounded("last_outcome", 64), '"retry_at"'];
    const rows = db.prepare(`SELECT ${select.join(", ")} FROM schedule ORDER BY id LIMIT ?`).all(LIMIT + 1);
    if (rows.length > LIMIT) return invalid("row_limit");
    const automations: Automation[] = rows.map((row) => {
      for (const column of ["id", "session_id", "name", "when", "tz", "status", "last_outcome"]) if (row[`${column}_oversized`] === 1) return invalid(column);
      const id = text(row["id"], "id")!;
      const session = text(row["session_id"], "session_id", true);
      const name = row["name"];
      if (name !== null && typeof name !== "string") return invalid("name");
      const timezone = text(row["tz"], "tz")!;
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch (error) {
        if (error instanceof RangeError) return invalid("tz");
        throw error;
      }
      const status = text(row["status"], "status")!;
      if (!["active", "paused", "done"].includes(status)) return invalid("status");
      const outcome = text(row["last_outcome"], "last_outcome", true);
      if (outcome !== null && !OUTCOMES.includes(outcome)) return invalid("last_outcome");
      time(row["retry_at"], "retry_at");
      return {
        id, name: name === null ? null : clean(name), status, kind: "opencode-native", rrule: null,
        rule: rule(row["when"], timezone), next_run_at: time(row["next_due_at"], "next_due_at"),
        next_run_nominal_at: null, last_run_at: null, last_attempt_at: time(row["last_fired_at"], "last_fired_at"),
        last_status: outcome, cwd: null, thread: session, can_confirm_run: false, can_detect_missed: false,
      };
    });
    return { outcome: automations.length === 0 ? "empty" : "ok", code: null, automations, runs: [] };
  } catch (error) {
    if (error instanceof ShapeError) return { outcome: "unsupported", code: error.message, ...none };
    if (error instanceof Error && "code" in error && typeof error.code === "string") return { outcome: "unreadable", code: error.code, ...none };
    throw error;
  } finally { db?.close(); }
}
