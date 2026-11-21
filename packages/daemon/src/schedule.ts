// Scheduled tasks: what the agents' own schedulers plan (today: Codex's scheduled tasks, read from
// the app's database each pass), kept apart as the schedule (name, rule, next and last run) and the
// run (the thread a run opened, its status, whether the daemon knows that thread as a session) and
// the task's own thread (`target_thread_id`). A session is linked to a task by an exact thread id and
// nothing else: the id of a run row, or the task's own thread (a heartbeat task, observed 2026-11-01,
// runs as turns of that thread and writes no run row). The links are checked again on every pass,
// since the rows may be written after the session's first hook.
//
// A missed occurrence is never called at once. The occurrence the daemon waits for (`expected_at`,
// the next run it saw while that time was still ahead) counts as missed only when its time plus the
// grace period has passed, no run was recorded for it (a run row, or `last_run_at`, at or after the
// time), and the daemon was reading the source without a gap from before that time until now. A gap (the daemon was down, or the source could not be
// read) leaves it "unsure" instead; a later run clears either. The app's own `next_run_at` is the
// only source of the next time: the rule is never evaluated here.
import type { AutomationsRead } from "./schedule-source.ts";
import type { ScheduledTaskRow, Store } from "./store.ts";

import type { Schedule, ScheduledRun, ScheduledTask, ScheduledThread, ScheduleSource, Unsure } from "@agent-office/core";
export type { Schedule, ScheduledRun, ScheduledTask, ScheduledThread, ScheduleSource, Unsure };
export const NO_SCHEDULE: Schedule = { sources: [], tasks: [] };

/** A run recorded this close before its occurrence still counts for it (the app may write the row a moment early). */
const RUN_SLACK_MS = 60_000;
/** Passes further apart than this break the observation: what happened in between was not watched. */
const GAP_MS = 90_000;


type Deps = {
  agent?: string;
  store: Store;
  read: () => AutomationsRead;
  now: () => number;
  log: (line: string) => void;
  /** Seconds after an occurrence before it can be called missed (schedule.missed_after_min). */
  missedAfterS: number;
};

export type Refresh = { schedule: Schedule; changed: boolean; /** Session → the task whose run opened it. */ links: Map<string, ScheduledTask> };

