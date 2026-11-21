// Locates an installed package's bin script so scripts can run it with process.execPath,
// which works the same on Windows, macOS and Linux (no shell, no PATH lookup).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Absolute path of the first of `binNames` that the package `name` declares under the workspace's node_modules. */
export function packageBin(root, name, binNames) {
  const dir = join(root, "node_modules", name);
  if (!existsSync(join(dir, "package.json"))) throw new Error(`${name} is not installed: run npm install`);
  const { bin } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const names = Array.isArray(binNames) ? binNames : [binNames];
  const rel = typeof bin === "string" ? bin : names.map((binName) => bin?.[binName]).find(Boolean);
  if (!rel) throw new Error(`${name} declares no bin named ${names.join(" or ")}`);
  return join(dir, rel);
}
