// Server-sent events from the daemon's /v1/stream, parsed from text chunks. Pure, so the page and the
// desktop app's main process read the stream the same way.

/** Parses server-sent events from a byte stream; calls `event` per complete message. */
export function createSseParser(event: (name: string, data: string) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n?/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let name = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") name = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0) event(name, data.join("\n"));
    }
  };
}
