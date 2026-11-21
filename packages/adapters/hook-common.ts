// Hook → signal mapping shared by the agents (state rules §3). Pure: an event and its
// observation time go in, zero or more signals come out. Rows that only one agent has live in
// that agent's map.ts; everything here is common to Claude Code and Codex.
import { clipDetail, originOf, TOOL_CLASSES } from "@agent-office/core";
import type { Origin, Returned, Signal, SignalBase, ToolClass, ToolMeta } from "@agent-office/core";

/**
 * The `event` object of a hook envelope: the allowlisted hook fields. Absent fields may be missing,
 * null or empty (real envelopes send null). `meta` is what the transcript strategy read for this
 * event, attached by the daemon (or by a replay case); it is never sent by the hook itself.
 */
export type HookEvent = {
  hook_event_name: string;
  session_id: string;
  cwd?: string | null;
  transcript_path?: string | null;
  permission_mode?: string | null;
  prompt_id?: string | null;
  turn_id?: string | null;
  agent_id?: string | null;
  agent_type?: string | null;
  tool_name?: string | null;
  tool_use_id?: string | null;
  notification_type?: string | null;
  source?: string | null;
  reason?: string | null;
  model?: string | null;
  detail?: string | null;
  tool_meta?: { target?: string | null; initiation?: string | null } | null;
  /** On `Stop` and `SubagentStop`: how much of the session's background work still runs (the hook counts Claude Code's `background_tasks`); null when the agent sent no list. */
  background?: number | null;
  meta?: Record<string, unknown> | null;
};

export type Mapper = (event: HookEvent, at: string) => Signal[];

/** The part of a descriptor the mapping needs. */
export type MappingDescriptor = { id: string; tool_classes?: Record<string, string> | undefined };

export type ToolClassOf = (tool: string) => ToolClass;

/** A present, non-empty string; null and "" both mean "absent". */
const text = (value: string | null | undefined): string | null => (value ? value : null);

/** Tool class from the descriptor's `tool_classes`; undeclared tools and unknown values are `normal`. */
export function toolClassOf(descriptor: MappingDescriptor): ToolClassOf {
  const classes = descriptor.tool_classes ?? {};
  return (tool) => {
    const declared = Object.hasOwn(classes, tool) ? classes[tool] : undefined;
    return declared !== undefined && (TOOL_CLASSES as readonly string[]).includes(declared) ? (declared as ToolClass) : "normal";
  };
}

const TURN_ORIGINS: Record<string, Origin> = { human: "human", scheduled: "scheduled", sdk: "sdk" };

/**
 * Origin from the metadata a strategy attached: a transcript `turnOrigin` maps human, scheduled and
 * sdk and nothing else (§3.1); a strategy-provided `origin` is taken as is. Null when nothing was read.
 */
export function originFromMeta(meta: HookEvent["meta"]): Origin | null {
  const turnOrigin = meta?.["turnOrigin"];
  if (typeof turnOrigin === "string") return Object.hasOwn(TURN_ORIGINS, turnOrigin) ? TURN_ORIGINS[turnOrigin]! : "unknown";
  const origin = meta?.["origin"];
  return typeof origin === "string" ? originOf(origin) : null;
}

/**
 * A prompt that is another task's result coming back: the transcript's `turnOrigin: task_notification`,
 * with the origin's `producer` and `runId` the strategy read (flattened keys). Null for any other prompt.
 */
export function returnedFromMeta(meta: HookEvent["meta"]): Returned | null {
  if (meta?.["turnOrigin"] !== "task_notification") return null;
  const producer = meta["origin.producer"];
  const runId = meta["origin.runId"];
  return { producer: typeof producer === "string" ? producer : null, run_id: typeof runId === "string" ? runId : null };
}

/** The envelope's `tool_meta` as the signal carries it (a delegation tool's `target` and `initiation`); null when the hook sent none. */
export function toolMetaOf(event: HookEvent): ToolMeta | null {
  const meta = event.tool_meta;
  if (!meta) return null;
  return { target: text(meta.target), initiation: text(meta.initiation) };
}

