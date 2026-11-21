// Codex hook → signal rows that Claude Code does not have (state rules §3.2).
import { clipDetail } from "@agent-office/core";
import descriptor from "./descriptor.json" with { type: "json" };
import { createMapper } from "../hook-common.ts";
import type { Mapper } from "../hook-common.ts";

/** The `approvals_reviewer` under which Codex's own reviewer, not the owner, answers approval requests. */
export const CODEX_AUTO_REVIEWER = "auto_review";

export const codexMapper: Mapper = createMapper(descriptor, (event, base) => {
  switch (event.hook_event_name) {
    // Codex runs this hook before its reviewer decides (0.166.0, core/src/tools/approvals.rs). When the
    // turn's reviewer is Codex's own (`meta.approvals_reviewer`, read by the daemon from the rollout
    // the hook names), nobody is waited for; any other reviewer, or no reading, is the owner's wait.
    case "PermissionRequest":
      if (event.meta?.["approvals_reviewer"] !== CODEX_AUTO_REVIEWER) return null;
      return [{ ...base, name: "approval_reviewed", tool: event.tool_name || null, detail: clipDetail(event.detail) }];
    // Sent for Esc while a command runs and for Esc on a permission prompt (captured 0.163.0).
    case "Interrupt":
      return [{ ...base, name: "turn_interrupted" }];
    default:
      return null;
  }
});

export { descriptor as codexDescriptor };
