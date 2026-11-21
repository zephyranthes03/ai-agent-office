// `agent-office pair` and `agent-office devices`: the owner's side of the read-only viewer (server
// mode). `pair` prints a single-use code and the address a phone or tablet opens; `devices` lists the
// paired devices and `devices revoke <id>` cuts one off at once. Both need the token file, like `ui`;
// the desktop app's tray menu uses the same requests.
import { deliverFresh, findDaemon, officeHome, query } from "./transport.ts";
import type { Daemon } from "./transport.ts";

const POST_MS = 3000;
type Out = { write: (text: string) => void; error: (text: string) => void };
const STD: Out = { write: (text) => process.stdout.write(text), error: (text) => process.stderr.write(text) };

export type Device = { id: string; name: string; created_at: string; last_seen_at: string | null };
/** `viewer_off`: the daemon runs without a viewer listener. */
type Failure = { problem: string } | { viewerOff: true };

function reply(result: { status: number; body: string } | { problem: string }): { status: number; value: unknown } | { problem: string } {
  if ("problem" in result) return result;
  try {
    return { status: result.status, value: JSON.parse(result.body) as unknown };
  } catch (error) {
    if (error instanceof SyntaxError) return { problem: `unreadable reply (HTTP ${result.status})` };
    throw error;
  }
}

export async function requestPairCode(home: string, daemon: Daemon): Promise<{ code: string; url: string; expiresInS: number } | Failure> {
  const result = reply(await deliverFresh(home, daemon, "/v1/viewer/pair-code", "{}", Date.now() + POST_MS));
  if ("problem" in result) return result;
  if (result.status === 409) return { viewerOff: true };
  const value = result.value as { code?: unknown; url?: unknown; expires_in_s?: unknown };
  if (result.status !== 201 || typeof value.code !== "string" || typeof value.url !== "string" || typeof value.expires_in_s !== "number") return { problem: `HTTP ${result.status}` };
  return { code: value.code, url: value.url, expiresInS: value.expires_in_s };
}

export async function listDevices(daemon: Daemon): Promise<Device[] | Failure> {
  const result = reply(await query(daemon, "/v1/viewer/devices", Date.now() + POST_MS));
  if ("problem" in result) return result;
  if (result.status === 409) return { viewerOff: true };
  if (result.status !== 200) return { problem: `HTTP ${result.status}` };
  return (result.value as { devices: Device[] }).devices;
}

/** True when the device existed and is now cut off. */
export async function revokeDevice(home: string, daemon: Daemon, id: string): Promise<boolean | Failure> {
  const result = reply(await deliverFresh(home, daemon, `/v1/viewer/devices/${id}/revoke`, "{}", Date.now() + POST_MS));
  if ("problem" in result) return result;
  if (result.status === 409) return { viewerOff: true };
  if (result.status === 404) return false;
  if (result.status !== 200) return { problem: `HTTP ${result.status}` };
  return true;
}

/** The code as people read it: two groups of four. */
export const spacedCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

const VIEWER_OFF = "the daemon runs without a viewer; start it with: agent-office daemon --viewer <this computer's Wi-Fi address>\n";

function running(out: Out): { home: string; daemon: Daemon } | null {
  const home = officeHome();
  const daemon = findDaemon(home);
  if (!("problem" in daemon)) return { home, daemon };
  out.error(`the daemon is not running (${daemon.problem})\n`);
  return null;
}

function failed(out: Out, failure: Failure): number {
  out.error("viewerOff" in failure ? VIEWER_OFF : `${failure.problem}\n`);
  return 1;
}

export async function runPair(args: string[], out: Out = STD): Promise<number> {
  if (args.length > 0) {
    out.error("usage: agent-office pair\n");
    return 2;
  }
  const found = running(out);
  if (found === null) return 1;
  const pair = await requestPairCode(found.home, found.daemon);
  if (!("code" in pair)) return failed(out, pair);
  out.write(`On the phone or tablet, open ${pair.url}\nand enter this code within ${Math.round(pair.expiresInS / 60)} minutes (it works once): ${spacedCode(pair.code)}\n`);
  return 0;
}

export async function runDevices(args: string[], out: Out = STD): Promise<number> {
  const revoke = args[0] === "revoke";
  if (!(args.length === 0 || (revoke && args.length === 2 && /^[0-9a-f]{8}$/.test(args[1]!)))) {
    out.error("usage: agent-office devices [revoke <id>]\n");
    return 2;
  }
  const found = running(out);
  if (found === null) return 1;
  if (revoke) {
    const done = await revokeDevice(found.home, found.daemon, args[1]!);
    if (typeof done !== "boolean") return failed(out, done);
    if (!done) {
      out.error(`no device ${args[1]}\n`);
      return 1;
    }
    out.write(`revoked ${args[1]}; its screens are disconnected\n`);
    return 0;
  }
  const devices = await listDevices(found.daemon);
  if (!Array.isArray(devices)) return failed(out, devices);
  if (devices.length === 0) out.write("no paired devices\n");
  const when = (iso: string | null) => (iso === null ? "never" : iso.slice(0, 16).replace("T", " "));
  for (const device of devices) out.write(`${device.id}  ${device.name}  paired ${when(device.created_at)}  last seen ${when(device.last_seen_at)}\n`);
  return 0;
}
