// The pass over the agents' own files for active sessions, run with the liveness check: Claude
// Code's transcripts give titles and the marker of Esc (which sends no hook; looked for only in
// turns quiet for INTERRUPT_QUIET_MS), and Codex's thread list gives titles and tells the owner's
// conversations from the threads the app runs for itself (never listed there).
import type { CodexThreads } from "./codex-threads.ts";
import type { Ingestor } from "./ingest.ts";
import type { TranscriptFacts } from "./transcript-watch.ts";

/** How long a Claude Code turn must be quiet before its transcript is looked at for Esc. */
export const INTERRUPT_QUIET_MS = 10_000;
/** How long after its first hook a Codex thread missing from Codex's thread list counts as the app's own. */
export const UNLISTED_GRACE_MS = 5_000;

export type AgentFilesDeps = {
  ingestor: Pick<Ingestor, "reportedSessions" | "reportedChildren" | "setTitles" | "infoOf" | "interruptCandidates" | "reportInterrupts">;
  /** Claude Code's transcript facts of these sessions (transcript-watch.ts). */
  claudeFacts: (sessions: readonly string[]) => Map<string, TranscriptFacts>;
  /** Codex's thread list for these threads and their subagents (codex-threads.ts). */
  codexThreads: (threads: readonly string[], children: ReadonlyMap<string, string>) => CodexThreads;
  /** The threads the app runs for itself, kept up to date in place (the attention list and "open session" read it). */
  internal: Set<string>;
  now: () => number;
};

/**
 * Updates `internal` from Codex's thread list: a thread no hook reports any more leaves it; a listed
 * one is the owner's; an unlisted one joins once its first hook is UNLISTED_GRACE_MS old (a new
 * conversation is listed within a second of its first hook). A list that could not be read
 * (`listed` null) judges no thread, so earlier judgements stand.
 */
export function updateInternalThreads(internal: Set<string>, reported: readonly string[], listed: ReadonlySet<string> | null, firstSeenAt: (id: string) => string | undefined, nowMs: number): void {
  for (const id of internal) if (!reported.includes(id)) internal.delete(id);
  if (listed === null) return;
  for (const id of reported) {
    if (listed.has(id)) internal.delete(id);
    else if (nowMs - Date.parse(firstSeenAt(id) ?? "") >= UNLISTED_GRACE_MS) internal.add(id);
  }
}

/** One pass: titles, the app's own threads, and Esc in quiet Claude Code turns. */
export function readAgentFiles(deps: AgentFilesDeps): void {
  const { ingestor, now } = deps;
  const facts = deps.claudeFacts(ingestor.reportedSessions("claude-code"));
  const titles = new Map<string, string>();
  for (const [id, fact] of facts) if (fact.title !== null) titles.set(id, fact.title);
  const reported = ingestor.reportedSessions("codex");
  const codex = deps.codexThreads(reported, ingestor.reportedChildren("codex"));
  for (const [id, title] of codex.titles) titles.set(id, title);
  ingestor.setTitles(titles);
  updateInternalThreads(deps.internal, reported, codex.listed, (id) => ingestor.infoOf(id)?.firstSeenAt, now());
  const found = ingestor.interruptCandidates(INTERRUPT_QUIET_MS).flatMap(({ session, since }) => {
    const at = facts.get(session)?.interruptedAt ?? null;
    return at !== null && Date.parse(at) > Date.parse(since) ? [{ session, at }] : [];
  });
  if (found.length > 0) ingestor.reportInterrupts(found);
}
