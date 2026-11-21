// The read-only viewer listener (server mode) as the daemon builds it, only when an address was
// given on the command line: its address, who may pair, web push, and the API phones talk to.
import { hostname } from "node:os";
import pkg from "../package.json" with { type: "json" };
import type { AttentionTracker } from "./attention.ts";
import { sceneSettings } from "./config.ts";
import type { DaemonConfig } from "./config.ts";
import type { DaemonOptions } from "./daemon-options.ts";
import type { Ingestor } from "./ingest.ts";
import type { Notes } from "./notes.ts";
import { manualCommand, topSession } from "./open.ts";
import { PushSender } from "./push.ts";
import type { Store } from "./store.ts";
import { createViewerApi, hostHeader, parseViewerAddress, parseViewerHost, ViewerAccess } from "./viewer.ts";

export function wireViewer(deps: {
  options: Pick<DaemonOptions, "viewer" | "viewerHost" | "pushFetch">;
  store: Store;
  ingestor: Ingestor;
  attention: AttentionTracker;
  notes: Notes;
  config: DaemonConfig;
  uiRoot: string;
  now: () => number;
  log: (line: string) => void;
}) {
  const { options, store, ingestor, attention, notes, config, uiRoot, now, log } = deps;
  const viewerAddress = options.viewer === undefined ? null : parseViewerAddress(options.viewer);
  if (viewerAddress !== null && "problem" in viewerAddress) {
    store.close();
    throw new Error(`viewer address ${options.viewer}: ${viewerAddress.problem}`);
  }
  const viewerHost = options.viewerHost === undefined ? null : parseViewerHost(options.viewerHost);
  if (options.viewerHost !== undefined && (viewerHost === null || viewerAddress === null)) {
    store.close();
    throw new Error(viewerAddress === null ? "--viewer-host needs --viewer" : `viewer host ${options.viewerHost}: not a DNS name`);
  }
  const viewerUrl = viewerAddress === null ? null : viewerHost !== null ? `https://${viewerHost}/` : `http://${hostHeader(viewerAddress)}/`;
  const push = viewerAddress === null ? null : new PushSender({ store, now, log, ...(options.pushFetch === undefined ? {} : { fetch: options.pushFetch }) });
  let dropDevice: (id: string) => void = () => undefined;
  const access = viewerAddress === null ? null : new ViewerAccess(store, now, (id) => dropDevice(id));
  const resumeFor = (id: string): string | null | "unknown" => {
    const top = topSession(ingestor.snapshots(), id);
    if (top === undefined) return "unknown";
    return manualCommand({ session: top.session, agent: top.agent, active: top.lifecycle === "active", pid: null, cwd: null, terminal: null });
  };
  const viewer =
    viewerAddress === null || access === null
      ? null
      : createViewerApi({
          address: viewerAddress,
          hostName: viewerHost,
          level: config.viewerDetail,
          uiRoot,
          access,
          sessions: () => ingestor.sessions(),
          attention: () => attention.current(),
          resume: resumeFor,
          machine: hostname(),
          version: pkg.version,
          log,
          notes,
          settings: sceneSettings(config),
          push: {
            publicKey: () => push!.publicKey(),
            subscribed: (device) => store.pushSubscriptions().some((row) => row.device_id === device),
            put: (device, target) => store.putPushSubscription({ device_id: device, ...target, created_at: new Date(now()).toISOString() }),
            remove: (device) => void store.removePushSubscription(device),
          },
        });
  if (viewer !== null) dropDevice = (id) => viewer.drop(id);
  return { viewerAddress, viewerUrl, push, access, viewer };
}
