// Lifecycle controls (docs/click-panel-and-controls.md): the owner starts an agent's session in a new terminal window, stops a
// session's process, or restarts it on the same conversation. Only what an adapter declares and
// verified is offered (`controls`, `lifecycle`), only for a process that is the agent's own CLI with a
// controlling terminal (an app's or an extension's is that app's), and never while it is at work. A
// request is bound to one exactly identified process: the liveness check's verified process, looked up
// again right before (same start time), whose executable is one of the adapter's control names, and
// which the agent's own inventory lists with this session id. One signal
// goes to that one process; nothing stronger follows. Success is only what is observed: the process
// gone (stop), a hook of the same session from the process the new window started (restart, start).
// Requests are stored, so a daemon restart settles them from what it finds and acts again on nothing.
// No prompt is ever passed and nothing is typed into a session.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { STOPPABLE } from "@agent-office/core";
import type { Snapshot, Snapshots } from "@agent-office/core";
import { descendantsIn, executableName, verifyPid } from "@agent-office/platform";
import type { Desktop, ProcessControl, ProcessInfo } from "@agent-office/platform";
import { INSTANCE, KEY, RequestLedger } from "./control-ledger.ts";
import { inventoryVerdict } from "./inventory.ts";
import type { InventoryRunner } from "./inventory.ts";
import { appOwnedPath, instanceOf, isDirectory, view } from "./lifecycle.ts";
import type { AgentLifecycle, ControlName, ControlReply, ControlsState } from "./lifecycle.ts";
import { resumeArgv } from "./open.ts";
import { SERVICE_PREFIX, ServiceControls } from "./service-controls.ts";
import type { ServiceDeps } from "./service-controls.ts";
import type { ControlRequestRow, SessionInfo, Store } from "./store.ts";

export type { AgentLifecycle, ControlName, ControlReply, ControlsState, ControlView, Lifecycle, ServiceEntry, ServiceView } from "./lifecycle.ts";
export { claudeTranscriptExists, declaredLifecycles, declaredServices, instanceOf } from "./lifecycle.ts";


export type BrokerDeps = {
  store: Store;
  now: () => number;
  log: (line: string) => void;
  snapshots: () => Snapshots;
  infoOf: (id: string) => SessionInfo | undefined;
  /** Rule G3 for a session whose process is confirmed gone. */
  stopped: (id: string) => void;
  agents: readonly AgentLifecycle[];
  processes: ProcessControl;
  lookup: (pids: number[]) => Map<number, ProcessInfo>;
  inventory: InventoryRunner;
  desktop: Desktop;
  /** Where the new windows' pid files go (the daemon's own folder). */
  launchDir: string;
  /** Whether the agent keeps a transcript of this session (restart resumes it), else it starts it again with the same id. */
  hasTranscript: (agent: string, session: string) => boolean;
  hooksDelivered: (agent: string) => boolean;
  /** Runs the liveness check now (a bound process is verified at once). */
  recheck: () => void;
  onChange: (state: ControlsState) => void;
  pollMs?: number;
  bindMs?: number;
  /** Background services (service-controls.ts). */
  services: Pick<ServiceDeps, "entries" | "host" | "tasks" | "pollMs">;
};

const RECENT = 20;
const FOLDERS = 12;


type Identity = { pid: number; startedAt: string; executable: string };
/** Who a process belongs to: the agent's own CLI with a controlling terminal, an app, nobody at a terminal, or not known now. */
type Ownership = { owner: "standalone"; executable: string } | { owner: "app_owned" | "no_tty" | "gone" | "unknown" };

export class ControlBroker {
  private readonly deps: BrokerDeps;
  private readonly ledger: RequestLedger;
  private readonly services: ServiceControls;
  private readonly holding = new Set<string>();
  /** The owner of each running process (by its instance), kept by the liveness pass so the screens' view spawns nothing. */
  private owners = new Map<string, "standalone" | "app_owned" | "no_tty">();
  private last = "";

  constructor(deps: BrokerDeps) {
    this.deps = deps;
    this.ledger = new RequestLedger({ store: deps.store, now: deps.now, log: deps.log, publish: () => this.publish(), released: (row) => this.holding.delete(row.target) });
    this.services = new ServiceControls({ ledger: this.ledger, store: deps.store, processes: deps.processes, now: deps.now, log: deps.log, publish: () => this.publish(), ...deps.services });
  }

  private spec(agent: string): AgentLifecycle | undefined {
    return this.deps.agents.find((entry) => entry.agent === agent);
  }

