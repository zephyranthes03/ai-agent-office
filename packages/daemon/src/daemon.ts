// Wires the daemon: private folder and token, config, SQLite, the loopback API, the spool drain
// (before the first tick), 5 s ticks, the log scans for usage and limits, and retention cleanup. `startDaemon` resolves once the API is
// listening, `daemon.json` is written and the spool left from before has been ingested.
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { localDay, refreshIntervalS } from "@agent-office/core";
import { createDesktop, createPlatform } from "@agent-office/platform";
import pkg from "../package.json" with { type: "json" };
import { readAgentFiles } from "./agent-files.ts";
import { appLink, defaultClaudeAppDir } from "./app-links.ts";
import { AttentionTracker } from "./attention.ts";
import { BoardRecord } from "./board.ts";
import type { Attention } from "./attention.ts";
import { loadConfig, loadPricingOverrides, sceneSettings } from "./config.ts";
import { drainSpool } from "./drain.ts";
import { createLog, ensureToken, officeHome, pathsFor, prepareFolders, privacyProblems, writeAtomic } from "./files.ts";
import type { Paths } from "./files.ts";
import { Ingestor } from "./ingest.ts";
import { codexThreads } from "./codex-threads.ts";
import type { ControlsState } from "./controls.ts";
import { wireControls } from "./controls-wiring.ts";
import type { DaemonHandle, DaemonOptions } from "./daemon-options.ts";
import { wireSchedules } from "./schedule-wiring.ts";
import { wireViewer } from "./viewer-wiring.ts";
import { hookWarning } from "./launcher.ts";
import { checkLiveness } from "./liveness.ts";
import { bindViewer, listen } from "./listen.ts";
import { Notes } from "./notes.ts";
import { Notifier } from "./notifier.ts";
import { SessionOpener } from "./open.ts";
import type { Notification } from "./notifier.ts";
import { createApi } from "./server.ts";
import type { Warnings } from "./server.ts";
import { TranscriptWatch } from "./transcript-watch.ts";
import { UiAuth } from "./ui-auth.ts";
import { notificationForViewer } from "./viewer.ts";
import { removeOldQuarantine, rotateSpool } from "./spool.ts";
import { Store, StoreLockedError } from "./store.ts";
import { agentHomes, readCodexTurnMeta, readTranscriptMeta } from "./log-files.ts";
import { UsageCollector } from "./usage.ts";
import { createValidators } from "./validate.ts";

export type { DaemonHandle, DaemonOptions } from "./daemon-options.ts";

/** Spool files set aside as unreadable are kept this long for inspection. */
const QUARANTINE_DAYS = 7;