/**
 * Where a signal goes: a hook carrying `agent_id` belongs to the child session `<session>/<agent_id>`,
 * except `SubagentStart`/`SubagentStop`, which are the parent's view of that child.
 */
export function routeOf(event: HookEvent, agent: string, at: string): SignalBase {
  const agentId = text(event.agent_id);
  const parentView = event.hook_event_name === "SubagentStart" || event.hook_event_name === "SubagentStop";
  if (agentId === null || parentView) return { kind: "signal", at, session: event.session_id, agent };
  return { kind: "signal", at, session: `${event.session_id}/${agentId}`, agent, child_of: event.session_id, child_type: text(event.agent_type) };
}

/** The envelope's count of background work still running: a whole number, else null (none sent). */
const backgroundOf = (event: HookEvent): number | null => (typeof event.background === "number" && Number.isInteger(event.background) && event.background >= 0 ? event.background : null);

/** A tool event without `tool_use_id` (not seen in any capture) gets an id that nothing else will match. */
export function toolUseIdOf(event: HookEvent, tool: string, at: string): string {
  return text(event.tool_use_id) ?? `${tool}@${at}`;
}

export function toolFinished(event: HookEvent, base: SignalBase, ok: boolean, denied: boolean): Signal[] {
  const tool = event.tool_name ?? "";
  return [{ ...base, name: "tool_finished", tool_use_id: toolUseIdOf(event, tool, base.at), ok, denied }];
}

/** Rows shared by both agents; `null` means the event is not a common one. */
export function mapCommon(event: HookEvent, base: SignalBase, classOf: ToolClassOf): Signal[] | null {
  switch (event.hook_event_name) {
    case "SessionStart":
      if (event.source === "compact") return [];
      return [{ ...base, name: "session_started", resumed: event.source === "resume", origin: originFromMeta(event.meta) }];
    case "SessionEnd":
      return [{ ...base, name: "session_ended", reason: text(event.reason) }];
    case "UserPromptSubmit":
      return [{ ...base, name: "prompt_submitted", origin: originFromMeta(event.meta), returned: returnedFromMeta(event.meta) }];
    case "PreToolUse": {
      const tool = text(event.tool_name);
      if (tool === null) return [];
      const toolClass = classOf(tool);
      return [{ ...base, name: "tool_started", tool_use_id: toolUseIdOf(event, tool, base.at), tool, detail: clipDetail(event.detail), class: toolClass, ...(toolClass === "delegation" ? { meta: toolMetaOf(event) } : {}) }];
    }
    case "PostToolUse":
      return toolFinished(event, base, true, false);
    case "PermissionRequest":
      return [{ ...base, name: "approval_requested", tool_use_id: text(event.tool_use_id), tool: text(event.tool_name), detail: clipDetail(event.detail) }];
    case "Stop":
      return [{ ...base, name: "turn_ended", ok: true, background: backgroundOf(event) }];
    case "SubagentStart": {
      const agentId = text(event.agent_id);
      if (agentId === null) return [];
      return [{ ...base, name: "child_started", child: `${event.session_id}/${agentId}`, type: text(event.agent_type) }];
    }
    case "SubagentStop": {
      const agentId = text(event.agent_id);
      if (agentId === null) return [];
      return [{ ...base, name: "child_stopped", child: `${event.session_id}/${agentId}`, background: backgroundOf(event) }];
    }
    default:
      return null;
  }
}

/** Builds an agent's mapper: its own rows first, then the common ones; unknown events map to nothing. */
export function createMapper(descriptor: MappingDescriptor, own: (event: HookEvent, base: SignalBase, classOf: ToolClassOf) => Signal[] | null): Mapper {
  const classOf = toolClassOf(descriptor);
  return (event, at) => {
    const base = routeOf(event, descriptor.id, at);
    return own(event, base, classOf) ?? mapCommon(event, base, classOf) ?? [];
  };
}