  /** Whether the liveness check must leave this session alone: a stop of its process is in flight. */
  holds(session: string): boolean {
    return this.holding.has(session);
  }

  /** Why `control` cannot be asked for `session` now (null: it can), from what the daemon knows. */
  private refusal(snapshot: Snapshot | undefined, control: "stop" | "restart"): string | null {
    if (snapshot === undefined) return "not_found";
    const spec = this.spec(snapshot.agent);
    if (spec === undefined || !spec.controls.includes(control)) return "not_declared";
    if (snapshot.parent !== null || snapshot.lifecycle !== "active") return "not_active";
    if (!STOPPABLE.includes(snapshot.state)) return "at_work";
    const all = this.deps.snapshots();
    if (snapshot.children.some((id) => all[id]?.lifecycle === "active")) return "has_children";
    const info = this.deps.infoOf(snapshot.session);
    const anyHost = control === "stop" && spec.lifecycle.stop?.scope === "standalone_tty";
    if (info === undefined || (!anyHost && (info.launcher === null || !spec.lifecycle.hosts.includes(info.launcher)))) return "host_not_terminal";
    if (info.terminal?.["ssh"] === true) return "ssh";
    if (!this.deps.processes.supported) return "unsupported_platform";
    if (info.pid === null || info.pidStartedAt === null || (info.pidConfidence !== "exact" && info.pidConfidence !== "ancestor")) return "identity_unverified";
    const owner = this.owners.get(instanceOf(info.pid, info.pidStartedAt));
    if (owner === undefined) return "identity_unverified";
    if (owner !== "standalone") return owner;
    if (control === "restart" && (!this.deps.desktop.supported || !isDirectory(info.cwd))) return info.cwd === null || !this.deps.desktop.supported ? "unsupported_platform" : "folder_missing";
    if (this.ledger.busy.has(snapshot.session)) return "busy";
    return null;
  }

  /** The screens' view: recent requests, which sessions can be stopped or restarted now, and where a session can be started. */
  state(): ControlsState {
    const snapshots = this.deps.snapshots();
    const available: ControlsState["available"] = {};
    for (const snapshot of Object.values(snapshots)) {
      const controls = (["stop", "restart"] as const).filter((control) => this.refusal(snapshot, control) === null);
      const info = this.deps.infoOf(snapshot.session);
      if (controls.length > 0 && info?.pid != null && info.pidStartedAt !== null) available[snapshot.session] = { controls, instance: instanceOf(info.pid, info.pidStartedAt) };
    }
    const canStart = this.deps.desktop.supported && this.deps.processes.supported;
    const agents = canStart ? this.deps.agents.filter((entry) => entry.controls.includes("start")).map((entry) => entry.agent) : [];
    const folders: string[] = [];
    if (agents.length > 0) {
      const recent = Object.values(snapshots).sort((a, b) => b.last_signal_at.localeCompare(a.last_signal_at));
      for (const snapshot of recent) {
        const cwd = this.deps.infoOf(snapshot.session)?.cwd ?? null;
        if (cwd !== null && !folders.includes(cwd) && isDirectory(cwd)) folders.push(cwd);
        if (folders.length >= FOLDERS) break;
      }
    }
    return { requests: this.deps.store.recentControls(RECENT).map(view), available, start: { agents, folders }, services: this.services.views() };
  }

  /** Who `pid` belongs to, asked of the operating system now. */
  private ownership(pid: number): Ownership {
    const answer = this.deps.processes.executablePath(pid);
    if (!("path" in answer)) return { owner: answer.missing === "gone" ? "gone" : "unknown" };
    if (appOwnedPath(answer.path)) return { owner: "app_owned" };
    const terminal = this.deps.processes.controllingTty(pid);
    if (!("tty" in terminal)) return { owner: terminal.missing };
    return terminal.tty ? { owner: "standalone", executable: answer.path } : { owner: "no_tty" };
  }

  /** The liveness pass's part: finds the owner of each running process it has not seen, and forgets those that ended. */
  refreshOwners(): void {
    const next: typeof this.owners = new Map();
    for (const snapshot of Object.values(this.deps.snapshots())) {
      if (snapshot.parent !== null || snapshot.lifecycle !== "active") continue;
      const spec = this.spec(snapshot.agent);
      if (!spec?.controls.some((control) => control === "stop" || control === "restart")) continue;
      const info = this.deps.infoOf(snapshot.session);
      if (info?.pid == null || info.pidStartedAt === null) continue;
      const instance = instanceOf(info.pid, info.pidStartedAt);
      const owner = this.owners.get(instance) ?? this.ownership(info.pid).owner;
      if (owner === "standalone" || owner === "app_owned" || owner === "no_tty") next.set(instance, owner);
    }
    this.owners = next;
  }

