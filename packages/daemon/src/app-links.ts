// The agents' own app links to one conversation, for "open session" on a session that runs in that
// app. Codex threads are opened by their id (`codex://threads/<id>`). The Claude desktop app opens a
// Code session by its own id (`claude://code/continue?session=local_…`), which its session records
// pair with the Claude Code session id: those records are read only when the owner opens a session,
// and only their `sessionId` and `cliSessionId` keys are kept. Links are formed from fixed text and
// ids that passed a strict pattern.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Launcher } from "@agent-office/core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_APP_ID = /^local_[A-Za-z0-9-]{1,64}$/;
/** A session record is a small JSON file; anything larger is not one. */
const RECORD_MAX_BYTES = 256 * 1024;

/** The Claude desktop app's folder (macOS); its Code sessions are under `claude-code-sessions/<account>/<org>/`. */
export const defaultClaudeAppDir = (home: string = homedir()): string => join(home, "Library", "Application Support", "Claude");

/** Folders in `dir` (real folders only); none when it does not exist. */
function folders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw error;
  }
}

/** The Claude app's own id of the Code session with this Claude Code session id, or null. */
export function claudeAppSessionId(appDir: string, cliSession: string): string | null {
  if (!UUID.test(cliSession)) return null;
  for (const account of folders(join(appDir, "claude-code-sessions")))
    for (const org of folders(account))
      for (const name of readdirSync(org)) {
        if (!CLAUDE_APP_ID.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
        const file = join(org, name);
        const stat = lstatSync(file, { throwIfNoEntry: false });
        if (!stat?.isFile() || stat.size > RECORD_MAX_BYTES) continue;
        let record: unknown;
        try {
          record = JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
        const { sessionId, cliSessionId } = (record ?? {}) as Record<string, unknown>;
        if (cliSessionId === cliSession && typeof sessionId === "string" && CLAUDE_APP_ID.test(sessionId)) return sessionId;
      }
  return null;
}

/** The app link to a session that runs in its agent's desktop app, or null. */
export function appLink(agent: string, launcher: Launcher | null, session: string, claudeAppDir: string): string | null {
  if (agent === "codex" && launcher === "codex-app" && UUID.test(session)) return `codex://threads/${session}`;
  if (agent === "claude-code" && launcher === "claude-app") {
    const id = claudeAppSessionId(claudeAppDir, session);
    return id === null ? null : `claude://code/continue?session=${id}`;
  }
  return null;
}
