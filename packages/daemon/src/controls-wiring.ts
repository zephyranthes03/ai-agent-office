// The lifecycle controls' broker (controls.ts) as the daemon builds it: start, stop and restart of
// the declared agents' sessions, with a private folder for the new windows' pid files.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createProcessControl, createServiceHost } from "@agent-office/platform";
import type { Desktop, Platform } from "@agent-office/platform";
import { claudeTranscriptExists, ControlBroker, declaredLifecycles } from "./controls.ts";
import type { ControlsState } from "./controls.ts";
import type { DaemonOptions } from "./daemon-options.ts";
import type { Paths } from "./files.ts";
import type { Ingestor } from "./ingest.ts";
import { runInventory } from "./inventory.ts";
import type { AgentHomes } from "./log-files.ts";
import type { ServiceTask } from "./service-controls.ts";
import type { Store } from "./store.ts";

export function wireControls(deps: {
  options: Pick<DaemonOptions, "lifecycles" | "processControl" | "inventory" | "controlPollMs" | "controlBindMs" | "services" | "serviceHost" | "servicePollMs">;
  paths: Paths;
  homes: AgentHomes;
  store: Store;
  ingestor: Ingestor;
  desktop: Desktop;
  platform: Platform;
  now: () => number;
  log: (line: string) => void;
  recheck: () => void;
  onChange: (state: ControlsState) => void;
  tasks: (agent: string) => ServiceTask[];
}): ControlBroker {
  const { options, paths, homes, store, ingestor, desktop, platform, now, log, recheck, onChange, tasks } = deps;
  const launchDir = join(paths.home, "control");
  mkdirSync(launchDir, { recursive: true, mode: 0o700 });
  return new ControlBroker({
    store,
    now,
    log,
    snapshots: () => ingestor.snapshots(),
    infoOf: (id) => ingestor.infoOf(id),
    stopped: (id) => void ingestor.stopped(id),
    agents: options.lifecycles ?? declaredLifecycles(),
    processes: options.processControl ?? createProcessControl(),
    lookup: (pids) => platform.lookupProcesses(pids),
    inventory: options.inventory ?? runInventory,
    desktop,
    launchDir,
    hasTranscript: (agent, session) => agent === "claude-code" && claudeTranscriptExists(homes.claude, session),
    hooksDelivered: (agent) => store.hooksDelivered(agent),
    recheck,
    onChange,
    ...(options.controlPollMs === undefined ? {} : { pollMs: options.controlPollMs }),
    ...(options.controlBindMs === undefined ? {} : { bindMs: options.controlBindMs }),
    services: { entries: options.services ?? [], host: options.serviceHost ?? createServiceHost(), tasks, ...(options.servicePollMs === undefined ? {} : { pollMs: options.servicePollMs }) },
  });
}
