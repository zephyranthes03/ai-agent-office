// Binding the daemon's listeners: the loopback API on its port or the next free one, and the
// read-only viewer on the address the owner gave, tried again until that address can be bound.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViewerAddress } from "./viewer.ts";

const PORT_TRIES = 10;

/**
 * Listens on `port`, else the next nine, else any free port: hooks read the real port from
 * daemon.json, so a squatted default range cannot keep the daemon from starting. `port` 0 asks
 * for any free port at once.
 */
export async function listen(server: Server, port: number): Promise<number> {
  const candidates = port === 0 ? [0] : [...Array.from({ length: PORT_TRIES }, (_, i) => port + i).filter((p) => p <= 65535), 0];
  for (const candidate of candidates) {
    // Each attempt removes both of its listeners, so failed attempts leave none behind.
    const result = await new Promise<number | NodeJS.ErrnoException>((resolve) => {
      const onListening = () => {
        server.off("error", onError);
        resolve((server.address() as AddressInfo).port);
      };
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        resolve(error);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidate, "127.0.0.1");
    });
    if (typeof result === "number") return result;
    if (result.code !== "EADDRINUSE" || candidate === 0) throw result;
  }
  throw new Error("no port to listen on");
}

/**
 * Binds the viewer's listener to its address. The address may not be up yet (a network that joins
 * later): a failed bind is logged and tried again after `retryMs`, and never stops the daemon.
 * Returns a function that cancels a retry still waiting.
 */
export function bindViewer(server: Server, address: ViewerAddress, retryMs: number, log: (line: string) => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const bind = () => {
    timer = null;
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      log(`viewer_bind_failed ${error.code ?? error.name}`);
      timer = setTimeout(bind, retryMs);
    };
    const onListening = () => {
      server.off("error", onError);
      // Errors after binding (out of descriptors while accepting) are logged; unheard they would stop the daemon.
      server.on("error", (error: NodeJS.ErrnoException) => log(`viewer_error ${error.code ?? error.name}`));
      log("viewer_listening");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address.port, address.host);
  };
  bind();
  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}
