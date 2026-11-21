// Metadata projections of OpenClaw 2026.11.1 shared state and Hermes 0.23.0 executions.
// Never import provider database helpers: they initialize/migrate the user's database.
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkedPath, failure, identity, iso, milliseconds, readScheduleJson, record, reject, SCHEDULE_BYTES, text } from "./local-schedule-files.ts";
import type { Automation, AutomationRun, AutomationsRead } from "./schedule-source.ts";

const LIMIT = 128;
const RUN_LIMIT = 200;
type Row = Record<string, unknown>;
const none = () => ({ automations: [] as Automation[], runs: [] as AutomationRun[] });

function database(home: string, file: string): DatabaseSync {
  const path = checkedPath(home, file);
  if (!lstatSync(path).isFile()) reject("not_regular_file");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { checkedPath(home, file + suffix); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 100; BEGIN");
  return db;
}

function columns(db: DatabaseSync, table: string, required: string[]): void {
  // Table names are fixed literals supplied by this module, never provider data.
  const available = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => row["name"]));
  if (available.size === 0) reject(table);
  for (const name of required) if (!available.has(name)) reject(`${table}.${name}`);
}

/** SQL projects individual allowlisted JSON leaves, never the definition/prompt itself. */
function leaf(column: string, key: string): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${SCHEDULE_BYTES} THEN CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.${key}') END END`;
}

