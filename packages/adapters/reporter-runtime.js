// The part of an agent reporter that talks to the office: one event at a time goes to the hook
// program on stdin, in order, with no shell and nothing printed. The hook does the rest (the
// allowlist, the daemon's proof, the spool). A failure is noted by code, once, and never reaches
// the agent; with the office gone there is nothing to run and nothing else happens.
import { spawn } from "node:child_process";
import { appendFile } from "node:fs";
import { dirname, join } from "node:path";

const LAUNCHER = "__AGENT_OFFICE_LAUNCHER__";
const LOG = join(dirname(dirname(LAUNCHER)), "logs", "hook.log");
/** Past the hook's own 2 s limit: only a hook that hung gets here. */
const HOOK_LIMIT_MS = 4000;
const SEEN_MAX = 4096;
const SHARED = Symbol.for("agent-office.reporter");

/** `envKeys` names the variables the hook may inherit; without it, the whole environment. */
export function createReporter(agent, envKeys) {
  // On globalThis: an agent may load this file more than once in one process (OpenCode, per folder).
  const shared = (globalThis[SHARED] ??= { queue: Promise.resolve(), seen: new Set(), noted: new Set() });
  const env = envKeys === undefined ? process.env : Object.fromEntries(envKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));

  const note = (code) => {
    if (shared.noted.has(code)) return;
    shared.noted.add(code);
    // The log folder goes with the office; there is nowhere further to report that.
    appendFile(LOG, `${new Date().toISOString()} ${code}\n`, { mode: 0o600 }, () => undefined);
  };

  const deliver = (stdin) =>
    new Promise((resolve) => {
      // In its own process group: an agent that is shutting down signals its group, and the last events are the ones that matter.
      const child = spawn(LAUNCHER, [agent], { stdio: ["pipe", "ignore", "ignore"], env, detached: true });
      const limit = setTimeout(() => child.kill("SIGKILL"), HOOK_LIMIT_MS);
      const done = () => {
        clearTimeout(limit);
        resolve();
      };
      child.on("error", (error) => {
        note(`reporter_spawn ${error.code ?? error.name}`);
        done();
      });
      child.on("close", done);
      child.stdin?.on("error", (error) => note(`reporter_stdin ${error.code ?? error.name}`));
      child.stdin?.end(JSON.stringify(stdin));
      child.unref();
    });

  /** Queues one event; the promise settles when the hook has finished with it. */
  const report = (stdin) => {
    shared.queue = shared.queue.then(() => deliver(stdin)).catch((error) => note(`reporter_failed ${error.name}`));
    return shared.queue;
  };

  /** Settles when everything queued has reached the hook, or after `limitMs`, whichever is first. */
  const flush = (limitMs) =>
    new Promise((resolve) => {
      const limit = setTimeout(resolve, limitMs);
      void shared.queue.then(() => {
        clearTimeout(limit);
        resolve();
      });
    });

  /** True the first time an event id is seen in this process. */
  const first = (id) => {
    if (shared.seen.has(id)) return false;
    shared.seen.add(id);
    if (shared.seen.size > SEEN_MAX) shared.seen.delete(shared.seen.values().next().value);
    return true;
  };

  return { report, first, flush, note };
}
