// pi extension event → signals (the reporter forwards pi's own event names). `reason` is pi's reason
// for a session's end, and a one-word outcome on `agent_settled` and `tool_execution_end`.
import descriptor from "./descriptor.json" with { type: "json" };
import { createMapper, mapCommon, toolFinished } from "../hook-common.ts";
import type { Mapper } from "../hook-common.ts";

const COMMON: Record<string, string> = {
  session_start: "SessionStart",
  session_shutdown: "SessionEnd",
  agent_start: "UserPromptSubmit",
  tool_execution_start: "PreToolUse",
};

export const piMapper: Mapper = createMapper(descriptor, (event, base, classOf) => {
  // A reload takes the extensions down and up again in the same session.
  if (event.hook_event_name === "session_start" && event.source === "reload") return [];
  if (event.hook_event_name === "session_shutdown" && event.reason === "reload") return [];
  const common = Object.hasOwn(COMMON, event.hook_event_name) ? COMMON[event.hook_event_name] : undefined;
  if (common !== undefined) return mapCommon({ ...event, hook_event_name: common }, base, classOf);
  switch (event.hook_event_name) {
    case "tool_execution_end":
      return toolFinished(event, base, event.reason !== "error", false);
    case "ui_prompt_start":
      return [{ ...base, name: "input_requested", target: null }];
    case "ui_prompt_end":
      return [{ ...base, name: "input_resolved" }];
    case "agent_settled":
      return event.reason === "aborted" ? [{ ...base, name: "turn_interrupted" }] : [{ ...base, name: "turn_ended", ok: true }];
    default:
      return [];
  }
});

export { descriptor as piDescriptor };
