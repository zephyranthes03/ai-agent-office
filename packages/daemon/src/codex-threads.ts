// What Codex's own thread list says about hook-reported threads (codex adapter, local_db strategy),
// from Codex's state database, opened read-only for each pass and closed again: which of the asked
// threads it lists at all, and their titles (`threads.name`, a name given to the thread, else
// `threads.title`), the ones its apps show in their thread lists. The Codex app also runs threads
// for itself (memory upkeep, suggestions) that send the same hooks but are never listed and have no
// rollout: `listed` tells them from the owner's conversations. A subagent thread (a `followup_task`
// worker or reviewer, a child session here) has a nickname instead (`threads.agent_nickname`), the
// name Codex shows for it. Only `id`, `name`, `title` and `agent_nickname` of the asked threads are
// read; a database or schema that does not fit gives nothing and is logged.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The state database the descriptor declares; the version is in its name. */
const STATE_DB = "state_5.sqlite";

/** `listed` is null when the database could not be read: no thread can then be called unlisted. */
export type CodexThreads = { titles: Map<string, string>; listed: Set<string> | null };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * `threads`: the top-level sessions to ask about (their ids are thread ids). `children`: subagent
 * thread ids → the child session they are here; their nickname becomes that session's title.
 */
export function codexThreads(codexHome: string, threads: readonly string[], log: (line: string) => void, children: ReadonlyMap<string, string> = new Map()): CodexThreads {
  const titles = new Map<string, string>();
  const listed = new Set<string>();
  const file = join(codexHome, STATE_DB);
  const asked = [...threads, ...children.keys()];
  if (asked.length === 0) return { titles, listed };
  if (!existsSync(file)) return { titles, listed: null };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const query = db.prepare(`SELECT id, name, title, agent_nickname FROM threads WHERE id IN (${asked.map(() => "?").join(",")})`);
    for (const row of query.all(...asked) as { id: unknown; name: unknown; title: unknown; agent_nickname: unknown }[]) {
      if (typeof row.id !== "string") continue;
      const child = children.get(row.id);
      if (child !== undefined) {
        const nickname = text(row.agent_nickname) ?? text(row.name) ?? text(row.title);
        if (nickname !== null) titles.set(child, nickname);
        continue;
      }
      listed.add(row.id);
      const title = text(row.name) ?? text(row.title);
      if (title !== null) titles.set(row.id, title);
    }
  } catch (error) {
    log(`codex_threads_unreadable ${(error as NodeJS.ErrnoException).code ?? (error as Error).name}`);
    return { titles: new Map(), listed: null };
  } finally {
    db?.close();
  }
  return { titles, listed };
}
