#!/usr/bin/env node
// Before `npm run app` on macOS: the Electron.app that npm installs may carry only a linker ad-hoc
// signature with no sealed bundle, and macOS then refuses its notifications without asking. Each
// install that puts the binary back undoes an earlier fix, so this checks the
// bundle and re-seals it with an ad-hoc signature when the check fails. Elsewhere it does nothing.
// `node tools/seal-electron.mjs [<path to Electron.app>]`; the default is the installed one.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

if (process.platform !== "darwin") process.exit(0);
// The electron package's main export is the path of the binary inside the bundle (Electron.app/Contents/MacOS/Electron).
const bundle = process.argv[2] === undefined ? resolve(dirname(createRequire(import.meta.url)("electron")), "..", "..") : resolve(process.argv[2]);

const codesign = (args) => {
  const result = spawnSync("codesign", [...args, bundle], { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
};

const check = codesign(["--verify", "--deep", "--strict"]);
if (check.status === 0) process.exit(0);
console.log(`seal-electron: ${bundle} is not sealed (${check.stderr.trim().split("\n")[0]}); signing it ad hoc so macOS lets it notify`);
const sign = codesign(["--force", "--deep", "--sign", "-"]);
if (sign.status !== 0) {
  console.error(`seal-electron: codesign failed: ${sign.stderr.trim()}`);
  process.exit(sign.status ?? 1);
}
const again = codesign(["--verify", "--deep", "--strict"]);
if (again.status !== 0) {
  console.error(`seal-electron: still not sealed after signing: ${again.stderr.trim()}`);
  process.exit(again.status ?? 1);
}
console.log("seal-electron: sealed");
