// pi extension: session, turn and tool events, as named fields only. Prompts, tool arguments and
// results are in other fields of these events and are not read.
import { createReporter } from "../reporter-runtime.js";

const { report, note } = createReporter("pi");

export default function (pi) {
  const send = (name, ctx, fields) => {
    try {
      return report({ hook_event_name: name, session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, ...fields });
    } catch (error) {
      note(`reporter_event ${error.name}`);
      return Promise.resolve();
    }
  };
  pi.on("session_start", (event, ctx) => void send("session_start", ctx, { source: event.reason }));
  pi.on("agent_start", (_event, ctx) => void send("agent_start", ctx));
  pi.on("tool_execution_start", (event, ctx) => void send("tool_execution_start", ctx, { tool_name: event.toolName, tool_use_id: event.toolCallId }));
  pi.on("tool_execution_end", (event, ctx) => void send("tool_execution_end", ctx, { tool_use_id: event.toolCallId, reason: event.isError ? "error" : undefined }));
  pi.on("ui_prompt_start", (_event, ctx) => void send("ui_prompt_start", ctx));
  pi.on("ui_prompt_end", (_event, ctx) => void send("ui_prompt_end", ctx));
  pi.on("agent_settled", (event, ctx) => void send("agent_settled", ctx, { reason: event.aborted ? "aborted" : undefined }));
  // Returned so that pi waits for it: the process may exit right after this handler.
  pi.on("session_shutdown", (event, ctx) => send("session_shutdown", ctx, { reason: event.reason }));
}
