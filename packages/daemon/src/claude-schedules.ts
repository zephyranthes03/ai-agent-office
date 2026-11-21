// Claude desktop 4.23118.0's Code and Cowork schedule manifests, metadata only. The app
// computes recurring next times and jitter in memory. lastRunAt also advances when a
// watcher skips a slot, so neither it nor the scheduled time proves an agent ran.
import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { readScheduleJson } from "./local-schedules.ts";
import type { Automation, AutomationRun, AutomationsRead } from "./schedule-source.ts";

const MODES = ["claude-code-sessions", "local-agent-mode-sessions"] as const;
const MAX_ENTRIES = 2048;
const MAX_STORES = 64;
const MAX_TASKS = 2048;
const MAX_SESSIONS = 512;
const CLI_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD_FILE = /^local_[A-Za-z0-9_-]{1,128}\.json$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const display = (value: string): string => value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").slice(0, 64);

class ReadProblem extends Error {
  readonly outcome: "unreadable" | "unsupported";
  readonly code: string;
  constructor(outcome: "unreadable" | "unsupported", code: string) {
    super(code);
    this.outcome = outcome;
    this.code = code;
  }
}
const invalid = (code: string): never => { throw new ReadProblem("unsupported", code); };

/** Missing paths are normal; filesystem permission/I/O failures remain visible. */
function entries(root: string, relative: string): { name: string; directory: boolean }[] {
  const file = join(root, relative);
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (info === undefined) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) return invalid("claude.directory_type");
  const dir = opendirSync(file);
  const result: { name: string; directory: boolean }[] = [];
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (result.length === MAX_ENTRIES) return invalid("claude.directory_limit");
      // A symlink in a structural level must not make an account's tasks disappear.
      if (entry.isSymbolicLink() && relative.split(/[\\/]/).length < 3) return invalid("claude.directory_symlink");
      result.push({ name: entry.name, directory: entry.isDirectory() });
    }
  } finally { dir.closeSync(); }
  return result.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

