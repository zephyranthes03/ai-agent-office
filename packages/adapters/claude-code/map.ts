// Claude Code hook → signal rows that Codex does not have (state rules §3.1).
import type { Signal, SignalBase } from "@agent-office/core";
import descriptor from "./descriptor.json" with { type: "json" };
import { createMapper, toolFinished } from "../hook-common.ts";
import type { HookEvent, Mapper } from "../hook-common.ts";

const INPUT_NOTIFICATIONS = new Set(["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);
const INPUT_RESOLVED_NOTIFICATIONS = new Set(["elicitation_complete", "elicitation_response"]);

function mapNotification(event: HookEvent, base: SignalBase): Signal[] {
  const type = event.notification_type || null;
  // permission_prompt is the idempotent backup of PermissionRequest and names no tool.
  if (type === "permission_prompt") return [{ ...base, name: "approval_requested", tool_use_id: null, tool: null, detail: null }];
  if (type === "idle_prompt") return [{ ...base, name: "idle_hint" }];
  if (type !== null && INPUT_NOTIFICATIONS.has(type)) return [{ ...base, name: "input_requested", target: type }];
  if (type !== null && INPUT_RESOLVED_NOTIFICATIONS.has(type)) return [{ ...base, name: "input_resolved" }];
  // auth_success, agent_completed, quota_* and anything new: no state change.
  return [];
}

export const claudeCodeMapper: Mapper = createMapper(descriptor, (event, base) => {
  switch (event.hook_event_name) {
    case "PostToolUseFailure":
      return toolFinished(event, base, false, false);
    case "PermissionDenied":
      return toolFinished(event, base, false, true);
    case "StopFailure":
      return [{ ...base, name: "turn_ended", ok: false }];
    case "Notification":
      return mapNotification(event, base);
    default:
      return null;
  }
});

export { descriptor as claudeCodeDescriptor };