const projectOf = (cwd: string | null): string | null => {
  if (cwd === null) return null;
  const name = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return name === "" ? null : name.slice(0, 64);
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** By next run (ISO strings compare as times), tasks without one last, then by key. */
function byNextRun(a: ScheduledTask, b: ScheduledTask): number {
  if (a.next_run_at === null || b.next_run_at === null) return a.next_run_at === b.next_run_at ? compare(a.key, b.key) : a.next_run_at === null ? 1 : -1;
  return compare(a.next_run_at, b.next_run_at) || compare(a.key, b.key);
}

function statusOf(raw: string): ScheduledTask["status"] {
  const value = raw.toLowerCase();
  if (value === "active") return "active";
  if (value === "paused") return "paused";
  return "other";
}

export class ScheduleTracker {
  private readonly deps: Deps;
  private readonly agent: string;
  /** The task rows as last written, by key (loaded from the store at start). */
  private readonly rows = new Map<string, ScheduledTaskRow>();
  private readonly observedOccurrences = new Map<string, { expected: string; at: number }>();
  private source: ScheduleSource | null = null;
  /** When the current unbroken run of readable passes began; null while the source cannot be read. */
  private okSince: number | null = null;
  private lastPassAt: number | null = null;
  private readonly startedAt: number;
  private last: string | null = null;
  private schedule: Schedule = NO_SCHEDULE;

  constructor(deps: Deps) {
    this.deps = deps;
    this.agent = deps.agent ?? "codex";
    this.startedAt = deps.now();
    for (const row of deps.store.scheduledTasks()) if (row.agent === this.agent) {
      this.rows.set(row.task_key, row);
      if (row.expected_at !== null) this.observedOccurrences.set(row.task_key, { expected: row.expected_at, at: Date.parse(row.observed_at) });
    }
  }

  current(): Schedule {
    return this.schedule;
  }

  /** Reads the source once and derives the schedule; `sessions` are the session ids the daemon knows (for the links). */
  refresh(sessions: ReadonlySet<string>): Refresh {
    const nowMs = this.deps.now();
    const now = new Date(nowMs).toISOString();
    const read = this.deps.read();
    const readable = read.outcome === "ok" || read.outcome === "empty";
    // The observation: unbroken while every pass could read the source and passes came regularly.
    if (!readable) this.okSince = null;
    else if (this.okSince === null || (this.lastPassAt !== null && nowMs - this.lastPassAt > GAP_MS)) this.okSince = nowMs;
    this.lastPassAt = nowMs;
    if (this.source === null || this.source.outcome !== read.outcome || this.source.code !== read.code) this.deps.log(`${this.agent}_automations ${read.outcome}${read.code === null ? "" : ` ${read.code}`}`);
    this.source = { agent: this.agent, outcome: read.outcome, code: read.code, at: now };

    const links = new Map<string, ScheduledTask>();
    const ambiguous = new Set<string>();
    const link = (session: string, task: ScheduledTask): void => {
      if (ambiguous.has(session)) return;
      const previous = links.get(session);
      if (previous !== undefined && previous.key !== task.key) { links.delete(session); ambiguous.add(session); }
      else links.set(session, task);
    };
    let tasks: ScheduledTask[];
    if (read.outcome === "absent") {
      // No source: nothing is scheduled (and nothing lingers from a file that is gone).
      tasks = [];
      this.rows.clear();
      this.observedOccurrences.clear();
    } else if (!readable) {
      // The source is there but could not be read this pass: the last schedule stands, marked by the source.
      tasks = this.schedule.tasks.map((task) => ({ ...task, thread: task.thread === null ? null : { ...task.thread, linked: sessions.has(task.thread.session) }, run: task.run === null ? null : { ...task.run, linked: sessions.has(task.run.session) } }));
      for (const task of tasks) {
        if (task.thread?.linked) link(task.thread.session, task);
        if (task.run?.linked) link(task.run.session, task);
      }
    } else {
      tasks = [];
      const seen = new Set<string>();
      for (const automation of read.automations) {
        const key = `${this.agent}:${automation.id}`;
        seen.add(key);
        const previous = this.rows.get(key);
        const runs = read.runs.filter((run) => run.automation_id === automation.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        const newest = runs[0] ?? null;
        const next = automation.next_run_at;
        // Evidence of a run: the run rows and the scheduler's own `last_run_at` (the only trace of a heartbeat run).
        const ranSince = (sinceMs: number): boolean => runs.some((run) => run.evidence !== "session_created" && Date.parse(run.created_at) >= sinceMs - RUN_SLACK_MS) || (automation.last_run_at !== null && Date.parse(automation.last_run_at) >= sinceMs - RUN_SLACK_MS);
        // The occurrence awaited: the one from before, or the next time the app names.
        let expected = previous?.expected_at ?? null;
        let missed = previous?.missed_at ?? null;
        let unsure: Unsure | null = previous?.unsure_at ? { at: previous.unsure_at, reason: (previous.unsure_reason as Unsure["reason"] | null) ?? "daemon_down" } : null;
        if (expected !== null && next !== null && next !== expected && !ranSince(Date.parse(expected))) {
          // The provider changed the occurrence (including an earlier reschedule). Watch the new time anew.
          expected = null;
          missed = null;
          unsure = null;
        }
        if (expected === null) expected = next;
        if (statusOf(automation.status) !== "active") { expected = null; missed = null; unsure = null; }
        if (expected !== null) {
          const expectedMs = Date.parse(expected);
          const observation = this.observedOccurrences.get(key);
          const seenAt = observation?.expected === expected ? observation.at : nowMs;
          if (ranSince(expectedMs)) {
            missed = null;
            unsure = null;
            expected = next !== null && Date.parse(next) > expectedMs ? next : null;
          } else if (missed === null && unsure === null && nowMs >= expectedMs + this.deps.missedAfterS * 1000) {
            if (this.startedAt > expectedMs) unsure = { at: expected, reason: "daemon_down" };
            else if (this.okSince === null || this.okSince > expectedMs || seenAt > expectedMs) unsure = { at: expected, reason: "source_down" };
            else if (automation.can_confirm_run === false || automation.can_detect_missed === false || (automation.running_at != null && Date.parse(automation.running_at) >= expectedMs - RUN_SLACK_MS)) unsure = { at: expected, reason: "execution_unconfirmed" };
            else missed = expected;
          }
        }
        if (expected === null) this.observedOccurrences.delete(key);
        else if (this.observedOccurrences.get(key)?.expected !== expected) this.observedOccurrences.set(key, { expected, at: nowMs });
        const nativeStatus = automation.status.toLowerCase();
        const task: ScheduledTask = {
          key,
          agent: this.agent,
          name: automation.name,
          project: projectOf(automation.cwd),
          cwd: automation.cwd,
          status: statusOf(automation.status),
          ...(nativeStatus === "done" || nativeStatus === "completed" || nativeStatus === "error" ? { native_status: nativeStatus } : {}),
          kind: automation.kind,
          rrule: automation.rrule,
          ...(automation.rule !== undefined ? { rule: automation.rule } : {}),
          ...(automation.running_at !== undefined ? { running_at: automation.running_at } : {}),
          ...(automation.last_status !== undefined ? { last_status: automation.last_status } : {}),
          ...(automation.last_attempt_at !== undefined ? { last_attempt_at: automation.last_attempt_at } : {}),
          ...(automation.can_confirm_run !== undefined ? { can_confirm_run: automation.can_confirm_run } : {}),
          ...(automation.can_detect_missed !== undefined ? { can_detect_missed: automation.can_detect_missed } : {}),
          next_run_at: next,
          last_run_at: automation.last_run_at,
          thread: automation.thread === null ? null : { session: automation.thread, linked: sessions.has(automation.thread) },
          run: newest === null ? null : { session: newest.thread_id, status: newest.status, at: newest.created_at, linked: sessions.has(newest.thread_id), ...(newest.evidence === undefined ? {} : { evidence: newest.evidence }) },
          missed: missed === null ? null : { at: missed },
          unsure,
          observed_at: now,
        };
        tasks.push(task);
        for (const run of runs) if (sessions.has(run.thread_id)) link(run.thread_id, task);
        if (automation.thread !== null && sessions.has(automation.thread)) link(automation.thread, task);
        this.rows.set(key, {
          task_key: key,
          agent: this.agent,
          name: task.name,
          project: task.project,
          cwd: task.cwd,
          status: task.status,
          kind: task.kind,
          rrule: task.rrule,
          next_run_at: next,
          last_run_at: task.last_run_at,
          expected_at: expected,
          missed_at: missed,
          unsure_at: unsure?.at ?? null,
          unsure_reason: unsure?.reason ?? null,
          run_session: task.run?.session ?? null,
          run_status: task.run?.status ?? null,
          run_at: task.run?.at ?? null,
          observed_at: now,
        });
      }
      for (const key of [...this.rows.keys()]) if (!seen.has(key)) { this.rows.delete(key); this.observedOccurrences.delete(key); }
      tasks.sort(byNextRun);
    }
    const schedule: Schedule = { sources: [this.source], tasks };
    // What counts as a change: the tasks (less the pass time) and the source's outcome.
    const text = JSON.stringify(schedule.tasks.map((task) => ({ ...task, observed_at: null }))) + JSON.stringify({ outcome: this.source.outcome, code: this.source.code });
    const changed = text !== this.last;
    if (changed) {
      this.last = text;
      this.schedule = schedule;
      this.deps.store.replaceScheduledTasks(this.agent, [...this.rows.values()]);
    } else {
      this.schedule = schedule;
    }
    return { schedule, changed, links };
  }
}

/** Each scheduler owns its observation continuity and stored rows; a failure cannot erase another. */
export class ScheduleCollection {
  private readonly trackers: { agent: string; tracker: ScheduleTracker }[];
  constructor(deps: Omit<Deps, "agent" | "read">, sources: { agent: string; read: () => AutomationsRead }[]) {
    this.trackers = sources.map((source) => ({ agent: source.agent, tracker: new ScheduleTracker({ ...deps, ...source }) }));
  }
  current(): Schedule {
    return { sources: this.trackers.flatMap(({ tracker }) => tracker.current().sources), tasks: this.trackers.flatMap(({ tracker }) => tracker.current().tasks).sort(byNextRun) };
  }
  refresh(sessions: (agent: string) => ReadonlySet<string>): Refresh {
    const results = this.trackers.map(({ agent, tracker }) => tracker.refresh(sessions(agent)));
    return { schedule: this.current(), changed: results.some((result) => result.changed), links: new Map(results.flatMap((result) => [...result.links])) };
  }
}
