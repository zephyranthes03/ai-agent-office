// The daemon's SQLite file (node:sqlite): session snapshots, state history and hook dedupe.
// The file is held with an exclusive lock, which also keeps a second daemon from starting on the
// same folder. Forward-only migrations from ../migrations, with a backup copy before each upgrade.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Launcher, Lifecycle, Snapshot, State, Transition } from "@agent-office/core";
import { projectOf } from "@agent-office/core";
import { changesState, startsTurn } from "./history.ts";
import type { HistoryRow } from "./history.ts";
import { touchPrivate } from "./files.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export type PidConfidence = "exact" | "ancestor" | "unknown";

/**
 * What the daemon knows about a session besides the reducer snapshot: from its hook envelopes (the
 * working folder, the terminal, the parent process the hook reported) and from the liveness check
 * (`pid`: the verified agent process, `pidConfidence`, its start time). Until a check, `pid` is the
 * reported one and the confidence null.
 */
export type SessionInfo = {
  cwd: string | null;
  reportedPid: number | null;
  pid: number | null;
  pidConfidence: PidConfidence | null;
  pidStartedAt: string | null;
  terminal: Record<string, unknown> | null;
  /** Where the session runs, from its verified process (the liveness check); null until known. */
  launcher: Launcher | null;
  firstSeenAt: string;
};

export type SessionNoteRow = { session_id: string; nickname: string | null; description: string | null; watched: number; alert_on_rest: number; species: string | null; updated_at: string };

export type ViewerDevice = { id: string; name: string; token_sha256: string; created_at: string; last_seen_at: string | null };
/** A viewer device's web push subscription (migration 0011). */
export type PushSubscriptionRow = { device_id: string; endpoint: string; p256dh: string; auth: string; created_at: string };
/** A scheduled task as last read from its agent's scheduler (schedule.ts), one row per task. */
export type ScheduledTaskRow = {
  task_key: string;
  agent: string;
  name: string | null;
  project: string | null;
  cwd: string | null;
  status: string;
  kind: string;
  rrule: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  expected_at: string | null;
  missed_at: string | null;
  unsure_at: string | null;
  unsure_reason: string | null;
  run_session: string | null;
  run_status: string | null;
  run_at: string | null;
  observed_at: string;
};

/** A lifecycle control request as stored (migration 0012, controls.ts). */
export type ControlRequestRow = {
  id: string;
  target: string;
  agent: string;
  control: string;
  idempotency_key: string;
  requested_at: string;
  status: string;
  step: string | null;
  instance_json: string | null;
  launch_json: string | null;
  evidence_json: string;
  deadline_at: string | null;
  resolved_at: string | null;
  failure_reason: string | null;
};

const CONTROL_COLUMNS = "id, target, agent, control, idempotency_key, requested_at, status, step, instance_json, launch_json, evidence_json, deadline_at, resolved_at, failure_reason";

export const NO_INFO = (firstSeenAt: string): SessionInfo => ({ cwd: null, reportedPid: null, pid: null, pidConfidence: null, pidStartedAt: null, terminal: null, launcher: null, firstSeenAt });
export type StoredSession = { snapshot: Snapshot; info: SessionInfo };

export type Commit = {
  upserts: StoredSession[];
  transitions: Transition[];
  /** Sequence numbers reduced again: their earlier history rows are replaced. */
  replayed: number[];
  hookIds: { id: string; at: string }[];
  headAt: string | null;
};

type Migration = { version: number; file: string };

function migrations(): Migration[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name))
    .sort()
    .map((name) => ({ version: Number(name.slice(0, 4)), file: join(MIGRATIONS, name) }));
}

/** A snapshot stored before `delegations`, `background` or `work_since` existed (migration-free: the reducer state is JSON) gets their empty values. */
const withDelegations = (snapshot: Snapshot): Snapshot => ({ ...snapshot, delegations: snapshot.delegations ?? { open: [], returned: 0 }, background: snapshot.background ?? 0, work_since: snapshot.work_since ?? null });

export class StoreLockedError extends Error {
  override name = "StoreLockedError";
}

