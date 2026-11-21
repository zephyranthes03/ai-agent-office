// What the daemon reads from the transcripts of active Claude Code sessions (claude-code adapter,
// transcript strategies): the session's title, which its apps show, and the marker Claude Code
// writes on Esc, which sends no hook. Files are found by the transcript layout
// (`projects/<project>/<session>.jsonl`, links not followed), only for hook-reported session ids,
// and read from their last 64 KiB; a file unchanged since its last read is not read again. Only the
// title and the marker's time come out.
import { basename } from "node:path";
import { interruptedAt, transcriptTitle } from "@agent-office/adapters";
import { claudeTranscripts, readTail, SESSION_FILE_ID } from "./log-files.ts";

const TAIL_BYTES = 64 * 1024;

export type TranscriptFacts = { title: string | null; interruptedAt: string | null };

export class TranscriptWatch {
  private readonly read = new Map<string, { size: number; mtimeMs: number; facts: TranscriptFacts }>();
  private readonly claudeHome: string;
  private readonly log: (line: string) => void;

  constructor(claudeHome: string, log: (line: string) => void) {
    this.claudeHome = claudeHome;
    this.log = log;
  }

  /** The facts of each session's own transcript (not its subagents' files); sessions without one are left out. */
  facts(sessions: readonly string[]): Map<string, TranscriptFacts> {
    const wanted = new Set(sessions.filter((id) => SESSION_FILE_ID.test(id)));
    for (const id of this.read.keys()) if (!wanted.has(id)) this.read.delete(id);
    const out = new Map<string, TranscriptFacts>();
    if (wanted.size === 0) return out;
    for (const { file, size, mtimeMs } of claudeTranscripts(this.claudeHome, wanted, (code) => this.log(`transcript_folder_unreadable ${code}`))) {
      const session = basename(file, ".jsonl");
      if (!wanted.has(session)) continue;
      let entry = this.read.get(session);
      if (entry === undefined || entry.size !== size || entry.mtimeMs !== mtimeMs) {
        try {
          const text = readTail(file, TAIL_BYTES).text;
          // A tail with no title line (a long turn wrote past it) keeps the title read before.
          entry = { size, mtimeMs, facts: { title: transcriptTitle(text) ?? entry?.facts.title ?? null, interruptedAt: interruptedAt(text) } };
        } catch (error) {
          this.log(`transcript_read_failed ${(error as NodeJS.ErrnoException).code ?? (error as Error).name}`);
          continue;
        }
        this.read.set(session, entry);
      }
      out.set(session, entry.facts);
    }
    return out;
  }
}
