// Read-only metadata for the installed OpenClaw 2026.4.2 and Hermes 0.18 scheduler
// formats. No provider CLI is invoked: even Hermes's load_jobs() can rewrite its store.
import { join } from "node:path";
import { readTail } from "./log-files.ts";
import { readHermesExecutions, readOpenClawDatabase } from "./latest-schedules.ts";
import type { Automation, AutomationRun, AutomationsRead } from "./schedule-source.ts";

export { readScheduleJson, SCHEDULE_BYTES } from "./local-schedule-files.ts";
export type { ScheduleJsonRead } from "./local-schedule-files.ts";
import { checkedPath, failure, hasNewerStore, identity, iso, milliseconds, readScheduleJson, record, reject, text } from "./local-schedule-files.ts";
const JOBS_LIMIT = 128;
// Optional exact links: at most 64 recent jobs × (64 KiB + readTail's one-byte boundary lookback).
const RUN_FILES_LIMIT = 64;
const RUN_TAIL_BYTES = 64 * 1024;
function ruleOf(value: unknown, provider: "openclaw" | "hermes"): NonNullable<Automation["rule"]> {
  const rule = record(value, "jobs.schedule");
  if (rule["kind"] === "cron") {
    const expression = text(rule["expr"], "jobs.schedule.expr", 256);
    if (!expression) reject("jobs.schedule.expr");
    const timezone = text(rule["tz"], "jobs.schedule.tz");
    return { kind: "cron", expression, ...(timezone ? { timezone } : {}) };
  }
  if (rule["kind"] === (provider === "openclaw" ? "every" : "interval")) {
    const value = provider === "openclaw" ? rule["everyMs"] : rule["minutes"];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) reject("jobs.schedule.interval");
    const every = provider === "openclaw" ? value : value * 60_000;
    if (!Number.isSafeInteger(every)) reject("jobs.schedule.interval");
    return { kind: "interval", every_ms: every };
  }
  if (rule["kind"] === (provider === "openclaw" ? "at" : "once")) {
    const at = iso(rule[provider === "openclaw" ? "at" : "run_at"], "jobs.schedule.at");
    if (!at) reject("jobs.schedule.at");
    return { kind: "at", at };
  }
  return reject("jobs.schedule.kind");
}

function base(job: Record<string, unknown>, provider: "openclaw" | "hermes"): Automation {
  if (typeof job["enabled"] !== "boolean") reject("jobs.enabled");
  const rule = ruleOf(job["schedule"], provider);
  return { id: identity(job["id"]), name: text(job["name"], "jobs.name"), status: job["enabled"] ? "ACTIVE" : "PAUSED", kind: String(record(job["schedule"], "jobs.schedule")["kind"]), rrule: null, rule, next_run_at: null, next_run_nominal_at: null, last_run_at: null, cwd: null, thread: null, running_at: null, last_status: null, last_attempt_at: null, can_confirm_run: true };
}

function openClawJob(job: Record<string, unknown>): Automation {
  const item = base(job, "openclaw");
  const state = record(job["state"], "jobs.state");
  const status = text(state["lastRunStatus"] ?? state["lastStatus"], "jobs.state.lastRunStatus");
  if (status !== null && !["ok", "error", "skipped"].includes(status)) reject("jobs.state.lastRunStatus");
  const attempted = milliseconds(state["lastRunAtMs"], "jobs.state.lastRunAtMs");
  return { ...item, next_run_at: milliseconds(state["nextRunAtMs"], "jobs.state.nextRunAtMs"), running_at: milliseconds(state["runningAtMs"], "jobs.state.runningAtMs"), last_status: status, last_attempt_at: attempted, last_run_at: status === "ok" || status === "error" ? attempted : null };
}