function iso(value: unknown, field: string, numeric = false): string | null {
  if (value === undefined) return null;
  if (numeric ? typeof value !== "number" || !Number.isSafeInteger(value) : typeof value !== "string") return invalid(`claude.${field}`);
  if (!numeric) {
    const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value as string);
    if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) return invalid(`claude.${field}`);
    const day = new Date(`${parts[1]}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== parts[1]) return invalid(`claude.${field}`);
  }
  const date = new Date(value as string | number);
  if (!Number.isFinite(date.getTime())) return invalid(`claude.${field}`);
  return date.toISOString();
}
function optionalText(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  if (value === undefined) return null;
  if (typeof value !== "string") return invalid(`claude.${field}`);
  return value;
}
function task(row: unknown, mode: string, account: string, org: string): { nativeId: string; automation: Automation } {
  if (!record(row) || typeof row.id !== "string" || row.id.trim() === "" || typeof row.enabled !== "boolean" || typeof row.filePath !== "string" || row.createdAt === undefined) return invalid("claude.task_shape");
  iso(row.createdAt, "createdAt", true);
  const name = optionalText(row, "displayName");
  const cron = optionalText(row, "cronExpression");
  if (cron !== null && cron.trim() === "") return invalid("claude.cronExpression");
  const fire = iso(row.fireAt, "fireAt", true);
  const attempted = iso(row.lastRunAt, "lastRunAt");
  iso(row.lastScheduledFor, "lastScheduledFor");
  const cwd = optionalText(row, "cwd");
  // Hash the whole native namespace: task ids do not expose account identifiers and
  // identical task ids in Code/Cowork or another account never share a stored row.
  const id = createHash("sha256").update(JSON.stringify([mode, account, org, row.id])).digest("hex");
  return { nativeId: row.id, automation: {
    id, name: display(name || row.id), status: row.enabled ? "active" : "paused",
    kind: mode === "claude-code-sessions" ? "claude-code" : "claude-cowork",
    rrule: null, next_run_at: row.enabled && fire !== null && attempted === null ? fire : null,
    next_run_nominal_at: null, last_run_at: null, last_attempt_at: attempted,
    cwd, thread: null, can_confirm_run: false,
    ...(cron !== null ? { rule: { kind: "cron" as const, expression: displayRule(cron) } } : fire !== null ? { rule: { kind: "at" as const, at: fire } } : {}),
  } };
}
function displayRule(value: string): string {
  if (value.length > 256 || /[\p{C}\p{Zl}\p{Zp}]/u.test(value)) return invalid("claude.cronExpression");
  return value;
}

function read(root: string, file: string, maxBytes?: number): unknown | undefined {
  const result = readScheduleJson(root, file, maxBytes);
  if (result.outcome === "absent") return undefined;
  if (result.outcome !== "ok") throw new ReadProblem(result.outcome, result.code ?? "claude.read_failed");
  return result.value;
}

export function readClaudeSchedules(appDir: string): AutomationsRead {
  const none = { automations: [] as Automation[], runs: [] as AutomationRun[] };
  const automations: Automation[] = [];
  const runs: AutomationRun[] = [];
  let manifests = 0;
  let stores = 0;
  let sessions = 0;
  try {
    const root = lstatSync(appDir, { throwIfNoEntry: false });
    if (root === undefined) return { outcome: "absent", code: null, ...none };
    if (!root.isDirectory() || root.isSymbolicLink()) return invalid("claude.directory_type");
    for (const mode of MODES) for (const account of entries(appDir, mode).filter((entry) => entry.directory)) {
      for (const org of entries(appDir, join(mode, account.name)).filter((entry) => entry.directory)) {
        if (++stores > MAX_STORES) return invalid("claude.store_limit");
        const directory = join(mode, account.name, org.name);
        const manifest = read(appDir, join(directory, "scheduled-tasks.json"));
        if (manifest === undefined) continue;
        if (!record(manifest) || !Array.isArray(manifest.scheduledTasks)) return invalid("claude.manifest_shape");
        manifests++;
        const ids = new Map<string, string>();
        for (const raw of manifest.scheduledTasks) {
          if (automations.length === MAX_TASKS) return invalid("claude.task_limit");
          const { nativeId, automation } = task(raw, mode, account.name, org.name);
          if (ids.has(nativeId)) return invalid("claude.duplicate_task");
          ids.set(nativeId, automation.id); automations.push(automation);
        }
        if (mode !== "claude-code-sessions" || ids.size === 0) continue;
        for (const entry of entries(appDir, directory)) {
          if (!RECORD_FILE.test(entry.name)) continue;
          if (++sessions > MAX_SESSIONS) return invalid("claude.session_limit");
          const session = read(appDir, join(directory, entry.name), 256 * 1024);
          if (session === undefined) continue; // Removed between listing and opening.
          if (!record(session)) return invalid("claude.session_shape");
          if (session.scheduledTaskId === undefined) continue;
          if (typeof session.scheduledTaskId !== "string") return invalid("claude.session_task_id");
          const automationId = ids.get(session.scheduledTaskId);
          if (automationId === undefined || session.cliSessionId === undefined) continue;
          if (typeof session.cliSessionId !== "string" || !CLI_ID.test(session.cliSessionId) || typeof session.sessionId !== "string" || `${session.sessionId}.json` !== entry.name) return invalid("claude.session_id");
          const created = iso(session.createdAt, "session_createdAt", true);
          if (created === null) return invalid("claude.session_createdAt");
          runs.push({ thread_id: session.cliSessionId, automation_id: automationId, status: null, created_at: created, evidence: "session_created" });
        }
      }
    }
    return { outcome: manifests === 0 ? "absent" : automations.length === 0 ? "empty" : "ok", code: null, automations, runs };
  } catch (error) {
    if (error instanceof ReadProblem) return { outcome: error.outcome, code: error.code, ...none };
    if (error instanceof Error && "code" in error && typeof error.code === "string") return { outcome: "unreadable", code: error.code, ...none };
    throw error;
  }
}