  /** Publishes the view when it changed (after commits, liveness passes and request steps). */
  publish(): void {
    const state = this.state();
    const json = JSON.stringify(state);
    if (json === this.last) return;
    this.last = json;
    this.deps.onChange(state);
  }

  /** A start, stop or restart of a background service (POST /v1/services/<agent>/controls/<control>). */
  serviceRequest(agent: string, control: ControlName, key: string, instance: unknown): ControlReply {
    return this.services.request(agent, control, key, instance);
  }

  /** Reads the services' own status again (timer; the screens' view never runs a command). */
  refreshServices(): Promise<void> {
    return this.services.refresh();
  }

  /** A stop or restart of a session (POST /v1/sessions/<id>/controls/<control>). */
  request(session: string, control: "stop" | "restart", key: string, instance: unknown): ControlReply {
    if (!KEY.test(key)) return { status: 400, error: "idempotency_key" };
    const known = this.deps.store.controlByKey(key);
    if (known !== undefined) return known.target === session && known.control === control ? { status: 200, request: view(known) } : { status: 409, error: "idempotency_key_reused" };
    const snapshot = this.deps.snapshots()[session];
    const refusal = this.refusal(snapshot, control);
    if (refusal === "not_found") return { status: 404, error: "not_found" };
    if (refusal !== null) return { status: 409, error: refusal };
    const info = this.deps.infoOf(session)!;
    if (typeof instance !== "string" || !INSTANCE.test(instance)) return { status: 400, error: "instance" };
    if (instance !== instanceOf(info.pid!, info.pidStartedAt!)) return { status: 409, error: "instance_changed" };
    const row = this.ledger.newRow(session, snapshot!.agent, control, key);
    this.deps.store.insertControl(row);
    this.ledger.busy.set(session, row.id);
    this.holding.add(session);
    // The answer goes out first; the steps (lookups, the agent's list, the signal) follow.
    setImmediate(() => void this.ledger.run(row, () => this.stopThen(row, snapshot!.agent, control)));
    return { status: 202, request: view(row) };
  }

  /** A new session of `agent` in `cwd` (POST /v1/controls/start). */
  start(agent: unknown, cwd: unknown, key: string): ControlReply {
    if (!KEY.test(key)) return { status: 400, error: "idempotency_key" };
    const known = this.deps.store.controlByKey(key);
    if (known !== undefined) return known.control === "start" && known.agent === agent ? { status: 200, request: view(known) } : { status: 409, error: "idempotency_key_reused" };
    const spec = typeof agent === "string" ? this.spec(agent) : undefined;
    if (spec === undefined || !spec.controls.includes("start") || spec.lifecycle.start === undefined) return { status: 409, error: "not_declared" };
    if (!this.deps.desktop.supported || !this.deps.processes.supported) return { status: 409, error: "unsupported_platform" };
    if (typeof cwd !== "string" || !isDirectory(cwd)) return { status: 400, error: "folder_missing" };
    if (!this.deps.hooksDelivered(spec.agent)) return { status: 409, error: "hooks_missing" };
    const target = `start:${spec.agent}`;
    if (this.ledger.busy.has(target)) return { status: 409, error: "busy" };
    const session = randomUUID();
    const argv = [spec.lifecycle.start.command, ...spec.lifecycle.start.args.map((arg) => arg.replaceAll("{session}", session).replaceAll("{cwd}", cwd))];
    const row = this.ledger.newRow(target, spec.agent, "start", key);
    this.deps.store.insertControl(row);
    this.ledger.busy.set(target, row.id);
    const app = this.terminalApp();
    setImmediate(() => void this.ledger.run(row, () => this.launch(row, spec, session, cwd, argv, app)));
    return { status: 202, request: view(row) };
  }

  /** The terminal app of the most recent session that ran in a terminal (iTerm2 or Terminal). */
  private terminalApp(): "iTerm" | "Terminal" {
    const recent = Object.values(this.deps.snapshots()).sort((a, b) => b.last_signal_at.localeCompare(a.last_signal_at));
    for (const snapshot of recent) {
      const info = this.deps.infoOf(snapshot.session);
      if (info?.launcher === "terminal") return info.terminal?.["TERM_PROGRAM"] === "iTerm.app" ? "iTerm" : "Terminal";
    }
    return "Terminal";
  }