function jsonType(column: string): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${SCHEDULE_BYTES} THEN CASE WHEN json_valid(${column}) THEN json_type(${column}) END END`;
}

function activeStore(db: DatabaseSync, home: string): string {
  columns(db, "config_machine_state", ["state_key", "value_json"]);
  const row = db.prepare("SELECT CASE WHEN length(CAST(value_json AS BLOB)) <= 8192 THEN CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$') END END AS selected FROM config_machine_state WHERE state_key = 'cron.store'").get() as Row | undefined;
  if (!row) return resolve(home, "cron", "jobs.json");
  const value = row["selected"];
  if (typeof value !== "string" || !value.trim()) reject("cron.store");
  // Provider resolves a relative custom path against its own cwd; ours cannot know that cwd.
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  if (!isAbsolute(value)) reject("cron.store.relative");
  return resolve(value);
}

function openClawHistory(db: DatabaseSync, store: string, ids: Map<string, string>): AutomationRun[] {
  columns(db, "task_runs", ["runtime", "source_id", "created_at", "detail_json"]);
  const fields = ["kind", "storeKey", "sessionId", "runAtMs", "status"];
  const projections = fields.map((field) => `${leaf("detail_json", field)} AS ${field}`).join(", ");
  const rows = db.prepare(`SELECT source_id, ${projections} FROM task_runs WHERE runtime = 'cron' AND ${leaf("detail_json", "storeKey")} = ? ORDER BY created_at DESC LIMIT ?`).all(store, RUN_LIMIT) as Row[];
  const runs: AutomationRun[] = [];
  for (const row of rows) {
    if (row["kind"] !== "cron-run" || typeof row["source_id"] !== "string" || !ids.has(row["source_id"])) continue;
    if (row["status"] === "skipped" || row["sessionId"] === null) continue;
    if (row["status"] !== "ok" && row["status"] !== "error") reject("task_runs.status");
    const session = identity(row["sessionId"]);
    const at = milliseconds(row["runAtMs"], "task_runs.runAtMs");
    if (!at) reject("task_runs.runAtMs");
    runs.push({ thread_id: session, automation_id: ids.get(row["source_id"])!, status: row["status"], created_at: at });
  }
  return runs;
}

export function readOpenClawDatabase(home: string, mapJob: (job: Row) => Automation): AutomationsRead {
  let db: DatabaseSync | null = null;
  try {
    db = database(home, join("state", "openclaw.sqlite"));
    columns(db, "cron_jobs", ["store_key", "job_id", "name", "enabled", "job_json", "state_json", "sort_order", "updated_at"]);
    columns(db, "cron_run_receipts", ["store_key", "job_id", "status", "started_at_ms", "finished_at_ms"]);
    const store = activeStore(db, home);
    const fields = ["schedule.kind", "schedule.expr", "schedule.tz", "schedule.everyMs", "schedule.at"];
    const states = ["nextRunAtMs", "runningAtMs", "lastRunAtMs", "lastRunStatus", "lastStatus"];
    const query = `SELECT job_id, substr(name,1,64) AS name, enabled, ${jsonType("job_json")} AS job_type, ${jsonType("state_json")} AS state_type, length(CAST(job_json AS BLOB)) AS job_bytes, length(CAST(state_json AS BLOB)) AS state_bytes, ${fields.map((key, i) => `${leaf("job_json", key)} AS f${i}`).join(", ")}, ${states.map((key) => `${leaf("state_json", key)} AS ${key}`).join(", ")} FROM cron_jobs WHERE store_key = ? ORDER BY sort_order, updated_at, job_id LIMIT ?`;
    const rows = db.prepare(query).all(store, LIMIT + 1) as Row[];
    if (rows.length > LIMIT) reject("jobs_limit");
    const ids = new Map<string, string>();
    const automations = rows.map((row) => {
      if (Number(row["job_bytes"]) > SCHEDULE_BYTES || Number(row["state_bytes"]) > SCHEDULE_BYTES) reject("cron_jobs.row_too_large");
      if (row["job_type"] !== "object" || row["state_type"] !== "object") reject("cron_jobs.invalid_json");
      if (row["enabled"] !== 0 && row["enabled"] !== 1) reject("cron_jobs.enabled");
      const item = mapJob({ id: row["job_id"], name: row["name"], enabled: row["enabled"] === 1, schedule: { kind: row["f0"], expr: row["f1"], tz: row["f2"], everyMs: row["f3"], at: row["f4"] }, state: Object.fromEntries(states.map((key) => [key, row[key]])) });
      const nativeId = item.id;
      const receipt = db!.prepare("SELECT status, started_at_ms FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1").get(store, item.id) as Row | undefined;
      if (receipt) {
        const status = receipt["status"];
        if (typeof status !== "string" || !["running", "ok", "error", "skipped", "interrupted", "superseded"].includes(status)) reject("cron_run_receipts.status");
        const at = milliseconds(receipt["started_at_ms"], "cron_run_receipts.started_at_ms");
        if (!at) reject("cron_run_receipts.started_at_ms");
        item.last_attempt_at = at;
        item.last_status = status;
        item.running_at = status === "running" ? at : null;
        if (["running", "ok", "error", "interrupted"].includes(status)) item.last_run_at = at;
      }
      // The provider's primary key is (store_key, job_id). A partition switch must not
      // inherit another task's persisted expected/missed occurrence or session links.
      item.id = `oc-${createHash("sha256").update(JSON.stringify([store, nativeId])).digest("hex")}`;
      ids.set(nativeId, item.id);
      return item;
    });
    const runs = openClawHistory(db, store, ids);
    return { outcome: automations.length ? "ok" : "empty", code: null, automations, runs };
  } catch (error) {
    return { ...failure(error), ...none() };
  } finally { db?.close(); }
}

function hermesAdmission(home: string, job: string, execution: string): string | null {
  // Python json.dumps uses a space after the comma; both identities are validated ASCII.
  const filename = createHash("sha256").update(`[${JSON.stringify(job)}, ${JSON.stringify(execution)}]`).digest("hex");
  const read = readScheduleJson(home, join("cron", "admissions", `${filename}.json`), 64 * 1024);
  if (read.outcome === "absent") return null;
  if (read.outcome !== "ok") reject(`admissions.${read.code ?? read.outcome}`);
  const root = record(read.value, "admissions.record");
  const params = record(root["params"], "admissions.params");
  if (params["job_id"] !== job || params["request_id"] !== execution) reject("admissions.identity");
  if (root["receipt"] === null) return null;
  const receipt = record(root["receipt"], "admissions.receipt");
  return identity(receipt["session_id"]);
}

export function readHermesExecutions(home: string, automations: Automation[]): AutomationsRead {
  let db: DatabaseSync | null = null;
  try {
    db = database(home, join("cron", "executions.db"));
    columns(db, "executions", ["id", "job_id", "status", "claimed_at", "started_at", "finished_at", "scheduled_instant"]);
    const runs: AutomationRun[] = [];
    let journals = 0;
    for (const item of automations) {
      item.can_detect_missed = true;
      const row = db.prepare("SELECT id, status, claimed_at, started_at, finished_at FROM executions WHERE job_id = ? ORDER BY julianday(claimed_at) DESC, id DESC LIMIT 1").get(item.id) as Row | undefined;
      if (!row) continue;
      const execution = identity(row["id"]);
      const status = text(row["status"], "executions.status");
      if (status === null || !["claimed", "running", "completed", "failed", "unknown", "cancelled", "missed"].includes(status)) reject("executions.status");
      const claimed = iso(row["claimed_at"], "executions.claimed_at");
      const started = iso(row["started_at"], "executions.started_at");
      iso(row["finished_at"], "executions.finished_at");
      if (!claimed || (status === "running" && !started)) reject("executions.timestamp");
      item.last_attempt_at = started ?? claimed;
      item.last_status = status;
      item.running_at = status === "running" ? started : null;
      item.can_detect_missed = status !== "claimed" && status !== "unknown";
      if (started && status !== "missed") item.last_run_at = started;
      if (journals >= 64 || !started || status === "missed") continue;
      journals++;
      const session = hermesAdmission(home, item.id, execution);
      if (session) runs.push({ thread_id: session, automation_id: item.id, status, created_at: started });
    }
    return { outcome: automations.length ? "ok" : "empty", code: null, automations, runs };
  } catch (error) {
    return { ...failure(error), ...none() };
  } finally { db?.close(); }
}
