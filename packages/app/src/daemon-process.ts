// The daemon inside the app: an Electron utility process (Node), started only when no daemon runs
// for this home. It reports its port once listening and stops cleanly when the app asks.
import { declaredServices, startDaemon } from "@agent-office/daemon";

// Files the daemon creates are private to this user, whatever the umask the app inherited.
if (process.platform !== "win32") process.umask(0o077);
// `--viewer <address>` from the app's own command line turns on the read-only viewer listener, and
// `--viewer-host <name>` names the HTTPS proxy in front of it (tailscale serve).
const value = (flag: string) => {
  const at = process.argv.indexOf(flag);
  return at < 0 ? undefined : process.argv[at + 1];
};
const viewer = value("--viewer");
const viewerHost = value("--viewer-host");
const handle = await startDaemon({ services: declaredServices(), ...(viewer === undefined ? {} : { viewer }), ...(viewer !== undefined && viewerHost !== undefined ? { viewerHost } : {}) });
process.parentPort.on("message", (message: { data: unknown }) => {
  if ((message.data as { type?: unknown } | null)?.type !== "stop") return;
  void handle.close().then(() => process.exit(0));
});
process.parentPort.postMessage({ type: "ready", port: handle.port, problem: handle.config.problem });
