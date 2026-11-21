#!/usr/bin/env node
// agent-office-hook <agent>: run by Claude Code or Codex on every hook event, with the event as
// JSON on stdin. Whatever happens it exits 0 within 2 s and writes nothing to stdout or stderr, so
// it can never block, fail or talk to the agent. This file stays plain JavaScript: it installs the
// guards before the TypeScript part is loaded, so even a failed import ends quietly.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HARD_LIMIT_MS = 2000;

/**
 * Last-resort log line (error code only, never input). Returns false when even that fails (a
 * read-only home, a full disk): the hook has no other channel and must still exit 0.
 */
function note(code) {
  try {
    const logs = join(process.env.AGENT_OFFICE_HOME || join(homedir(), ".agent-office"), "logs");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    appendFileSync(join(logs, "hook.log"), `${new Date().toISOString()} ${code}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

process.removeAllListeners("warning");
process.on("uncaughtException", (error) => {
  note(`uncaught ${error?.name ?? "Error"} ${error?.code ?? ""}`.trim());
  process.exit(0);
});
process.on("unhandledRejection", (error) => {
  note(`unhandled ${error?.name ?? "Error"} ${error?.code ?? ""}`.trim());
  process.exit(0);
});
setTimeout(() => {
  note("watchdog");
  process.exit(0);
}, HARD_LIMIT_MS).unref();

try {
  const { runHook } = await import("../src/hook.ts");
  await runHook(process.argv[2]);
} catch (error) {
  note(`failed ${error?.name ?? "Error"} ${error?.code ?? ""}`.trim());
}
process.exit(0);
