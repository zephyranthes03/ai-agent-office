// The agents' schedulers as the daemon reads them: what is planned, which run opened which session
// (by exact thread id), and occurrences that passed with no run. A missed one is a needs-you entry
// under the task's key and is notified like the others.
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultClaudeAppDir } from "./app-links.ts";
import { readClaudeSchedules } from "./claude-schedules.ts";
import { readCodexAutomations } from "./codex-automations.ts";
import type { DaemonOptions } from "./daemon-options.ts";
import { readHermesSchedules, readOpenClawSchedules } from "./local-schedules.ts";
import type { AgentHomes } from "./log-files.ts";
import { defaultOpenCodeDbPath, readOpenCodeSchedules } from "./opencode-schedules.ts";
import { ScheduleCollection } from "./schedule.ts";
import type { Store } from "./store.ts";

export function wireSchedules(deps: {
  options: Pick<DaemonOptions, "scheduleHomes" | "claudeAppDir">;
  homes: AgentHomes;
  store: Store;
  now: () => number;
  log: (line: string) => void;
  missedAfterS: number;
}) {
  const { options, homes, store, now, log, missedAfterS } = deps;
  const tracker = new ScheduleCollection({ store, now, log, missedAfterS }, [
    { agent: "codex", read: () => readCodexAutomations(homes.codex) },
    { agent: "claude-code", read: () => readClaudeSchedules(options.scheduleHomes?.claudeApp ?? process.env["AGENT_OFFICE_CLAUDE_APP_DIR"] ?? options.claudeAppDir ?? defaultClaudeAppDir()) },
    { agent: "openclaw", read: () => readOpenClawSchedules(options.scheduleHomes?.openclaw ?? process.env["OPENCLAW_STATE_DIR"] ?? join(homedir(), ".openclaw")) },
    { agent: "hermes", read: () => readHermesSchedules(options.scheduleHomes?.hermes ?? process.env["HERMES_HOME"] ?? join(homedir(), ".hermes")) },
    { agent: "opencode", read: () => readOpenCodeSchedules(options.scheduleHomes?.opencodeDb ?? defaultOpenCodeDbPath()) },
    { agent: "pi", read: () => ({ outcome: "unsupported", code: "no_native_scheduler", automations: [], runs: [] }) },
  ]);
  const missedTasks = () => tracker.current().tasks.flatMap((task) => (task.missed === null ? [] : [{ session: task.key, signal: "schedule_missed" as const, since: task.missed.at }]));
  const taskOf = (key: string) => {
    const task = tracker.current().tasks.find((item) => item.key === key);
    return task === undefined ? undefined : { agent: task.agent, name: task.name };
  };
  return { tracker, missedTasks, taskOf };
}
