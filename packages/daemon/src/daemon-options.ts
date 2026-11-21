// What `startDaemon` takes and what it hands back. Most options exist for tests; the defaults are
// this machine's.
import type { Desktop, Platform, ProcessControl, ServiceHost } from "@agent-office/platform";
import type { DaemonConfig } from "./config.ts";
import type { AgentLifecycle, ServiceEntry } from "./controls.ts";
import type { Paths } from "./files.ts";
import type { InventoryRunner } from "./inventory.ts";
import type { AgentHomes } from "./log-files.ts";
import type { ScanResult } from "./usage.ts";

export type DaemonOptions = {
  home?: string;
  /** 0 picks a free port; default: config `daemon.port` (47631), or the next free one. */
  port?: number;
  now?: () => number;
  tickMs?: number;
  drainMs?: number;
  drainGraceMs?: number;
  cleanupMs?: number;
  /** Where Claude Code and Codex keep their logs; default from CLAUDE_CONFIG_DIR / CODEX_HOME. */
  agentHomes?: AgentHomes;
  /** Explicit scheduler roots; defaults to each tool’s home and the Claude desktop app directory. */
  scheduleHomes?: { claudeApp?: string; openclaw?: string; hermes?: string; opencodeDb?: string };
  /** Fixed interval of the log scans (tests); default: the adaptive polling policy. */
  usageScanMs?: number;
  /** Process lookups (tests); default: this operating system's. */
  platform?: Platform;
  livenessMs?: number;
  /** The Claude desktop app's folder, for links to its Code sessions (tests); default: macOS's. */
  claudeAppDir?: string;
  /** The built browser UI; default: packages/ui/dist next to this package. */
  uiRoot?: string;
  /** Window focus and new terminal windows for "open session" (tests); default: this operating system's. */
  desktop?: Desktop;
  /** The read-only viewer listener's address (`host[:port]`, loopback or private only); off when absent. */
  viewer?: string;
  /** How long to wait before binding the viewer again after a failure (tests); default 30 s. */
  viewerRetryMs?: number;
  /** A name a proxy on this machine serves the viewer under over HTTPS (`--viewer-host`, e.g. `tailscale serve`). */
  viewerHost?: string;
  /** The network web push goes out through (tests pass their own push service). */
  pushFetch?: typeof fetch;
  /** Lifecycle controls' process signals and lookups (tests); default: this operating system's. */
  processControl?: ProcessControl;
  /** The agents' own session lists (tests); default: their declared inventory commands. */
  inventory?: InventoryRunner;
  /** The declared lifecycle controls (tests); default: the adapters' descriptors. */
  lifecycles?: AgentLifecycle[];
  /** How often a control looks again, and how long a new window has to bind its session (tests). */
  controlPollMs?: number;
  controlBindMs?: number;
  /** The background services the office may control; none unless the caller passes them (the CLI and the app pass the declared ones). */
  services?: ServiceEntry[];
  /** How services are run and looked at (tests); default: this operating system's. */
  serviceHost?: ServiceHost;
  /** How often services' status is read; default 60 s. */
  serviceMs?: number;
  /** How often a service request looks again while it settles (tests). */
  servicePollMs?: number;
};

export type DaemonHandle = {
  port: number;
  paths: Paths;
  config: DaemonConfig;
  /** Drains the spool now (tests and shutdown). */
  drain: () => void;
  /** Runs a clock tick now and publishes the attention list if it changed (it also runs every 5 s). */
  tick: () => void;
  /** Runs retention and memory cleanup now (it also runs every 6 hours). */
  cleanup: () => void;
  /** Reads the agents' logs for usage and limits now (it also runs on the polling schedule). */
  scanUsage: () => ScanResult;
  /** Checks the sessions' agent processes now (it also runs every 30 s). */
  checkLiveness: () => void;
  /** Reads the agents' files of active sessions now: titles, and Claude Code's Esc in quiet turns (it also runs with the liveness pass). */
  checkAgentFiles: () => void;
  /** Looks at the hook launcher and its marks now and publishes the `warnings` event if they changed (it also runs with the liveness pass, and after a commit while a warning stands). */
  checkHooks: () => void;
  /** Reads the agents' schedulers now (Codex's scheduled tasks), links their runs to sessions and publishes the `schedule` event if it changed (it also runs with the agent-files pass, and once when a new Codex session appears). */
  checkSchedule: () => void;
  /** The viewer listener's address, when one was asked for; `plain` when it is an unencrypted LAN address. */
  viewer: { url: string; plain: boolean } | null;
  close: () => Promise<void>;
};
