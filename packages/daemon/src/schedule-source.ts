// Normalized read-only scheduler metadata. Provider readers discard every other field.
export type Automation = {
  id: string;
  name: string | null;
  status: string;
  kind: string;
  rrule: string | null;
  next_run_at: string | null;
  /** The occurrence `next_run_at` stands for before the app's own delay; its meaning is unverified. */
  next_run_nominal_at: string | null;
  last_run_at: string | null;
  /** The first folder of `cwds`, when the list holds one. */
  cwd: string | null;
  /** `target_thread_id`: the thread the task lives in. A heartbeat task (observed 2026-11-01) runs as turns of this thread and writes no run row. */
  thread: string | null;
  /** Native rule, when the scheduler does not use RRULE. Never evaluated here. */
  rule?: { kind: "cron" | "interval" | "at"; expression?: string; every_ms?: number; at?: string; timezone?: string };
  /** Scheduler evidence, distinct from a hook-observed live session. */
  running_at?: string | null;
  last_status?: string | null;
  last_attempt_at?: string | null;
  /** False when the source cannot prove actual execution for an occurrence. */
  can_confirm_run?: boolean;
  /** False if completion-only metadata cannot rule out an in-flight occurrence. */
  can_detect_missed?: boolean;
};
export type AutomationRun = { thread_id: string; automation_id: string; status: string | null; created_at: string; evidence?: "session_created" };
export type AutomationsOutcome = "ok" | "empty" | "absent" | "unreadable" | "unsupported";
/** `code`: the error code of an unreadable file, or the first missing column of an unsupported schema. */
export type AutomationsRead = { outcome: AutomationsOutcome; code: string | null; automations: Automation[]; runs: AutomationRun[] };

