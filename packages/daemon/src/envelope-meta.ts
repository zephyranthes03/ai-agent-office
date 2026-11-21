// The metadata the daemon reads itself for a hook envelope, since the `meta` an envelope carries is
// never trusted: a Claude Code session's origin from the transcript the hook names, while that origin
// is still open, and a Codex turn's settings from its rollout, once per turn. The reads go through the
// strategies the daemon injects; one that fails is logged by error code and leaves the metadata out.
import type { CodexTurnMeta, TranscriptMeta } from "@agent-office/adapters";
import type { HookEnvelope, Snapshot } from "@agent-office/core";

export type MetaReaders = {
  /** The transcript-metadata strategy; absent, origins come from direct reports only. */
  readMeta?: (transcriptPath: string) => TranscriptMeta | null;
  /** The Codex turn-settings strategy; absent, every Codex approval request is a wait for the owner. */
  readTurnMeta?: (transcriptPath: string) => CodexTurnMeta | null;
};

export class EnvelopeMeta {
  private readonly readMeta: (transcriptPath: string) => TranscriptMeta | null;
  private readonly readTurnMeta: (transcriptPath: string) => CodexTurnMeta | null;
  private readonly log: (line: string) => void;
  /** A Codex session's newest turn settings, read once per turn (hooks name the turn). */
  private readonly turnMeta = new Map<string, { turn: string; meta: CodexTurnMeta }>();

  constructor(readers: MetaReaders, log: (line: string) => void) {
    this.readMeta = readers.readMeta ?? (() => null);
    this.readTurnMeta = readers.readTurnMeta ?? (() => null);
    this.log = log;
  }

  /**
   * The metadata for an `event` of `agent`; `current` is the session's snapshot now, when the daemon
   * knows it. Claude Code: transcript metadata for a session's start or prompt, while its origin is
   * still open (at start the transcript may have no user line yet; the first prompt reads it again),
   * and for every prompt while the session has delegated work out (the prompt may be the result
   * coming back). A transcript that cannot be read leaves the origin open.
   */
  read(agent: string, event: HookEnvelope["event"], current: Snapshot | undefined): Record<string, unknown> | null {
    if (agent === "codex") return this.turnMetaFor(event);
    if (agent !== "claude-code" || (event.hook_event_name !== "SessionStart" && event.hook_event_name !== "UserPromptSubmit") || !event.transcript_path) return null;
    const origin = current?.origin;
    const awaiting = event.hook_event_name === "UserPromptSubmit" && (current?.delegations?.open.length ?? 0) > 0;
    if (!awaiting && origin !== undefined && origin !== null && origin !== "unknown") return null;
    let meta: TranscriptMeta | null = null;
    try {
      meta = this.readMeta(event.transcript_path);
    } catch (error) {
      // Recorded; the origin stays open and the next prompt reads the transcript again.
      this.log(`transcript_meta_unreadable ${(error as NodeJS.ErrnoException).code ?? (error as Error).name}`);
    }
    return meta;
  }

  /**
   * Turn settings for a Codex approval request: who answers it comes from the rollout the hook names,
   * read once per turn (a turn's reviewer does not change within it; a failed read is tried again at
   * the next request). A rollout that cannot be read leaves the request a wait for the owner.
   */
  private turnMetaFor(event: HookEnvelope["event"]): CodexTurnMeta | null {
    if (event.hook_event_name === "SessionEnd") {
      this.turnMeta.delete(event.session_id);
      return null;
    }
    if (event.hook_event_name !== "PermissionRequest" || !event.transcript_path) return null;
    const turn = event.turn_id ?? null;
    const cached = this.turnMeta.get(event.session_id);
    if (turn !== null && cached?.turn === turn) return cached.meta;
    let meta: CodexTurnMeta | null = null;
    try {
      meta = this.readTurnMeta(event.transcript_path);
    } catch (error) {
      this.log(`turn_meta_unreadable ${(error as NodeJS.ErrnoException).code ?? (error as Error).name}`);
    }
    if (turn !== null && meta !== null) this.turnMeta.set(event.session_id, { turn, meta });
    return meta;
  }
}
