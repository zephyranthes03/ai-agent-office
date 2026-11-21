// Starting, stopping and restarting a background service an adapter declares (descriptor `service`).
// The service's own command does the work; success is only what is observed afterwards: the process
// gone and the service reported stopped, or a new process reported running and answering. The screen
// sends the process it saw, nothing is retried, and a daemon restart settles an open request from what
// it finds and runs no command again. Status is read on a timer, so the screens' view runs nothing.
import { descendantsIn, executableName } from "@agent-office/platform";
import type { ProcessControl, ServiceHost } from "@agent-office/platform";
import { setTimeout as sleep } from "node:timers/promises";
import { INSTANCE, KEY, OPEN } from "./control-ledger.ts";
import type { RequestLedger } from "./control-ledger.ts";
import { instanceOf, view } from "./lifecycle.ts";
import type { ControlName, ControlReply, ServiceEntry, ServiceView } from "./lifecycle.ts";
import { readServiceStatus } from "./service-status.ts";
import type { ServiceReading } from "./service-status.ts";
import type { ControlRequestRow, Store } from "./store.ts";

export const SERVICE_PREFIX = "service:";
/** A scheduled run this close is not to be cut off by a stop or restart. */
const DUE_SOON_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 30_000;

export type ServiceTask = { running_at?: string | null; next_run_at: string | null };
export type ServiceDeps = {
  ledger: RequestLedger;
  store: Store;
  processes: ProcessControl;
  now: () => number;
  log: (line: string) => void;
  publish: () => void;
  entries: readonly ServiceEntry[];
  host: ServiceHost;
  /** The scheduled tasks this agent's service runs. */
  tasks: (agent: string) => ServiceTask[];
  pollMs?: number;
};

type Process = { pid: number; startedAt: string };
type Instance = Process & { supervisor: Process | null };
type Observed = { reading: ServiceReading; instance: Instance | null };

const tokenOf = (instance: Instance | null): string | null => (instance === null ? null : instanceOf(instance.pid, instance.startedAt));