  /** The process `session` runs in, identified afresh; or why it cannot be. */
  private identify(session: string, spec: AgentLifecycle): Identity | string {
    const info = this.deps.infoOf(session);
    if (info?.pid == null || info.pidStartedAt === null) return "identity_unverified";
    const live = this.deps.lookup([info.pid]).get(info.pid);
    if (live === undefined || live.startedAt !== info.pidStartedAt) return "instance_changed";
    const found = this.ownership(info.pid);
    if (found.owner === "gone") return "instance_changed";
    if (found.owner === "unknown") return "identity_unverified";
    if (found.owner !== "standalone") return found.owner;
    const executable = found.executable;
    if (!spec.lifecycle.process_names.includes(basename(executable))) return "identity_unverified";
    const listed = this.deps.inventory(spec.agent, executable, spec.lifecycle.inventory!.args);
    if (listed.outcome !== "ok") return "inventory_unavailable";
    const verdict = inventoryVerdict(listed.entries, session, info.pid);
    if (verdict !== "ok") return verdict === "absent" ? "identity_unverified" : "inventory_mismatch";
    return { pid: info.pid, startedAt: live.startedAt, executable };
  }

  private gone(identity: Pick<Identity, "pid" | "startedAt">): boolean {
    return this.deps.lookup([identity.pid]).get(identity.pid)?.startedAt !== identity.startedAt;
  }

  private async stopThen(row: ControlRequestRow, agent: string, control: "stop" | "restart"): Promise<void> {
    const spec = this.spec(agent)!;
    const session = row.target;
    const identity = this.identify(session, spec);
    if (typeof identity === "string") return this.ledger.fail(row, identity);
    const below = descendantsIn(this.deps.processes.list(), identity.pid);
    this.ledger.save(row, { instance_json: JSON.stringify({ pid: identity.pid, started_at: identity.startedAt }), step: control === "restart" ? "stopping" : null });
    const outcome = this.deps.processes.signal({ pid: identity.pid, startedAt: identity.startedAt, names: spec.lifecycle.process_names }, spec.lifecycle.stop!.signal);
    if (outcome !== "signalled") return this.ledger.fail(row, outcome === "not_permitted" ? "signal_not_permitted" : "instance_changed");
    this.ledger.save(row, { status: "sent" }, { signalled_at: this.ledger.iso() });
    const until = this.deps.now() + spec.lifecycle.stop!.grace_s * 1000;
    while (!this.gone(identity)) {
      if (this.ledger.closed) return;
      if (this.deps.now() >= until) return this.ledger.fail(row, "still_running", "timeout");
      await sleep(this.deps.pollMs ?? 250);
    }
    const table = this.deps.processes.list();
    const leftover = below.filter((p) => table.get(p.pid)?.startedAt === p.startedAt).length;
    const snapshot = this.deps.snapshots()[session];
    const endedByAgent = snapshot?.lifecycle === "ended";
    if (!endedByAgent) this.deps.stopped(session);
    const evidence = { instance_gone_at: this.ledger.iso(), session_end_signal: endedByAgent, descendants: below.length, leftover_descendants: leftover };
    if (control === "stop") return this.ledger.save(row, { status: "confirmed" }, evidence);
    this.holding.delete(session);
    this.ledger.save(row, { step: "stopped" }, evidence);
    const info = this.deps.infoOf(session)!;
    const argv = this.restartArgv(spec, session, info.cwd!);
    if (argv === null) return this.ledger.fail(row, "unsupported_platform");
    const app = info.terminal?.["TERM_PROGRAM"] === "iTerm.app" ? "iTerm" : "Terminal";
    await this.launch(row, spec, session, info.cwd!, argv, app);
  }

  /** A session with a transcript is resumed; one that never had a turn starts again with its own id. */
  private restartArgv(spec: AgentLifecycle, session: string, cwd: string): string[] | null {
    if (this.deps.hasTranscript(spec.agent, session)) return resumeArgv({ session, agent: spec.agent, active: false, pid: null, cwd, terminal: null });
    const start = spec.lifecycle.start!;
    return [start.command, ...start.args.map((arg) => arg.replaceAll("{session}", session).replaceAll("{cwd}", cwd))];
  }

