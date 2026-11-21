// One pass over the spool (spool.ts finds and reads the files): every line becomes a prepared batch
// for the ingestor, applied once, and a file is removed only after its lines are stored.
import { eventId } from "./ingest.ts";
import type { Ingestor, Prepared } from "./ingest.ts";
import { readyDrains, removeDrain, rotateSpool } from "./spool.ts";

/** The spool file `agent-office emit` writes to; no adapter has this id. */
export const EVENTS_SPOOL = "events";

export type DrainDeps = {
  ingestor: Ingestor;
  log: (line: string) => void;
  nowMs: number;
  graceMs: number;
};

const hookIdOf = (line: unknown): string | null => {
  const id = line !== null && typeof line === "object" ? (line as { hook_id?: unknown }).hook_id : undefined;
  return typeof id === "string" ? id : null;
};

/**
 * One pass over the spool. Every line has an id (a hook envelope its `hook_id`, an emitted event its
 * content, `event:<sha256>`), recorded in `ingest_log` with the line's effects, so draining a file
 * again applies nothing twice. A batch the database could not take stays in memory for the next
 * commit; while any line of a file waits for that commit, the file stays on disk (a later pass skips
 * those lines), so a daemon that stops first still finds them.
 */
export function drainSpool(dir: string, deps: DrainDeps): void {
  const { drains, quarantined } = readyDrains(dir, deps.nowMs, deps.graceMs);
  for (const bad of quarantined) deps.log(`spool_file_quarantined ${bad.reason}`);
  // All files are one batch: the reducer sorts it by observation time, so an agent's file drained after
  // another's (or an older file after a newer one) cannot make its inputs late and replay old states.
  const batch: Prepared[] = [];
  const done: string[] = [];
  for (const file of drains) {
    const events = file.agent === EVENTS_SPOOL;
    let waiting = false;
    for (const line of file.lines) {
      const id = events ? eventId(line) : hookIdOf(line);
      if (id !== null && deps.ingestor.waitingFor(id)) {
        waiting = true;
        continue;
      }
      // `events.jsonl` holds standard events spooled by `agent-office emit`; every other file, hook envelopes.
      const prepared = events ? deps.ingestor.prepareEvent(line) : deps.ingestor.prepareEnvelope(file.agent, line);
      if ("code" in prepared) deps.log(`spool_line_rejected ${prepared.code}`);
      else batch.push(prepared);
    }
    if (file.badLines > 0) deps.log(`spool_lines_unparsable ${file.badLines}`);
    if (!waiting) done.push(file.file);
  }
  if (drains.length > 0 && deps.ingestor.apply(batch)) for (const file of done) removeDrain(file);
  rotateSpool(dir, deps.nowMs);
}