export class ServiceControls {
  private readonly deps: ServiceDeps;
  private readonly known = new Map<string, Observed>();
  private refreshing = false;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
  }

  private entry(agent: string): ServiceEntry | undefined {
    return this.deps.entries.find((entry) => entry.agent === agent);
  }

  /** The process a running service reading points to, checked against launchd or the port it serves; null when it cannot be told. */
  private identify(spec: ServiceEntry, reading: Extract<ServiceReading, { state: "running" }>): Instance | null {
    const table = this.deps.processes.list();
    let pid = reading.pid;
    let supervisor: Process | null = null;
    if (spec.identify.by === "launchd") {
      const job = this.deps.host.launchdJobs().get(spec.identify.label);
      if (job === undefined || job === null || pid === null) return null;
      if (pid !== job) {
        const top = table.get(job);
        if (top === undefined || !descendantsIn(table, job).some((process) => process.pid === pid)) return null;
        supervisor = { pid: job, startedAt: top.startedAt };
      }
    } else if (spec.identify.by === "listener") {
      if (reading.port === null) return null;
      pid = this.deps.host.listenerOf(reading.port);
    } else {
      pid = this.deps.host.holderOf(spec.identify.path);
    }
    const process = pid === null ? undefined : table.get(pid);
    return process === undefined || !spec.process_names.includes(executableName(process.command)) ? null : { pid: process.pid, startedAt: process.startedAt, supervisor };
  }

  /** Runs a status command of the service now and identifies its process. */
  private async observe(spec: ServiceEntry, args: readonly string[] = spec.status.args): Promise<Observed> {
    const path = this.deps.host.locate(spec.command);
    if (path === null) return { reading: { state: "unknown", problem: "service_not_installed" }, instance: null };
    const result = await this.deps.host.run(path, args, STATUS_TIMEOUT_MS);
    if (result.outcome !== "exited") return { reading: { state: "unknown", problem: "status_unreadable" }, instance: null };
    const reading = readServiceStatus(spec.status.format, result.code, result.stdout, result.stderr);
    return { reading, instance: reading.state === "running" ? this.identify(spec, reading) : null };
  }

  /** Why a stop or restart must wait for this agent's scheduled runs, if it must. */
  private guard(agent: string): string | null {
    const tasks = this.deps.tasks(agent);
    if (tasks.some((task) => task.running_at !== null && task.running_at !== undefined)) return "run_in_progress";
    const now = this.deps.now();
    return tasks.some((task) => task.next_run_at !== null && Date.parse(task.next_run_at) >= now && Date.parse(task.next_run_at) - now <= DUE_SOON_MS) ? "run_due_soon" : null;
  }

  /** What can be asked of the service now, and the reason when nothing can. */
  private options(spec: ServiceEntry, observed: Observed): { controls: ControlName[]; note: string | null } {
    const { reading, instance } = observed;
    if (reading.state === "unknown") return { controls: [], note: reading.problem };
    if (reading.state === "stopped") return { controls: spec.controls.filter((control) => control === "start"), note: null };
    if (instance === null) return { controls: [], note: "identity_unverified" };
    const note = this.guard(spec.agent);
    return note === null ? { controls: spec.controls.filter((control) => control !== "start"), note: null } : { controls: [], note };
  }

  views(): ServiceView[] {
    if (!this.deps.host.supported) return [];
    return this.deps.entries.flatMap((spec) => {
      const observed = this.known.get(spec.agent);
      if (observed === undefined || (observed.reading.state === "unknown" && observed.reading.problem === "service_not_installed")) return [];
      const { controls, note } = this.deps.ledger.busy.has(SERVICE_PREFIX + spec.agent) ? { controls: [], note: null } : this.options(spec, observed);
      return [{ agent: spec.agent, state: observed.reading.state, controls, instance: tokenOf(observed.instance), note }];
    });
  }

  /** Reads every service's status again, leaving alone one with a request under way. */
  async refresh(): Promise<void> {
    if (this.refreshing || !this.deps.host.supported) return;
    this.refreshing = true;
    try {
      for (const spec of this.deps.entries) {
        if (this.deps.ledger.busy.has(SERVICE_PREFIX + spec.agent)) continue;
        const observed = await this.observe(spec);
        if (this.deps.ledger.closed) return;
        this.known.set(spec.agent, observed);
      }
      this.deps.publish();
    } catch (error) {
      this.deps.log(`services_failed ${(error as Error).name} ${(error as NodeJS.ErrnoException).code ?? ""}`.trim());
    } finally {
      this.refreshing = false;
    }
  }

  request(agent: string, control: ControlName, key: string, instance: unknown): ControlReply {
    if (!KEY.test(key)) return { status: 400, error: "idempotency_key" };
    const target = SERVICE_PREFIX + agent;
    const known = this.deps.store.controlByKey(key);
    if (known !== undefined) return known.target === target && known.control === control ? { status: 200, request: view(known) } : { status: 409, error: "idempotency_key_reused" };
    const spec = this.entry(agent);
    if (spec === undefined || !spec.controls.includes(control)) return { status: 409, error: "not_declared" };
    if (!this.deps.host.supported) return { status: 409, error: "unsupported_platform" };
    if (this.deps.ledger.busy.has(target)) return { status: 409, error: "busy" };
    const observed = this.known.get(agent);
    if (observed === undefined) return { status: 409, error: "status_unreadable" };
    const { controls, note } = this.options(spec, observed);
    if (!controls.includes(control)) return { status: 409, error: note ?? "instance_changed" };
    if (control !== "start") {
      if (typeof instance !== "string" || !INSTANCE.test(instance)) return { status: 400, error: "instance" };
      if (instance !== tokenOf(observed.instance)) return { status: 409, error: "instance_changed" };
    }
    const row = this.deps.ledger.newRow(target, agent, control, key);
    this.deps.store.insertControl(row);
    this.deps.ledger.busy.set(target, row.id);
    setImmediate(() => void this.deps.ledger.run(row, () => this.act(row, spec, control, typeof instance === "string" ? instance : null)));
    return { status: 202, request: view(row) };
  }

  /** The service's process is gone, or a new one runs and answers. */
  private async settled(spec: ServiceEntry, control: ControlName, before: Instance | null, observed: Observed): Promise<boolean> {
    if (control === "stop") {
      if (observed.reading.state !== "stopped" || before === null) return false;
      const table = this.deps.processes.list();
      const gone = (process: Process) => table.get(process.pid)?.startedAt !== process.startedAt;
      if (!gone(before) || (before.supervisor !== null && !gone(before.supervisor))) return false;
      return spec.identify.by !== "launchd" || !this.deps.host.launchdJobs().has(spec.identify.label);
    }
    if (observed.instance === null || (before !== null && observed.instance.pid === before.pid && observed.instance.startedAt === before.startedAt)) return false;
    if (spec.health === undefined) return true;
    const health = await this.observe(spec, spec.health.args);
    return health.reading.state === "running" && health.reading.healthy === true;
  }

  private async act(row: ControlRequestRow, spec: ServiceEntry, control: ControlName, token: string | null): Promise<void> {
    const { ledger } = this.deps;
    // Looked at again right before: the screen may be up to a minute old.
    const before = await this.observe(spec);
    this.known.set(spec.agent, before);
    if (ledger.closed) return;
    const { controls, note } = this.options(spec, before);
    if (!controls.includes(control)) return ledger.fail(row, note ?? "instance_changed");
    if (control !== "start" && tokenOf(before.instance) !== token) return ledger.fail(row, "instance_changed");
    const path = this.deps.host.locate(spec.command);
    if (path === null) return ledger.fail(row, "service_not_installed");
    ledger.save(row, { status: "sent", step: "running_command", instance_json: before.instance === null ? null : JSON.stringify({ pid: before.instance.pid, started_at: before.instance.startedAt, supervisor: before.instance.supervisor }) });
    const result = await this.deps.host.run(path, spec[control].args, spec.timeout_s * 1000);
    if (ledger.closed) return;
    if (result.outcome === "timeout") return ledger.fail(row, "command_timeout", "timeout");
    if (result.outcome === "failed" || result.code !== 0) {
      ledger.save(row, {}, result.outcome === "exited" ? { exit_code: result.code } : {});
      return ledger.fail(row, "command_failed");
    }
    ledger.save(row, { step: "confirming" }, { exit_code: 0, command_done_at: ledger.iso() });
    const until = this.deps.now() + spec.settle_s * 1000;
    for (;;) {
      const observed = await this.observe(spec);
      if (ledger.closed) return;
      this.known.set(spec.agent, observed);
      if (await this.settled(spec, control, before.instance, observed)) {
        if (ledger.closed) return;
        return ledger.save(row, { status: "confirmed", step: null }, { confirmed_at: ledger.iso(), ...(observed.instance === null ? {} : { new_instance_started_at: observed.instance.startedAt }) });
      }
      if (this.deps.now() >= until) return ledger.fail(row, control === "stop" ? "still_running" : "not_confirmed", "timeout");
      await sleep(this.deps.pollMs ?? 1000);
    }
  }

  /** After a restart of the daemon: settles a request from what it finds; no command runs again. */
  reconcile(row: ControlRequestRow): void {
    const { ledger } = this.deps;
    const spec = this.entry(row.agent);
    if (spec === undefined || row.status !== "sent") return ledger.fail(row, "daemon_restarted");
    ledger.busy.set(row.target, row.id);
    void ledger.run(row, async () => {
      const before = row.instance_json === null ? null : (JSON.parse(row.instance_json) as { pid: number; started_at: string });
      const found = await this.observe(spec);
      if (ledger.closed || !OPEN.includes(row.status)) return;
      this.known.set(spec.agent, found);
      const stopped = row.control === "stop" && found.reading.state === "stopped";
      const replaced = row.control !== "stop" && found.instance !== null && (before === null || found.instance.pid !== before.pid || found.instance.startedAt !== before.started_at);
      if (stopped || replaced) return ledger.save(row, { status: "confirmed", step: null }, { after_daemon_restart: true });
      ledger.fail(row, "daemon_restarted");
    });
  }
}
