// Codex's scheduled tasks (the ChatGPT app's "Scheduled" view; codex adapter, local_db strategy for
// `schedule`), from the app's own database, opened read-only for each pass and closed again. Only the
// listed columns of `automations` and `automation_runs` are read: the schedule (name, status, kind,
// rule, next and last run, the project folder, the thread the task lives in) and which thread each
// run opened; prompts, titles and messages are never selected. The read says what happened: the file is absent (the owner does not
// use the app), the tables are there but empty, the file could not be read (an error code), or the
// schema is not the one this reader knows (the first column it misses). Nothing falls back to an
// older database: an error with the current one is reported, not hidden.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The app's database under `CODEX_HOME` (the older `codex-dev.db` beside it stopped moving on 2026-10-29 and is not read). */
export const CODEX_AUTOMATIONS_DB = join("sqlite", "codex.db");
/** At most this many of the newest runs are read (a run links a session only while the daemon still knows the session). */
const RUNS_LIMIT = 200;
const NAME_MAX = 64;

import type { Automation, AutomationRun, AutomationsRead } from "./schedule-source.ts";
export type { Automation, AutomationRun, AutomationsOutcome, AutomationsRead } from "./schedule-source.ts";

const AUTOMATION_COLUMNS = ["id", "name", "status", "kind", "rrule", "next_run_at", "next_run_nominal_at", "last_run_at", "cwds", "target_thread_id"] as const;
const RUN_COLUMNS = ["thread_id", "automation_id", "status", "created_at"] as const;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * An integer epoch as ISO time. The app's unit is not documented: a value this large is only a time
 * in milliseconds (10^11 s is the year 5138; 10^11 ms is 1973), so the unit is read from the size,
 * not guessed. Anything else is null.
 */
export function epochIso(value: unknown): string | null {
  if (typeof value === "bigint") value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value >= 1e11 ? value : value * 1000;
  return new Date(Math.round(ms)).toISOString();
}

/** `firstCwd` for a value that is not the JSON list of folders the column holds: the shape is not the one this reader knows. */
export const NOT_A_LIST: unique symbol = Symbol("not a JSON list");

/** The first path of a JSON list of folders (null when the list is empty); `NOT_A_LIST` for anything else. A list is never looked past its first entry. */
export function firstCwd(value: unknown): string | null | typeof NOT_A_LIST {
  if (typeof value !== "string") return NOT_A_LIST;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return NOT_A_LIST;
  }
  return Array.isArray(parsed) ? text(parsed[0]) : NOT_A_LIST;
}

function missingColumn(db: DatabaseSync, table: string, columns: readonly string[]): string | null {
  const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: unknown }[]).map((row) => row.name));
  if (present.size === 0) return `${table}`;
  for (const column of columns) if (!present.has(column)) return `${table}.${column}`;
  return null;
}

export function readCodexAutomations(codexHome: string): AutomationsRead {
  const file = join(codexHome, CODEX_AUTOMATIONS_DB);
  const none = { automations: [] as Automation[], runs: [] as AutomationRun[] };
  if (!existsSync(file)) return { outcome: "absent", code: null, ...none };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const missing = missingColumn(db, "automations", AUTOMATION_COLUMNS) ?? missingColumn(db, "automation_runs", RUN_COLUMNS);
    if (missing !== null) return { outcome: "unsupported", code: missing, ...none };
    const automations: Automation[] = [];
    for (const row of db.prepare(`SELECT ${AUTOMATION_COLUMNS.join(", ")} FROM automations`).all() as Record<(typeof AUTOMATION_COLUMNS)[number], unknown>[]) {
      const id = text(row.id);
      if (id === null) continue;
      const cwd = firstCwd(row.cwds);
      if (cwd === NOT_A_LIST) return { outcome: "unsupported", code: "automations.cwds", ...none };
      automations.push({
        id,
        name: text(row.name)?.slice(0, NAME_MAX) ?? null,
        status: text(row.status) ?? "unknown",
        kind: text(row.kind) ?? "unknown",
        rrule: text(row.rrule),
        next_run_at: epochIso(row.next_run_at),
        next_run_nominal_at: epochIso(row.next_run_nominal_at),
        last_run_at: epochIso(row.last_run_at),
        cwd,
        thread: text(row.target_thread_id),
      });
    }
    const runs: AutomationRun[] = [];
    for (const row of db.prepare(`SELECT ${RUN_COLUMNS.join(", ")} FROM automation_runs ORDER BY created_at DESC LIMIT ?`).all(RUNS_LIMIT) as Record<(typeof RUN_COLUMNS)[number], unknown>[]) {
      const thread = text(row.thread_id);
      const automation = text(row.automation_id);
      const at = epochIso(row.created_at);
      if (thread === null || automation === null || at === null) continue;
      runs.push({ thread_id: thread, automation_id: automation, status: text(row.status), created_at: at });
    }
    return { outcome: automations.length === 0 && runs.length === 0 ? "empty" : "ok", code: null, automations, runs };
  } catch (error) {
    return { outcome: "unreadable", code: (error as NodeJS.ErrnoException).code ?? (error as Error).name, ...none };
  } finally {
    db?.close();
  }
}
