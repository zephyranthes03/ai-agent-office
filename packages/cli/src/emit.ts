// `agent-office emit`: a script or cron job reports its own state as a standard event. The event goes
// to the daemon like a hook's envelope (the daemon proves it holds the token first); when the daemon
// is not running it waits in spool/events.jsonl and the daemon takes it on its next drain.
import { ORIGINS, STATES, WAIT_REASONS } from "@agent-office/core";
import { deliverFresh, findDaemon, officeHome, spoolLine } from "./transport.ts";

const AGENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OUTCOMES = ["completed", "failed", "interrupted", "cancelled"];
const POST_MS = 2000;

export const EMIT_USAGE =
  "agent-office emit --agent <slug> --session <id> --state <state> [--detail <text>] [--ttl <seconds>] [--outcome <outcome>] [--reason <reason> [--target <text>]] [--parent <id>] [--origin <origin>] [--cwd <dir>] [--project <name>] [--ended]";

const VALUED = new Set(["--agent", "--session", "--state", "--detail", "--ttl", "--outcome", "--reason", "--target", "--parent", "--origin", "--cwd", "--project"]);

/** The standard event for these arguments, or the reason they do not make one. */
export function emitEvent(args: string[], now: Date): { event: Record<string, unknown> } | { problem: string } {
  const values = new Map<string, string>();
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--ended") ended = true;
    else if (VALUED.has(arg) && i + 1 < args.length) values.set(arg, args[++i]!);
    else return { problem: `unexpected argument ${JSON.stringify(arg)}` };
  }
  const agent = values.get("--agent");
  const session = values.get("--session");
  const state = values.get("--state");
  if (agent === undefined || !AGENT.test(agent)) return { problem: "--agent needs a slug: lowercase letters, digits and -, at most 64" };
  if (session === undefined || session === "" || session.length > 256) return { problem: "--session needs an id of 1 to 256 characters" };
  if (state === undefined || !(STATES as readonly string[]).includes(state)) return { problem: `--state needs one of ${STATES.join(", ")}` };
  const event: Record<string, unknown> = { schema_version: 1, agent, session, state, ts: now.toISOString() };
  const detail = values.get("--detail");
  if (detail !== undefined) event["detail"] = detail;
  const ttl = values.get("--ttl");
  if (ttl !== undefined) {
    const seconds = Number(ttl);
    if (!Number.isInteger(seconds) || seconds < 1) return { problem: "--ttl needs a whole number of seconds" };
    event["ttl_s"] = seconds;
  }
  const outcome = values.get("--outcome");
  if (outcome !== undefined) {
    if (!OUTCOMES.includes(outcome)) return { problem: `--outcome needs one of ${OUTCOMES.join(", ")}` };
    event["result"] = { outcome, at: now.toISOString() };
  }
  const reason = values.get("--reason");
  if (reason !== undefined) {
    if (!(WAIT_REASONS as readonly string[]).includes(reason)) return { problem: `--reason needs one of ${WAIT_REASONS.join(", ")}` };
    event["waiting_on"] = { reason, target: values.get("--target") ?? null };
  } else if (values.has("--target")) {
    return { problem: "--target goes with --reason" };
  }
  if ((state === "waiting_user" || state === "waiting_dependency") && reason === undefined) return { problem: `--state ${state} needs --reason` };
  const origin = values.get("--origin");
  if (origin !== undefined) {
    if (!(ORIGINS as readonly string[]).includes(origin)) return { problem: `--origin needs one of ${ORIGINS.join(", ")}` };
    event["origin"] = origin;
  }
  for (const [flag, field] of [["--parent", "parent"], ["--cwd", "cwd"], ["--project", "project"]] as const) {
    const value = values.get(flag);
    if (value !== undefined) event[field] = value;
  }
  if (ended) event["lifecycle"] = "ended";
  return { event };
}

/**
 * Sends the event, or spools it when the daemon cannot take it now. Exit codes: 0 delivered or
 * spooled, 1 the daemon refused the event (or took it without a readable answer), 2 bad arguments.
 */
export async function runEmit(args: string[], out: { error: (text: string) => void } = { error: (text) => process.stderr.write(text) }): Promise<number> {
  const made = emitEvent(args, new Date());
  if ("problem" in made) {
    out.error(`${made.problem}\nusage: ${EMIT_USAGE}\n`);
    return 2;
  }
  const home = officeHome();
  const daemon = findDaemon(home);
  if (!("problem" in daemon)) {
    const reply = await deliverFresh(home, daemon, "/v1/events", JSON.stringify(made.event), Date.now() + POST_MS);
    if ("status" in reply && reply.status === 202) {
      let result: { ok?: unknown; error?: unknown } | undefined;
      try {
        const parsed = JSON.parse(reply.body) as unknown;
        const results = parsed !== null && typeof parsed === "object" ? (parsed as { results?: unknown }).results : undefined;
        const first: unknown = Array.isArray(results) ? results[0] : undefined;
        if (first !== null && typeof first === "object") result = first;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Left undefined: reported below as a reply that could not be read.
      }
      if (result?.ok === true) return 0;
      // Taken by the daemon but not confirmed: report it rather than assume either way.
      out.error(result === undefined ? "the daemon took the request, but its reply could not be read\n" : `the daemon refused the event: ${typeof result.error === "string" ? result.error : "unknown reason"}\n`);
      return 1;
    }
    if ("status" in reply && [400, 401, 413].includes(reply.status)) {
      out.error(`the daemon refused the event (HTTP ${reply.status})\n`);
      return 1;
    }
  }
  // Not running, not reachable or busy: the daemon takes the event from the spool on its next drain.
  spoolLine(home, "events", made.event);
  return 0;
}
