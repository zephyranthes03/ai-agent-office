// The browser UI's static files (packages/ui/dist, built by `npm run build:ui`). Only plain files
// inside that folder with a known type are served, after symbolic links are resolved; every
// response carries a Content-Security-Policy that allows this origin's own scripts and nothing
// inline, so text from a session can never run as code even if it reached the markup. The one
// Trusted Types policy (`agent-office-sw`) lets the viewer register its own service worker and
// nothing else; its notification sounds, its manifest and that worker come from this origin only.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "media-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  // No HTML sinks: any future innerHTML-style assignment fails instead of parsing markup; the one
  // policy only passes the service worker's own address (packages/ui/src/push.ts).
  "require-trusted-types-for 'script'",
  "trusted-types agent-office-sw",
].join("; ");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".webmanifest": "application/manifest+json",
};
const SAFE_PATH = /^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*(?:[A-Za-z0-9_-][A-Za-z0-9._-]*)?$/;
const FILE_MAX = 16 * 1024 * 1024;

export type UiFile = { type: string; body: Buffer } | { missing: "not_found" | "ui_not_built" };

export function uiFile(root: string, path: string): UiFile {
  // Segments may not start with a dot, which also rules out `..`.
  if (!SAFE_PATH.test(path)) return { missing: "not_found" };
  let base: string;
  try {
    base = realpathSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missing: "ui_not_built" };
    throw error;
  }
  const wanted = path.endsWith("/") ? `${path}index.html` : path;
  const type = TYPES[extname(wanted)];
  if (type === undefined) return { missing: "not_found" };
  let real: string;
  try {
    real = realpathSync(join(base, ...wanted.split("/").filter(Boolean)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { missing: "not_found" };
    throw error;
  }
  if (!real.startsWith(base + sep)) return { missing: "not_found" };
  const stat = statSync(real);
  if (!stat.isFile() || stat.size > FILE_MAX) return { missing: "not_found" };
  return { type, body: readFileSync(real) };
}
