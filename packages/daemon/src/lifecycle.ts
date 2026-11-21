// What lifecycle controls are made of, apart from the broker that runs them (controls.ts):
// the adapters' declared, verified lifecycle entries; how a request and the controls' state look on the
// API and the stream; the token a screen sends to name the process it saw; and the few file checks a
// request needs (a folder to open a window in, whether Claude Code keeps a session's transcript).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { descriptors, serviceDescriptors } from "@agent-office/adapters";
import type { ServiceFormat } from "./service-status.ts";
import type { ControlRequestRow } from "./store.ts";

import type { ControlName, ControlsState, ControlView, ServiceView } from "@agent-office/core";
export type { ControlName, ControlsState, ControlView, ServiceView };
export type Lifecycle = {
  hosts: readonly string[];
  process_names: readonly string[];
  /** `scope: standalone_tty`: stop applies to any process the agent's own CLI runs with a controlling terminal, wherever; without it, only to `hosts`. */
  stop?: { signal: "SIGTERM" | "SIGHUP" | "SIGINT"; grace_s: number; verified: boolean; scope?: "standalone_tty" };
  start?: { command: string; args: readonly string[]; verified: boolean };
  restart?: { verified: boolean };
  inventory?: { args: readonly string[]; verified: boolean };
  unset_env?: readonly string[];
};
/** One adapter's lifecycle controls, as its descriptor declares them. */
export type AgentLifecycle = { agent: string; controls: readonly ControlName[]; lifecycle: Lifecycle };

/** The declared lifecycle controls of every adapter, each only with its verified entry. */
export function declaredLifecycles(): AgentLifecycle[] {
  return Object.values(descriptors).flatMap((descriptor) => {
    const d = descriptor as { id: string; controls: readonly string[]; lifecycle?: Lifecycle };
    if (d.lifecycle === undefined || d.lifecycle.inventory?.verified !== true) return [];
    const lifecycle = d.lifecycle;
    const controls = (["start", "stop", "restart"] as const).filter((c) => d.controls.includes(c) && (c === "restart" ? lifecycle.restart?.verified && lifecycle.stop?.verified && lifecycle.start?.verified : lifecycle[c]?.verified) === true);
    return controls.length === 0 ? [] : [{ agent: d.id, controls, lifecycle }];
  });
}

/** A background service an adapter declares (descriptor `service`), checked natively before it is declared. */
export type ServiceEntry = {
  agent: string;
  controls: readonly ControlName[];
  command: string;
  process_names: readonly string[];
  identify: { by: "launchd"; label: string } | { by: "listener" } | { by: "file_holder"; path: string };
  status: { args: readonly string[]; format: ServiceFormat };
  /** Same output format as `status`, with the check that the service answers. */
  health?: { args: readonly string[] };
  start: { args: readonly string[] };
  stop: { args: readonly string[] };
  restart: { args: readonly string[] };
  timeout_s: number;
  settle_s: number;
  verified: boolean;
};

/** The verified background services of every adapter. */
export function declaredServices(): ServiceEntry[] {
  return Object.values(serviceDescriptors).flatMap((descriptor) => {
    const d = descriptor as unknown as { id: string; service?: Omit<ServiceEntry, "agent"> };
    return d.service === undefined || d.service.verified !== true ? [] : [{ agent: d.id, ...d.service }];
  });
}

export type ControlReply = { status: 200 | 202; request: ControlView } | { status: 400 | 404 | 409; error: string };

export const instanceOf = (pid: number, startedAt: string): string => createHash("sha256").update(`${pid}:${startedAt}`).digest("hex").slice(0, 16);

/** An executable inside an app bundle, an editor's extensions or an app's support folder is that app's, whatever its name. */
export const appOwnedPath = (path: string): boolean => /\.app\/|\/extensions\/|\/Application Support\//.test(path);

export const isDirectory = (path: string | null): path is string => {
  if (path === null || !isAbsolute(path) || path.includes("\0")) return false;
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return false;
    throw error;
  }
};

/** Whether Claude Code keeps a transcript for `session` (`<home>/projects/<folder>/<session>.jsonl`); only names are looked at. */
export function claudeTranscriptExists(claudeHome: string, session: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session)) return false;
  const projects = join(claudeHome, "projects");
  let folders: string[];
  try {
    folders = readdirSync(projects).slice(0, 4096);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return folders.some((folder) => existsSync(join(projects, folder, `${session}.jsonl`)));
}

export function view(row: ControlRequestRow): ControlView {
  return {
    id: row.id,
    control: row.control as ControlName,
    agent: row.agent,
    session: row.target.startsWith("start:") || row.target.startsWith("service:") ? null : row.target,
    service: row.target.startsWith("service:") ? row.target.slice("service:".length) : null,
    status: row.status,
    step: row.step,
    requested_at: row.requested_at,
    resolved_at: row.resolved_at,
    reason: row.failure_reason,
    evidence: JSON.parse(row.evidence_json) as Record<string, unknown>,
  };
}
