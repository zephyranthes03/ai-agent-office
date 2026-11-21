// `agent-office <command>`: the headless entry point. `daemon` runs the local daemon in the
// foreground until SIGINT/SIGTERM (SIGBREAK on Windows); `install-hooks` and `uninstall-hooks`
// add our hooks to an agent's settings or remove them, after confirmation; `emit` reports a
// script's own state as a standard event; `doctor` checks the setup (and, with --drift, the logs);
// `ui` prints a one-time address that opens the browser UI.
import { declaredServices, parseViewerAddress, parseViewerHost, startDaemon } from "@agent-office/daemon";
import { runDoctor } from "./doctor.ts";
import { EMIT_USAGE, runEmit } from "./emit.ts";
import { runInstall, systemContext } from "./install.ts";
import type { InstallRequest } from "./install.ts";
import { runUi } from "./ui.ts";
import { runDevices, runPair } from "./viewer.ts";

const USAGE = [
  "usage: agent-office daemon [--port <n>] [--viewer <address>[:<port>] [--viewer-host <name>]]",
  "       agent-office install-hooks <claude-code|codex|opencode|pi> [--dry-run] [--yes]",
  "       agent-office uninstall-hooks <claude-code|codex|opencode|pi> [--dry-run] [--yes]",
  `       ${EMIT_USAGE}`,
  "       agent-office doctor [--drift]",
  "       agent-office ui",
  "       agent-office pair",
  "       agent-office devices [revoke <id>]",
].join("\n");

function parsePort(args: string[]): number | undefined {
  const index = args.indexOf("--port");
  if (index < 0) return undefined;
  const port = Number(args[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(USAGE);
  return port;
}

/** `<agent> [--dry-run] [--yes]` in any order, or null for anything else. */
function parseInstall(action: InstallRequest["action"], args: string[]): InstallRequest | null {
  const agents = args.filter((arg) => !arg.startsWith("-"));
  const flags = args.filter((arg) => arg.startsWith("-"));
  if (agents.length !== 1 || flags.some((flag) => flag !== "--dry-run" && flag !== "--yes")) return null;
  return { action, agent: agents[0]!, dryRun: flags.includes("--dry-run"), yes: flags.includes("--yes") };
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "emit") return runEmit(args);
  if (command === "doctor") return runDoctor(args, systemContext());
  if (command === "ui") return runUi(args);
  if (command === "pair") return runPair(args);
  if (command === "devices") return runDevices(args);
  if (command === "install-hooks" || command === "uninstall-hooks") {
    const request = parseInstall(command === "install-hooks" ? "install" : "uninstall", args);
    if (request !== null) return runInstall(request, systemContext());
  }
  if (command !== "daemon") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  // Files the daemon creates are private to this user, whatever the shell's umask.
  if (process.platform !== "win32") process.umask(0o077);
  const port = parsePort(args);
  const viewerAt = args.indexOf("--viewer");
  const viewer = viewerAt < 0 ? undefined : args[viewerAt + 1];
  if (viewerAt >= 0 && viewer === undefined) throw new Error(USAGE);
  const checked = viewer === undefined ? null : parseViewerAddress(viewer);
  if (checked !== null && "problem" in checked) {
    process.stderr.write(`agent-office: --viewer ${viewer}: ${checked.problem}\n`);
    return 2;
  }
  // `--viewer-host <name>`: the name a proxy on this machine serves the viewer under over HTTPS (tailscale serve).
  const hostAt = args.indexOf("--viewer-host");
  const viewerHost = hostAt < 0 ? undefined : args[hostAt + 1];
  if (hostAt >= 0 && (viewerHost === undefined || viewer === undefined)) throw new Error(USAGE);
  if (viewerHost !== undefined && parseViewerHost(viewerHost) === null) {
    process.stderr.write(`agent-office: --viewer-host ${viewerHost}: not a DNS name (for example mac.tail1234.ts.net)\n`);
    return 2;
  }
  const handle = await startDaemon({ services: declaredServices(), ...(port === undefined ? {} : { port }), ...(viewer === undefined ? {} : { viewer }), ...(viewerHost === undefined ? {} : { viewerHost }) });
  process.stdout.write(`agent-office daemon listening on http://127.0.0.1:${handle.port} (pid ${process.pid}, home ${handle.paths.home})\n`);
  if (handle.config.problem) process.stderr.write(`config: ${handle.config.problem}; using defaults\n`);
  if (handle.viewer !== null) {
    process.stdout.write(`read-only viewer on ${handle.viewer.url} (pair a device with: agent-office pair)\n`);
    if (handle.viewer.plain && viewerHost === undefined) process.stderr.write("viewer: this is a plain Wi-Fi/LAN address, so the traffic is not encrypted: others on this network could read what a paired device receives (reading anything still needs a device token)\n");
  }
  // Closing removes daemon.json, so hooks do not keep finding a daemon that is gone. SIGHUP (the
  // terminal closed) counts as a stop too; an unexpected error is reported, then the same cleanup runs.
  const stopped = await new Promise<number>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.once(signal, () => resolve(0));
    process.once("uncaughtException", (error) => {
      process.stderr.write(`agent-office daemon stopped: ${error.name}: ${error.message}\n`);
      resolve(1);
    });
  });
  await handle.close();
  return stopped;
}
