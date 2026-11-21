// `agent-office ui`: prints the address that opens the browser UI. Only a program that can read the
// token file may ask the daemon for a launch code, which is how the page proves it was opened by
// the daemon's owner; the code rides in the URL fragment (never sent to a server or logged) and is
// traded for a UI token once, within a minute.
import { deliverFresh, findDaemon, officeHome } from "./transport.ts";
import type { Daemon } from "./transport.ts";

const POST_MS = 3000;

export async function runUi(args: string[], out: { write: (text: string) => void; error: (text: string) => void } = { write: (text) => process.stdout.write(text), error: (text) => process.stderr.write(text) }): Promise<number> {
  if (args.length > 0) {
    out.error("usage: agent-office ui\n");
    return 2;
  }
  const home = officeHome();
  const daemon = findDaemon(home);
  if ("problem" in daemon) {
    out.error(`the daemon is not running (${daemon.problem}); start it with: agent-office daemon\n`);
    return 1;
  }
  const launch = await requestLaunchCode(home, daemon);
  if ("problem" in launch) {
    out.error(`${launch.problem}\n`);
    return 1;
  }
  const { code } = launch;
  out.write(`Open within a minute (the link works once):\nhttp://127.0.0.1:${daemon.port}/#launch=${code}\n`);
  return 0;
}

/** A fresh launch code from the daemon, after it proved it holds the token (the desktop app uses this too). */
export async function requestLaunchCode(home: string, daemon: Daemon): Promise<{ code: string } | { problem: string }> {
  const reply = await deliverFresh(home, daemon, "/v1/ui/launch", "{}", Date.now() + POST_MS);
  if (!("status" in reply) || reply.status !== 201) return { problem: `the daemon did not give a launch code (${"status" in reply ? `HTTP ${reply.status}` : reply.problem})` };
  let code: unknown;
  try {
    code = (JSON.parse(reply.body) as { code?: unknown }).code;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Left undefined: reported below.
  }
  if (typeof code !== "string" || !/^[0-9a-f]{64}$/.test(code)) return { problem: "the daemon's launch code could not be read" };
  return { code };
}
