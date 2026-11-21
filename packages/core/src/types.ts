// Session snapshot, reducer inputs and the signal vocabulary (§2 of the state rules).
// Pure data: every field is JSON-serialisable and timestamps are ISO 8601 strings.

export type State = "idle" | "working" | "waiting_dependency" | "waiting_user" | "error" | "done" | "unknown" | "paused" | "cancelled";
export type Lifecycle = "active" | "ended";
export type WaitReason = "approval" | "input" | "child" | "tool" | "schedule";
export type Outcome = "completed" | "failed" | "interrupted" | "cancelled";
export type Origin = "human" | "scheduled" | "automation" | "sdk" | "external" | "unknown";
export type ToolClass = "normal" | "dependency" | "dependency_tool" | "input" | "approval" | "delegation";
export type Control = "pause" | "resume" | "interrupt_turn" | "cancel" | "rerun";

export const STATES: readonly State[] = ["idle", "working", "waiting_dependency", "waiting_user", "error", "done", "unknown", "paused", "cancelled"];
export const WAIT_REASONS: readonly WaitReason[] = ["approval", "input", "child", "tool", "schedule"];
export const ORIGINS: readonly Origin[] = ["human", "scheduled", "automation", "sdk", "external", "unknown"];
export const TOOL_CLASSES: readonly ToolClass[] = ["normal", "dependency", "dependency_tool", "input", "approval", "delegation"];

export type WaitingOn = { reason: WaitReason; target: string | null };
export type Result = { outcome: Outcome; at: string };
export type ActiveTool = { tool: string; detail: string | null; class: ToolClass; started_at: string };
export type PendingApproval = { tool_use_id: string | null; detail: string | null };
/**
 * Work the session handed to another session (a `delegation` tool, such as the Claude app's cloud
 * session start): where it went and who asked, as the tool's own enums; never what was asked.
 */
export type Delegation = { tool_use_id: string; target: string | null; initiation: string | null; started_at: string };
/** `open`: delegations whose result has not come back; `returned`: how many came back (as task notifications). */
export type Delegations = { open: Delegation[]; returned: number };
/** What a tool of class `delegation` said about the work it handed over (the envelope's `tool_meta`). */
export type ToolMeta = { target: string | null; initiation: string | null };
/** A prompt that is another task's result coming back (`turnOrigin: task_notification`), with its producer and run id. */
export type Returned = { producer: string | null; run_id: string | null };

export type Snapshot = {
  session: string;
  agent: string;
  parent: string | null;
  child_type: string | null;
  lifecycle: Lifecycle;
  state: State;
  /** What to restore on recovery from `unknown` (A4). */
  state_before_unknown: State | null;
  waiting_on: WaitingOn | null;
  /** Current tool or target, at most 64 characters, never content. */
  detail: string | null;
  result: Result | null;
  origin: Origin;
  /** Keyed by tool_use_id. */
  active_tools: Record<string, ActiveTool>;
  /** Current turn only; defends against late starts (A3). */
  finished_tool_ids: string[];
  pending_approval: PendingApproval | null;
  /** Child session ids, in the order they were attached. */
  children: string[];
  /** Work handed to other sessions and not yet back (a layer over the state: the session is not waiting). */
  delegations: Delegations;
  /**
   * Background work of the session still running when its agent last said (Claude Code's `Stop` and
   * `SubagentStop` list it; the hook forwards only how many): a layer over the state, like `delegations`.
   * 0 when none was reported.
   */
  background: number;
  /**
   * When the work behind the current turn began: this turn's prompt, or the prompt of an earlier turn
   * whose background work was still running when this one started (C1). Null before any prompt.
   */
  work_since: string | null;
  /** Per-session override from a direct report's ttl_s (F1). */
  stale_after_s: number | null;
  last_signal_at: string;
  last_alive_at: string | null;
  state_since: string;
  /** When the current user wait of this kind (`waiting_on.reason`) began; null outside waiting_user (I2, H6). */
  waiting_since: string | null;
  hold_until: string | null;
};

/** All known sessions, keyed by session id. */
export type Snapshots = Record<string, Snapshot>;

/**
 * Common fields of every signal. `child_of` and `child_type` are set when an adapter routes a hook
 * to a child session (`<session>/<agent id>`) so that A1 can create the child on first sight.
 */
export type SignalBase = {
  kind: "signal";
  at: string;
  session: string;
  agent: string;
  child_of?: string | null;
  child_type?: string | null;
};

export type SignalPayload =
  | { name: "session_started"; resumed: boolean; origin: Origin | null }
  | { name: "session_ended"; reason: string | null }
  /** `returned`: the prompt is another task's result coming back; it closes the oldest open delegation, when any. */
  | { name: "prompt_submitted"; origin: Origin | null; returned?: Returned | null }
  /** `meta`: for a `delegation` tool, where the work went and who asked. */
  | { name: "tool_started"; tool_use_id: string; tool: string; detail: string | null; class: ToolClass; meta?: ToolMeta | null }
  | { name: "tool_finished"; tool_use_id: string; ok: boolean; denied: boolean }
  | { name: "approval_requested"; tool_use_id: string | null; tool: string | null; detail: string | null }
  /** An approval request the agent's own reviewer decides (Codex auto-review): nobody is waited for. */
  | { name: "approval_reviewed"; tool: string | null; detail: string | null }
  | { name: "input_requested"; target: string | null }
  | { name: "input_resolved" }
  /** `background`: how much of the session's background work still runs, when the agent says (null: it did not). */
  | { name: "turn_ended"; ok: boolean; background?: number | null }
  | { name: "turn_interrupted" }
  | { name: "idle_hint" }
  | { name: "child_started"; child: string; type: string | null }
  | { name: "child_stopped"; child: string; background?: number | null }
  | { name: "parent_linked"; parent: string; child_type: string | null }
  | { name: "control_confirmed"; control: Control }
  | {
      name: "state_reported";
      state: State;
      waiting_on: WaitingOn | null;
      detail: string | null;
      result: { outcome: Outcome; at: string | null } | null;
      ttl_s: number | null;
      parent: string | null;
      origin: Origin | null;
      lifecycle: Lifecycle | null;
    };

export type Signal = SignalBase & SignalPayload;
export type SignalName = SignalPayload["name"];

export type Tick = { kind: "tick"; at: string };
export type Liveness = { kind: "liveness"; at: string; session: string; alive: boolean; confidence: "exact" | "ancestor" };
export type AdapterStatus = { kind: "adapter_status"; at: string; agent: string; connected: boolean };
/** The owner sent a session home from its card (rule G2). */
export type Dismissal = { kind: "dismissal"; at: string; session: string };
/** The owner's stop of a session's process was confirmed: the process it was bound to is gone (rule G3). */
export type Stopped = { kind: "stopped"; at: string; session: string };

export type Input = Signal | Tick | Liveness | AdapterStatus | Dismissal | Stopped;

/** One applied rule (ids such as `A1`, `E5`, `H2`, named in rules.ts) and the session it touched. */
export type TraceEntry = { rule: string; session: string | null };
