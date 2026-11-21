// OpenCode 2 plugin: session, tool and permission events, as named fields only. The subscription
// names its types, so the events that carry prompts, replies and commands are never delivered here.
import { createReporter } from "../reporter-runtime.js";

const TYPES = [
  "session.created",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.tool.input.started",
  "session.tool.success",
  "session.tool.failed",
  "permission.asked",
  "permission.replied",
];

// The server's environment says nothing about any session's terminal.
const { report, first, flush, note } = createReporter("opencode", ["HOME", "USER", "PATH"]);
/** How long a server that is shutting down may wait for the last events to reach the hook. */
const FLUSH_MS = 3000;

/**
 * The event's folder. `session.execution.*` name none, and a private server's first session is
 * created before the plugin is set up, so a session not yet seen with a folder takes this instance's.
 */
function folderOf(event, context) {
  const stated = event.location?.directory;
  const unseen = first(`folder:${event.data?.sessionID}`);
  return stated ?? (unseen ? context.location?.directory : undefined);
}

function stdinOf(event, context) {
  const data = event.data ?? {};
  const base = { hook_event_name: event.type, session_id: data.sessionID, cwd: folderOf(event, context) };
  switch (event.type) {
    case "session.tool.input.started":
      return { ...base, tool_name: data.name, tool_use_id: data.id };
    case "session.tool.success":
    case "session.tool.failed":
      return { ...base, tool_use_id: data.id };
    case "permission.asked":
      return { ...base, tool_name: data.action, tool_use_id: data.source?.id };
    default:
      return base;
  }
}

async function follow(context) {
  // One plugin instance per folder in use, and each subscription sees the whole server.
  for await (const event of context.event.subscribe({ types: TYPES })) {
    if (first(event.id)) void report(stdinOf(event, context));
  }
}

export default {
  id: "agent-office",
  setup: (context) => {
    follow(context).catch((error) => note(`reporter_subscribe ${error.name}`));
    // A private server exits right after its turn; without this its last events would be lost.
    return () => flush(FLUSH_MS);
  },
};
