// OpenCode event → signals (the reporter forwards OpenCode's own event names). Rows that mean the
// same as a Claude Code or Codex hook go through the common table under that hook's name.
import descriptor from "./descriptor.json" with { type: "json" };
import { createMapper, mapCommon, toolFinished } from "../hook-common.ts";
import type { Mapper } from "../hook-common.ts";

const COMMON: Record<string, string> = {
  "session.created": "SessionStart",
  "session.deleted": "SessionEnd",
  "session.execution.started": "UserPromptSubmit",
  "session.tool.input.started": "PreToolUse",
  "session.tool.success": "PostToolUse",
  "permission.asked": "PermissionRequest",
  "session.execution.succeeded": "Stop",
};

export const opencodeMapper: Mapper = createMapper(descriptor, (event, base, classOf) => {
  const common = Object.hasOwn(COMMON, event.hook_event_name) ? COMMON[event.hook_event_name] : undefined;
  if (common !== undefined) return mapCommon({ ...event, hook_event_name: common }, base, classOf);
  switch (event.hook_event_name) {
    case "session.tool.failed":
      return toolFinished(event, base, false, false);
    // The wait ends when the owner answers; the tool may still run for a long time after that.
    case "permission.replied":
      return [{ ...base, name: "input_resolved" }];
    case "session.execution.failed":
      return [{ ...base, name: "turn_ended", ok: false }];
    case "session.execution.interrupted":
      return [{ ...base, name: "turn_interrupted" }];
    default:
      return [];
  }
});

export { descriptor as opencodeDescriptor };
