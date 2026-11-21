// HTTP pieces shared by the loopback API (server.ts) and the read-only viewer listener (viewer.ts):
// fixed JSON replies, bounded request bodies, bounded server-sent event streams, and the built UI's
// files with the page's security headers.
import type { IncomingMessage, ServerResponse } from "node:http";
import { UI_CSP, uiFile } from "./ui-files.ts";

const BODY_MAX = 16 * 1024;
const STREAMS_MAX = 16;
const STREAM_BACKLOG_MAX = 1024 * 1024;
const HEARTBEAT_MS = 15_000;

/** One server-sent event: its name, and its data as one line of JSON. */
export const sseEvent = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

export function send(res: ServerResponse, status: number, body: object, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

export type Body = { value: unknown } | { status: 400 | 413; code: string };

/** The answer to a body that could not be read; a 413 also closes the connection, so the rest is never read. */
export function sendBodyError(res: ServerResponse, body: { status: 400 | 413; code: string }): void {
  send(res, body.status, { error: body.code }, body.status === 413 ? { connection: "close" } : {});
}

/** A path segment's text (a session id, which may hold an encoded slash), or a problem when it does not decode. */
export function decodeSegment(segment: string): { value: string } | { problem: "undecodable" } {
  try {
    return { value: decodeURIComponent(segment) };
  } catch (error) {
    if (error instanceof URIError) return { problem: "undecodable" };
    throw error;
  }
}

export function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > BODY_MAX) return resolve({ status: 413, code: "too_large" });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > BODY_MAX) {
        done = true;
        req.pause();
        return resolve({ status: 413, code: "too_large" });
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        resolve({ value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch (error) {
        if (error instanceof SyntaxError) resolve({ status: 400, code: "invalid_json" });
        else reject(error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Open server-sent event streams, each tagged (the viewer tags them with the device). At most
 * STREAMS_MAX at once; a client that stops reading is dropped rather than buffered without bound; a
 * comment every 15 s keeps idle connections open.
 */
export function createStreams<Tag>() {
  const open = new Map<ServerResponse, Tag>();
  const write = (res: ServerResponse, text: string) => {
    if (res.writableLength > STREAM_BACKLOG_MAX) {
      open.delete(res);
      res.destroy();
      return;
    }
    res.write(text);
  };
  const heartbeat = setInterval(() => {
    for (const res of open.keys()) write(res, ": ping\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return {
    /** Answers `req` with a stream that starts with `first`, or 503 when too many are open (in all, or with this tag when `perTag` is given). */
    open(req: IncomingMessage, res: ServerResponse, tag: Tag, first: string, perTag?: number): void {
      if (open.size >= STREAMS_MAX) return send(res, 503, { error: "too_many_streams" });
      if (perTag !== undefined && [...open.values()].filter((other) => other === tag).length >= perTag) return send(res, 503, { error: "too_many_streams" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "keep-alive" });
      open.set(res, tag);
      req.on("close", () => open.delete(res));
      write(res, first);
    },
    /** Sends to every stream; `text` may depend on the stream's tag. */
    send(text: string | ((tag: Tag) => string)): void {
      for (const [res, tag] of open) write(res, typeof text === "string" ? text : text(tag));
    },
    /** Ends the streams whose tag matches, or all. */
    close(which: (tag: Tag) => boolean = () => true): void {
      for (const [res, tag] of open)
        if (which(tag)) {
          open.delete(res);
          res.end();
        }
    },
    stop(): void {
      clearInterval(heartbeat);
    },
  };
}

/** A file of the built UI, with the page's security headers (also served by the viewer listener). */
export function serveUiFile(res: ServerResponse, root: string, path: string, method: string): void {
  if (method !== "GET" && method !== "HEAD") return send(res, 405, { error: "method_not_allowed" });
  const file = uiFile(root, path);
  if ("missing" in file) return send(res, 404, { error: file.missing });
  res.writeHead(200, {
    "content-type": file.type,
    "content-length": file.body.length,
    // Never a stale module after a rebuild: the files are local and small to send again.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": UI_CSP,
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    "x-frame-options": "DENY",
  });
  res.end(method === "HEAD" ? undefined : file.body);
}