/** A readable message when another daemon holds the database. */
function alreadyRunning(paths: Paths, cause: unknown): Error {
  let where: string;
  try {
    const info = JSON.parse(readFileSync(paths.daemonJson, "utf8")) as { pid?: number; port?: number };
    where = ` (pid ${info.pid}, port ${info.port})`;
  } catch (error) {
    where = ` (daemon.json unreadable: ${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`;
  }
  return new Error(`an agent-office daemon is already running for ${paths.home}${where}`, { cause });
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const now = options.now ?? Date.now;
  const paths = pathsFor(options.home ?? officeHome());
  prepareFolders(paths);
  const problems = privacyProblems(paths);
  if (problems.length > 0) throw new Error(`refusing to start: ${problems.join("; ")}`);
  const token = ensureToken(paths.token);
  const log = createLog(paths);
  const validators = createValidators();
  const config = loadConfig(paths.config, validators);
  if (config.problem) log(`config_defaults ${config.problem}`);

  let store: Store;
  try {
    store = Store.open(paths.db);
  } catch (error) {
    if (error instanceof StoreLockedError) throw alreadyRunning(paths, error);
    throw error;
  }

  const startedAt = new Date(now()).toISOString();
  let broadcast: (events: import("@agent-office/core").StandardEvent[]) => void = () => undefined;
  let broadcastAttention: (list: Attention) => void = () => undefined;
  let broadcastNotification: (notification: Notification) => void = () => undefined;
  let broadcastControls: (state: ControlsState) => void = () => undefined;
  let warnings: Warnings = { hooks: null };
  const homes = options.agentHomes ?? agentHomes();
  // The attention list is judged from the snapshots and the history rows each commit writes; it is
  // published when it changes, after a commit or on a tick (a turn running long changes no state).
  // Codex threads the app runs for itself: hook-reported, but absent from Codex's own thread list
  // (filled by the agent-files pass; a thread is judged only after UNLISTED_GRACE_MS, as a new
  // conversation is listed within a second of its first hook).
  const internalThreads = new Set<string>();
  // The agents' schedulers (schedule-wiring.ts).
  const { tracker: scheduleTracker, missedTasks, taskOf } = wireSchedules({ options, homes, store, now, log, missedAfterS: config.schedule.missedAfterS });
  const attention = new AttentionTracker({ snapshots: () => ingestor.snapshots(), history: (session) => store.turnRows(session), longTurnS: config.longTurnS, awayAfterS: config.awayAfterS, internal: () => internalThreads, extra: missedTasks, now });
  // Notifications follow the attention list; a wait that must last `min_wait_s` first is checked
  // again when it becomes due. Nothing is notified before `notifier.baseline` (end of start-up).
  const notifier = new Notifier(config.notify);
  // The owner's nicknames, descriptions and flags; they name notifications and pick rest alerts.
  const notes = new Notes(store, now);
  let dueTimer: NodeJS.Timeout | null = null;
  // Notifications go to the desktop app (unless its channel is off), to the viewer's devices and to
  // their web push; with neither, nothing is decided.
  const notify = () => {
    if (!config.desktopNotifications && viewer === null) return;
    let byId: Map<string, import("@agent-office/core").StandardEvent> | null = null;
    const sessionOf = (id: string) => (byId ??= new Map(ingestor.sessions().map((event) => [event.session, event]))).get(id);
    const { notifications, dueMs } = notifier.step(attention.latest(), sessionOf, now(), (id) => notes.get(id), taskOf);
    for (const notification of notifications) broadcastNotification(notification);
    if (dueTimer !== null) clearTimeout(dueTimer);
    dueTimer = dueMs === null ? null : setTimeout(guardedNotify, Math.max(0, dueMs - now()));
  };
  // A due wait re-reads the list (and publishes it when it changed) before deciding.
  const guardedNotify = () => {
    try {
      publishAttention();
    } catch (error) {
      log(`notify_failed ${(error as Error).name}`);
    }
  };
  const publishAttention = () => {
    const list = attention.changed();
    if (list !== null) broadcastAttention(list);
    notify();
  };
  const ingestor = new Ingestor({
    store,
    config,
    validators,
    now,
    log,
    onChange: (events) => broadcast(events),
    onCommit: ({ sessions, replayed }) => {
      attention.invalidate(replayed ? "all" : sessions);
      // The commit is stored: a failure here is logged and must not fail the request that caused it.
      try {
        publishAttention();
      } catch (error) {
        log(`attention_failed ${(error as Error).name} ${(error as NodeJS.ErrnoException).code ?? ""}`.trim());
      }
      // A signal arrived: a standing "hooks are not delivered" warning may be over.
      if (warnings.hooks !== null) guarded("hooks", checkHooks)();
      guarded("controls", () => controls.publish())();
      // A Codex session seen for the first time may be a scheduled task's run: the scheduler is read
      // at once (and again every pass, as the run row may come after the first hook).
      const snapshots = ingestor.snapshots();
      if (sessions.some((id) => !scheduleChecked.has(id) && snapshots[id]?.parent === null)) {
        for (const id of sessions) scheduleChecked.add(id);
        guarded("schedule", checkSchedule)();
      }
    },
    readMeta: (path) => readTranscriptMeta(homes, path),
    readTurnMeta: (path) => readCodexTurnMeta(homes, path),
  });
  const board = new BoardRecord(store, { timeZone: config.usageTimeZone, dayStartsAt: config.dayStartsAt, monthlyTarget: config.board.monthly_target });
  const usage = new UsageCollector({ store, homes, now, log, timeZone: config.usageTimeZone, dayStartsAt: config.dayStartsAt, eventsDays: config.eventsDays, dailyDays: config.usageDailyDays, overrides: loadPricingOverrides(paths.home, config.pricingOverridesFile ?? "custom-pricing.json", log) });
  // "Open session": one open per session at a time, and a minute's hold after a resume.
  const desktop = options.desktop ?? createDesktop(join(paths.home, "open"));
  const opener = new SessionOpener({
    snapshots: () => ingestor.snapshots(),
    infoOf: (id) => ingestor.infoOf(id),
    isInternal: (id) => internalThreads.has(id),
    appLink: (agent, launcher, session) => appLink(agent, launcher, session, options.claudeAppDir ?? defaultClaudeAppDir()),
    desktop,
    now,
    log,
  });
  // Liveness of the agent processes behind the sessions (process_scan), every 30 s; a session whose
  // process a control is stopping is left to the control, so its end is never taken for a loss.
  const platform = options.platform ?? createPlatform();
  const liveness = () => {
    const results = checkLiveness(ingestor.livenessTargets().filter((target) => !controls.holds(target.session)), platform);
    if (results.length > 0) ingestor.reportLiveness(results);
    controls.refreshOwners();
    controls.publish();
  };
  // Lifecycle controls (controls-wiring.ts).
  const controls = wireControls({ options, paths, homes, store, ingestor, desktop, platform, now, log, recheck: () => guarded("liveness", liveness)(), onChange: (state) => broadcastControls(state), tasks: (agent) => scheduleTracker.current().tasks.filter((task) => task.agent === agent) });
  const uiRoot = options.uiRoot ?? fileURLToPath(new URL("../../ui/dist/", import.meta.url));
  // The read-only viewer listener (viewer-wiring.ts), only when an address was given on the command line.
  const { viewerAddress, viewerUrl, push, access, viewer } = wireViewer({ options, store, ingestor, attention, notes, config, uiRoot, now, log });
  const api = createApi({
    token,
    ingestor,
    usage,
    board: (year) => board.read(year ?? Number(localDay(new Date(now()).toISOString(), config.usageTimeZone, config.dayStartsAt).slice(0, 4)), now()),
    attention: () => attention.current(),
    schedule: () => scheduleTracker.current(),
    log,
    ui: new UiAuth(now),
    uiRoot,
    openSession: (id) => opener.open(id),
    viewer: viewerUrl === null || access === null ? null : { url: viewerUrl, access },
    notes,
    settings: sceneSettings(config),
    warnings: () => {
      checkHooks();
      return warnings;
    },
    notesChanged: () => {
      api.broadcastNotes(notes.all());
      viewer?.broadcastNotes();
    },
    controls: {
      state: () => controls.state(),
      request: (session, control, key, instance) => controls.request(session, control, key, instance),
      start: (agent, cwd, key) => controls.start(agent, cwd, key),
      service: (agent, control, key, instance) => controls.serviceRequest(agent, control, key, instance),
    },
    health: () => ({ version: pkg.version, pid: process.pid, started_at: startedAt, schema_versions: { event: 1, hook_envelope: 1 }, config: config.problem === null ? "ok" : "defaults" }),
  });
  broadcast = (events) => {
    api.broadcast(events);
    viewer?.broadcast(events);
  };
  broadcastControls = (state) => api.broadcastControls(state);
  broadcastAttention = (list) => {
    api.broadcastAttention(list);
    viewer?.broadcastAttention(list);
  };
  broadcastNotification = (notification) => {
    if (config.desktopNotifications) api.broadcastNotification(notification);
    viewer?.broadcastNotification(notification);
    // The devices that turned on web push get it at the viewer's detail level, in the owner's language.
    if (push !== null) void push.send({ notice: notificationForViewer(notification, config.viewerDetail), language: config.language }, createHash("sha256").update(notification.session).digest("base64url").slice(0, 32));
  };

  let port: number;
  try {
    port = await listen(api.server, options.port ?? config.port);
  } catch (error) {
    store.close();
    throw error;
  }
  writeAtomic(paths.daemonJson, `${JSON.stringify({ schema_version: 1, port, pid: process.pid, version: pkg.version, started_at: startedAt })}\n`);

  // The viewer's address may not be up yet (a network that joins later): a failed bind is logged and
  // tried again, and never stops the daemon.
  const stopViewerRetry = viewer === null || viewerAddress === null ? () => undefined : bindViewer(viewer.server, viewerAddress, options.viewerRetryMs ?? 30_000, log);

  const guarded = (name: string, work: () => void) => () => {
    try {
      work();
    } catch (error) {
      log(`${name}_failed ${(error as Error).name} ${(error as NodeJS.ErrnoException).code ?? ""}`.trim());
    }
  };
  // The schedulers' pass: the sessions their runs opened are shown as scheduled and named for the
  // task; a changed schedule (and the needs-you list, for a missed occurrence) is published.
  const scheduleChecked = new Set<string>();
  const checkSchedule = () => {
    const result = scheduleTracker.refresh((agent) => ingestor.sessionIds(agent));
    ingestor.setScheduled(new Map([...result.links].map(([id, task]) => [id, task.name])));
    if (!result.changed) return;
    api.broadcastSchedule(result.schedule);
    publishAttention();
  };
  // Hooks that do not reach the daemon (a Node upgrade took the launcher's Node, 2026-10-31): the
  // launcher cannot say so itself, so the daemon looks at it and at its marks, and the screens warn.
  const checkHooks = () => {
    const last = ingestor.lastSignalAt();
    const next: Warnings = { hooks: hookWarning(paths, last === null ? null : Date.parse(last)) };
    if (JSON.stringify(next) === JSON.stringify(warnings)) return;
    warnings = next;
    if (next.hooks !== null) log(`hooks_warning ${next.hooks.code}`);
    api.broadcastWarnings(warnings);
  };
  const graceMs = options.drainGraceMs ?? 2500;
  const drain = () => drainSpool(paths.spool, { ingestor, log, nowMs: now(), graceMs });
  const cleanup = () => {
    store.cleanup(now(), config.historyDays, (cutoff) => board.rollup(cutoff));
    board.noteMonth(now());
    usage.rollup();
    // Sessions let go of here (a day after their last signal) leave the attention list too.
    ingestor.evictEnded();
    publishAttention();
    removeOldQuarantine(paths.spool, now(), QUARANTINE_DAYS);
  };
  const tick = () => {
    ingestor.tick();
    publishAttention();
  };
  // The first drain: move the spool aside, give hooks still writing to it the grace period, ingest
  // it, and only then start the clock, so replayed sessions are not marked stale by an early tick.
  // A spool that cannot be drained is logged, not fatal: the daemon still starts.
  guarded("drain", () => rotateSpool(paths.spool, now()))();
  await sleep(graceMs);
  guarded("drain", drain)();
  guarded("cleanup", cleanup)();
  const timers = [
    setInterval(guarded("tick", tick), options.tickMs ?? 5000),
    setInterval(guarded("drain", drain), options.drainMs ?? 30_000),
    setInterval(guarded("cleanup", cleanup), options.cleanupMs ?? 6 * 3600_000),
  ];
  // Logs and limits are polled (sessions are not): first right after start, then on the adaptive
  // schedule, which slows down when no agent has been active for a while.
  let scanTimer: NodeJS.Timeout | null = null;
  const scanUsage = () => usage.scan();
  const nextScan = () => {
    const last = ingestor.lastSignalAt();
    const delayMs = options.usageScanMs ?? refreshIntervalS({ constrained: false, uiOpenedAgoS: null, activityAgoS: last === null ? null : (now() - Date.parse(last)) / 1000 }) * 1000;
    scanTimer = setTimeout(() => {
      guarded("usage_scan", scanUsage)();
      nextScan();
    }, delayMs);
  };
  guarded("usage_scan", scanUsage)();
  nextScan();
  // Requests a previous run was waiting on are settled before the first liveness pass, so a stop
  // the daemon did not see end is confirmed as the owner's, not taken for a loss.
  guarded("controls", () => controls.reconcile())();
  // Declared background services' own status (no command runs for the screens' view).
  const services = () => void controls.refreshServices();
  guarded("services", services)();
  timers.push(setInterval(guarded("services", services), options.serviceMs ?? 60_000));
  guarded("liveness", liveness)();
  // The agents' files of active sessions, with the liveness pass (agent-files.ts): titles, Esc in
  // quiet Claude Code turns, and the threads Codex's app runs for itself; then the schedulers.
  const transcriptWatch = new TranscriptWatch(homes.claude, log);
  const agentFiles = () => {
    readAgentFiles({
      ingestor,
      claudeFacts: (sessions) => transcriptWatch.facts(sessions),
      codexThreads: (threads, children) => codexThreads(homes.codex, threads, log, children),
      internal: internalThreads,
      now,
    });
    checkSchedule();
  };
  guarded("agent_files", agentFiles)();
  guarded("hooks", checkHooks)();
  // Start-up is over: what is listed now (replayed from the spool, found gone by the first
  // liveness pass) is listed, not notified.
  notifier.baseline(attention.current());
  timers.push(setInterval(guarded("liveness", liveness), options.livenessMs ?? 30_000));
  timers.push(setInterval(guarded("agent_files", agentFiles), options.livenessMs ?? 30_000));
  timers.push(setInterval(guarded("hooks", checkHooks), options.livenessMs ?? 30_000));

  let closed = false;
  return {
    port,
    viewer: viewerUrl === null || viewerAddress === null ? null : { url: viewerUrl, plain: viewerAddress.plain },
    paths,
    config,
    drain,
    tick,
    cleanup,
    scanUsage,
    checkLiveness: liveness,
    checkAgentFiles: agentFiles,
    checkHooks,
    checkSchedule,
    async close() {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearInterval(timer);
      controls.close();
      if (dueTimer !== null) clearTimeout(dueTimer);
      if (scanTimer !== null) clearTimeout(scanTimer);
      stopViewerRetry();
      await viewer?.shutdown();
      await api.shutdown();
      store.close();
      try {
        const info = JSON.parse(readFileSync(paths.daemonJson, "utf8")) as { pid?: number };
        if (info.pid === process.pid) unlinkSync(paths.daemonJson);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