function hermesJob(job: Record<string, unknown>): Automation {
  const item = base(job, "hermes");
  const state = text(job["state"], "jobs.state");
  if (state !== null && !["scheduled", "paused", "error", "completed"].includes(state)) reject("jobs.state");
  const status = text(job["last_status"], "jobs.last_status");
  if (status !== null && !["ok", "error", "cancelled", "delivery_failed"].includes(status)) reject("jobs.last_status");
  const attempted = iso(job["last_run_at"], "jobs.last_run_at");
  // This version keeps running IDs in memory, and a one-shot's due time stays unchanged
  // until completion. A missing completion cannot establish that its execution was missed.
  const timezone = text(job["timezone"], "jobs.timezone");
  if (timezone && item.rule) item.rule.timezone = timezone;
  return { ...item, can_detect_missed: false, status: state === "paused" ? "PAUSED" : state === "completed" ? "COMPLETED" : state === "error" ? "ERROR" : item.status, next_run_at: iso(job["next_run_at"], "jobs.next_run_at"), last_status: status, last_attempt_at: attempted, last_run_at: status !== null ? attempted : null, cwd: text(job["workdir"], "jobs.workdir", 4096) };
}

function openClawRuns(home: string, jobs: Automation[]): AutomationRun[] {
  const runs: AutomationRun[] = [];
  const recent = jobs.toSorted((a, b) => (b.last_attempt_at ?? "").localeCompare(a.last_attempt_at ?? "")).slice(0, RUN_FILES_LIMIT);
  for (const job of recent) {
    let tail: string;
    try {
      const path = checkedPath(home, join("cron", "runs", `${job.id}.jsonl`));
      tail = readTail(path, RUN_TAIL_BYTES).text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let latest: AutomationRun | null = null;
    for (const line of tail.split("\n")) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line) as unknown; }
      catch (error) {
        if (error instanceof SyntaxError) reject("runs.invalid_json");
        throw error;
      }
      const row = record(value, "runs.item");
      if (row["action"] !== "finished" || row["jobId"] !== job.id) reject("runs.identity");
      if (!["ok", "error", "skipped"].includes(String(row["status"]))) reject("runs.status");
      if (row["status"] === "skipped" || row["sessionId"] === undefined) continue;
      const id = row["sessionId"];
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) reject("runs.session_id");
      const at = milliseconds(row["runAtMs"], "runs.run_at");
      if (!at) reject("runs.run_at");
      if (latest === null || at >= latest.created_at) latest = { thread_id: id, automation_id: job.id, status: String(row["status"]), created_at: at };
    }
    if (latest) runs.push(latest);
  }
  return runs;
}

function readLocalSchedules(home: string, provider: "openclaw" | "hermes"): AutomationsRead {
  const none = { automations: [], runs: [] };
  try {
    if (provider === "openclaw" && hasNewerStore(home, join("state", "openclaw.sqlite"))) return readOpenClawDatabase(home, openClawJob);
    const read = readScheduleJson(home, join("cron", "jobs.json"));
    if (read.outcome !== "ok") return { ...read, ...none };
    const root = record(read.value, "store");
    if (provider === "openclaw" && root["version"] !== 1) reject("store.version");
    const jobs = root["jobs"];
    if (!Array.isArray(jobs)) reject("jobs");
    if (jobs.length > JOBS_LIMIT) reject("jobs_limit");
    const ids = new Set<string>();
    const automations = jobs.map((value: unknown) => {
      const job = record(value, "jobs.item");
      const item = provider === "openclaw" ? openClawJob(job) : hermesJob(job);
      if (ids.has(item.id)) reject("jobs.duplicate_id");
      ids.add(item.id);
      return item;
    });
    // Hermes job metadata has no exact session identity. OpenClaw history names it explicitly.
    if (provider === "hermes" && hasNewerStore(home, join("cron", "executions.db"))) return readHermesExecutions(home, automations);
    const runs = provider === "openclaw" ? openClawRuns(home, automations) : [];
    return { outcome: automations.length === 0 ? "empty" : "ok", code: null, automations, runs };
  } catch (error) {
    return { ...failure(error), ...none };
  }
}

export const readOpenClawSchedules = (home: string): AutomationsRead => readLocalSchedules(home, "openclaw");
export const readHermesSchedules = (home: string): AutomationsRead => readLocalSchedules(home, "hermes");