  /** Opens the new window and waits until the session is bound to the process it started. */
  private async launch(row: ControlRequestRow, spec: AgentLifecycle, session: string, cwd: string, argv: string[], app: "iTerm" | "Terminal"): Promise<void> {
    const pidFile = join(this.deps.launchDir, `${row.id}.pid`);
    const launchedAt = this.ledger.iso();
    const deadline = new Date(this.deps.now() + (this.deps.bindMs ?? 90_000)).toISOString();
    this.ledger.save(row, { status: "sent", step: row.control === "restart" ? "starting" : "launching", launch_json: JSON.stringify({ session, pid_file: pidFile, launched_at: launchedAt, resumed: argv.includes("--resume") || argv.includes("resume") }), deadline_at: deadline });
    const opened = await this.deps.desktop.openTerminal(app, cwd, argv, { pidFile, ...(spec.lifecycle.unset_env === undefined ? {} : { unset: spec.lifecycle.unset_env }) });
    if (!opened) return this.ledger.fail(row, "terminal_not_opened");
    await this.awaitBinding(row, spec);
  }

  /** The new process is the session's when a hook of that session came after the launch from the process the window's script became. */
  private async awaitBinding(row: ControlRequestRow, spec: AgentLifecycle): Promise<void> {
    const launch = JSON.parse(row.launch_json!) as { session: string; pid_file: string; launched_at: string };
    const until = Date.parse(row.deadline_at!);
    let launched: ProcessInfo | null = null;
    while (!this.ledger.closed) {
      if (launched === null) launched = this.launchedProcess(launch.pid_file, spec);
      if (launched !== null) {
        const snapshot = this.deps.snapshots()[launch.session];
        const info = this.deps.infoOf(launch.session);
        const fresh = snapshot !== undefined && snapshot.lifecycle === "active" && snapshot.last_signal_at >= launch.launched_at && info?.reportedPid != null;
        if (fresh && verifyPid(info.reportedPid!, spec.lifecycle.process_names, this.deps.lookup).pid === launched.pid) {
          rmSync(launch.pid_file, { force: true });
          this.deps.recheck();
          return this.ledger.save(row, { status: "confirmed", step: row.control === "restart" ? "recovered" : "bound", target: launch.session }, { bound_at: this.ledger.iso(), new_instance_started_at: launched.startedAt });
        }
      }
      if (this.deps.now() >= until) {
        const written = existsSync(launch.pid_file);
        rmSync(launch.pid_file, { force: true });
        if (launched === null) return this.ledger.fail(row, written ? "no_process" : "terminal_not_opened");
        return this.gone(launched) ? this.ledger.fail(row, "no_process") : this.ledger.fail(row, "no_first_signal", "timeout");
      }
      await sleep(this.deps.pollMs ?? 250);
    }
  }

  /** The process a new window's script wrote its id for (it keeps that id through `exec`), when it runs the agent. */
  private launchedProcess(pidFile: string, spec: AgentLifecycle): ProcessInfo | null {
    // The window's script writes it once; the broker removes it only after it is done waiting.
    if (!existsSync(pidFile)) return null;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    const info = this.deps.lookup([pid]).get(pid);
    return info !== undefined && spec.lifecycle.process_names.includes(executableName(info.command)) ? info : null;
  }

  /**
   * After a restart of the daemon: settles the requests it was waiting on from what it finds, before
   * the first liveness pass. A stop whose process is gone is confirmed; one whose process still runs,
   * or a restart interrupted before its window opened, fails; a window already opened is waited for
   * until its deadline. No signal is sent and no window opened again.
   */
  reconcile(): void {
    for (const row of this.deps.store.openControls()) {
      if (row.target.startsWith(SERVICE_PREFIX)) {
        this.services.reconcile(row);
        continue;
      }
      const spec = this.spec(row.agent);
      const instance = row.instance_json === null ? null : (JSON.parse(row.instance_json) as { pid: number; started_at: string });
      if (row.launch_json !== null && spec !== undefined && (row.step === "starting" || row.step === "launching")) {
        this.ledger.busy.set(row.target, row.id);
        void this.ledger.run(row, () => this.awaitBinding(row, spec));
        continue;
      }
      const gone = instance !== null && this.gone({ pid: instance.pid, startedAt: instance.started_at });
      const snapshot = this.deps.snapshots()[row.target];
      if (gone && snapshot?.lifecycle === "active") this.deps.stopped(row.target);
      if (gone && row.control === "stop") this.ledger.save(row, { status: "confirmed" }, { instance_gone_at: this.ledger.iso(), after_daemon_restart: true });
      else this.ledger.fail(row, "daemon_restarted");
    }
  }

  close(): void {
    this.ledger.closed = true;
  }
}