export class Store {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Opens (and creates or upgrades) the database; throws StoreLockedError when another daemon holds it. */
  static open(file: string): Store {
    touchPrivate(file);
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      // The exclusive lock is taken by the first write; take it now so a second daemon fails at once.
      db.exec("BEGIN EXCLUSIVE; COMMIT;");
    } catch (error) {
      db.close();
      if (/locked|busy/i.test((error as Error).message)) throw new StoreLockedError(`${file} is in use by another daemon`, { cause: error });
      throw error;
    }
    const store = new Store(db);
    store.migrate(file);
    return store;
  }

  version(): number {
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (!exists) return 0;
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'db_schema_version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private migrate(file: string): void {
    const known = migrations();
    const latest = known.length > 0 ? known[known.length - 1]!.version : 0;
    const current = this.version();
    if (current > latest) throw new Error(`${file} has schema version ${current}, newer than this daemon (${latest}); restore a backup or update the app`);
    const pending = known.filter((migration) => migration.version > current);
    if (pending.length === 0) return;
    if (current > 0) {
      // VACUUM INTO accepts an existing empty file; creating it first makes the backup 0600.
      const backup = `${file}.bak-${current}`;
      touchPrivate(backup);
      this.db.prepare("VACUUM INTO ?").run(backup);
    }
    this.transaction(() => {
      for (const migration of pending) this.db.exec(readFileSync(migration.file, "utf8"));
      this.setMeta("db_schema_version", String(latest));
    });
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Active sessions and those ended since `endedSince`, for the reducer to continue from. */
  loadSessions(endedSince: string): StoredSession[] {
    const rows = this.db
      .prepare("SELECT snapshot_json, cwd, reported_pid, pid, pid_confidence, pid_started_at, terminal_json, launcher, first_seen_at FROM sessions WHERE lifecycle = 'active' OR ended_at >= ?")
      .all(endedSince) as { snapshot_json: string; cwd: string | null; reported_pid: number | null; pid: number | null; pid_confidence: PidConfidence | null; pid_started_at: string | null; terminal_json: string | null; launcher: Launcher | null; first_seen_at: string }[];
    return rows.map((row) => ({
      snapshot: withDelegations(JSON.parse(row.snapshot_json) as Snapshot),
      info: {
        cwd: row.cwd,
        reportedPid: row.reported_pid,
        pid: row.pid,
        pidConfidence: row.pid_confidence,
        pidStartedAt: row.pid_started_at,
        terminal: row.terminal_json ? (JSON.parse(row.terminal_json) as Record<string, unknown>) : null,
        launcher: row.launcher,
        firstSeenAt: row.first_seen_at,
      },
    }));
  }

  /**
   * A session's history rows of its current turn, oldest first: back to the row that brought the
   * session into the state its turn started from (which `startsTurn` needs), or to the session's first
   * sight (a row with no previous state) when no start is recorded. Read newest first; rows that kept
   * the state are read past, so this may return a little more than needed, never less.
   */
  turnRows(session: string): HistoryRow[] {
    const rows: HistoryRow[] = [];
    let candidate: HistoryRow | undefined;
    const newestFirst = this.db.prepare("SELECT at, seq, from_state, to_state, lifecycle, rule FROM state_changes WHERE session_id = ? ORDER BY at DESC, seq DESC").iterate(session);
    for (const raw of newestFirst) {
      const r = raw as { at: string; seq: number; from_state: State | null; to_state: State; lifecycle: Lifecycle; rule: string | null };
      const row: HistoryRow = { at: r.at, seq: r.seq, from: r.from_state, to: r.to_state, lifecycle: r.lifecycle, rule: r.rule };
      rows.push(row);
      if (!changesState(row)) continue;
      if (row.from === null || (candidate !== undefined && startsTurn(candidate, row))) break;
      candidate = row;
    }
    return rows.reverse();
  }

  hookSeen(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM ingest_log WHERE hook_id = ?").get(id) !== undefined;
  }

  /** One batch of ingest results, all or nothing. */
  commit(batch: Commit): void {
    const upsert = this.db.prepare(`
      INSERT INTO sessions (session_id, agent, parent, cwd, project, origin, state, waiting_reason, waiting_target, detail, result_json, lifecycle,
        state_since, last_signal_at, first_seen_at, ended_at, pid, pid_confidence, reported_pid, pid_started_at, terminal_json, launcher, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET agent = excluded.agent, parent = excluded.parent, cwd = excluded.cwd, project = excluded.project,
        origin = excluded.origin, state = excluded.state, waiting_reason = excluded.waiting_reason, waiting_target = excluded.waiting_target,
        detail = excluded.detail, result_json = excluded.result_json, lifecycle = excluded.lifecycle, state_since = excluded.state_since,
        last_signal_at = excluded.last_signal_at, ended_at = excluded.ended_at, pid = excluded.pid, pid_confidence = excluded.pid_confidence,
        reported_pid = excluded.reported_pid, pid_started_at = excluded.pid_started_at, terminal_json = excluded.terminal_json, launcher = excluded.launcher,
        snapshot_json = excluded.snapshot_json`);
    const history = this.db.prepare(`
      INSERT INTO state_changes (seq, session_id, at, from_state, to_state, lifecycle, rule, waiting_reason, waiting_target, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const forget = this.db.prepare("DELETE FROM state_changes WHERE seq = ?");
    const seen = this.db.prepare("INSERT OR IGNORE INTO ingest_log (hook_id, received_at) VALUES (?, ?)");
    this.transaction(() => {
      for (const seq of batch.replayed) forget.run(seq);
      for (const { snapshot: s, info } of batch.upserts) {
        const endedAt = s.lifecycle === "ended" ? s.last_signal_at : null;
        upsert.run(s.session, s.agent, s.parent, info.cwd, projectOf(info.cwd), s.origin, s.state, s.waiting_on?.reason ?? null, s.waiting_on?.target ?? null, s.detail,
          s.result ? JSON.stringify(s.result) : null, s.lifecycle, s.state_since, s.last_signal_at, info.firstSeenAt, endedAt, info.pid, info.pidConfidence,
          info.reportedPid, info.pidStartedAt, info.terminal ? JSON.stringify(info.terminal) : null, info.launcher, JSON.stringify(s));
      }
      for (const t of batch.transitions) {
        history.run(t.seq, t.session, t.at, t.from?.state ?? null, t.to.state, t.to.lifecycle, t.rule, t.to.waiting_on?.reason ?? null, t.to.waiting_on?.target ?? null, t.to.detail);
      }
      for (const hook of batch.hookIds) seen.run(hook.id, hook.at);
      if (batch.headAt !== null) this.setMeta("head_at", batch.headAt);
    });
  }

  /**
   * Retention: ended sessions and history after `historyDays`, hook ids after a day. `beforeDelete`
   * gets the history cutoff and runs first in the same transaction (the board's roll-up).
   */
  cleanup(now: number, historyDays: number, beforeDelete?: (cutoff: string) => void): void {
    const history = new Date(now - historyDays * 86_400_000).toISOString();
    const day = new Date(now - 86_400_000).toISOString();
    this.transaction(() => {
      beforeDelete?.(history);
      this.db.prepare("DELETE FROM sessions WHERE lifecycle = 'ended' AND ended_at < ?").run(history);
      this.db.prepare("DELETE FROM state_changes WHERE at < ?").run(history);
      this.db.prepare("DELETE FROM ingest_log WHERE received_at < ?").run(day);
      this.db.prepare("DELETE FROM control_requests WHERE requested_at < ? AND status NOT IN ('requested', 'sent')").run(history);
      this.setMeta("last_cleanup_at", new Date(now).toISOString());
    });
  }

  /** Whether a hook of `agent` ever reached this daemon (a session row with the parent process a hook reported). */
  hooksDelivered(agent: string): boolean {
    return this.db.prepare("SELECT 1 FROM sessions WHERE agent = ? AND reported_pid IS NOT NULL LIMIT 1").get(agent) !== undefined;
  }

  insertControl(row: ControlRequestRow): void {
    this.db.prepare(`INSERT INTO control_requests (${CONTROL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.target, row.agent, row.control, row.idempotency_key, row.requested_at, row.status, row.step, row.instance_json, row.launch_json, row.evidence_json, row.deadline_at, row.resolved_at, row.failure_reason);
  }

  updateControl(row: ControlRequestRow): void {
    this.db.prepare("UPDATE control_requests SET target = ?, status = ?, step = ?, instance_json = ?, launch_json = ?, evidence_json = ?, deadline_at = ?, resolved_at = ?, failure_reason = ? WHERE id = ?").run(row.target, row.status, row.step, row.instance_json, row.launch_json, row.evidence_json, row.deadline_at, row.resolved_at, row.failure_reason, row.id);
  }

  controlByKey(key: string): ControlRequestRow | undefined {
    return this.db.prepare(`SELECT ${CONTROL_COLUMNS} FROM control_requests WHERE idempotency_key = ?`).get(key) as ControlRequestRow | undefined;
  }

  /** Requests not settled yet (requested or sent), oldest first. */
  openControls(): ControlRequestRow[] {
    return this.db.prepare(`SELECT ${CONTROL_COLUMNS} FROM control_requests WHERE status IN ('requested', 'sent') ORDER BY requested_at, id`).all() as ControlRequestRow[];
  }

  /** The newest requests, newest first. */
  recentControls(limit: number): ControlRequestRow[] {
    return this.db.prepare(`SELECT ${CONTROL_COLUMNS} FROM control_requests ORDER BY requested_at DESC, id DESC LIMIT ?`).all(limit) as ControlRequestRow[];
  }

  /** Paired viewer devices, oldest first; only token digests are stored. */
  viewerDevices(): ViewerDevice[] {
    return this.db.prepare("SELECT id, name, token_sha256, created_at, last_seen_at FROM viewer_devices ORDER BY created_at, id").all() as ViewerDevice[];
  }

  addViewerDevice(device: Omit<ViewerDevice, "last_seen_at">): void {
    this.db.prepare("INSERT INTO viewer_devices (id, name, token_sha256, created_at) VALUES (?, ?, ?, ?)").run(device.id, device.name, device.token_sha256, device.created_at);
  }

  /** Whether a device with this id existed; its push subscription goes with it. */
  removeViewerDevice(id: string): boolean {
    this.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?").run(id);
    return this.db.prepare("DELETE FROM viewer_devices WHERE id = ?").run(id).changes > 0;
  }

  pushSubscriptions(): PushSubscriptionRow[] {
    return this.db.prepare("SELECT device_id, endpoint, p256dh, auth, created_at FROM push_subscriptions ORDER BY created_at, device_id").all() as PushSubscriptionRow[];
  }

  /** A device's one subscription, replacing the one it had. */
  putPushSubscription(row: PushSubscriptionRow): void {
    this.db.prepare("INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at").run(row.device_id, row.endpoint, row.p256dh, row.auth, row.created_at);
  }

  /** Removes the device's subscription; with `endpoint`, only while it is still that one (a push service said it is gone). */
  removePushSubscription(device: string, endpoint?: string): boolean {
    return (endpoint === undefined ? this.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?").run(device) : this.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?").run(device, endpoint)).changes > 0;
  }

  touchViewerDevice(id: string, at: string): void {
    this.db.prepare("UPDATE viewer_devices SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  sessionNotes(): SessionNoteRow[] {
    return this.db.prepare("SELECT session_id, nickname, description, watched, alert_on_rest, species, updated_at FROM session_notes").all() as SessionNoteRow[];
  }

  putSessionNote(row: SessionNoteRow): void {
    this.db
      .prepare(`INSERT INTO session_notes (session_id, nickname, description, watched, alert_on_rest, species, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET nickname = excluded.nickname, description = excluded.description, watched = excluded.watched,
          alert_on_rest = excluded.alert_on_rest, species = excluded.species, updated_at = excluded.updated_at`)
      .run(row.session_id, row.nickname, row.description, row.watched, row.alert_on_rest, row.species, row.updated_at);
  }

  removeSessionNote(id: string): void {
    this.db.prepare("DELETE FROM session_notes WHERE session_id = ?").run(id);
  }

  scheduledTasks(): ScheduledTaskRow[] {
    return this.db.prepare("SELECT task_key, agent, name, project, cwd, status, kind, rrule, next_run_at, last_run_at, expected_at, missed_at, unsure_at, unsure_reason, run_session, run_status, run_at, observed_at FROM scheduled_tasks ORDER BY task_key").all() as ScheduledTaskRow[];
  }

  /** Replaces an agent's scheduled tasks with what its scheduler lists now, in one transaction. */
  replaceScheduledTasks(agent: string, rows: readonly ScheduledTaskRow[]): void {
    const insert = this.db.prepare(`INSERT INTO scheduled_tasks (task_key, agent, name, project, cwd, status, kind, rrule, next_run_at, last_run_at, expected_at, missed_at, unsure_at, unsure_reason, run_session, run_status, run_at, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.transaction(() => {
      this.db.prepare("DELETE FROM scheduled_tasks WHERE agent = ?").run(agent);
      for (const r of rows) {
        if (r.agent !== agent) continue;
        insert.run(r.task_key, r.agent, r.name, r.project, r.cwd, r.status, r.kind, r.rrule, r.next_run_at, r.last_run_at, r.expected_at, r.missed_at, r.unsure_at, r.unsure_reason, r.run_session, r.run_status, r.run_at, r.observed_at);
      }
    });
  }

  /** Closes the database; closing it again does nothing. */
  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
