#!/usr/bin/env node
// Builds the browser UI into packages/ui/dist (`npm run build:ui`): tsc emits the modules, then the
// page, the stylesheet and the art folder packages/ui/art-preview are copied next to them. The daemon
// serves that folder.
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { packageBin } from "./bin.mjs";

const root = join(import.meta.dirname, "..");
const ui = join(root, "packages", "ui");
const dist = join(ui, "dist");
rmSync(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, [packageBin(root, "typescript", "tsc"), "-p", join(ui, "tsconfig.build.json"), "--pretty", "false"], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
cpSync(join(ui, "static"), dist, { recursive: true });
// Register at the root so the worker's default scope includes the viewer page.
writeFileSync(join(dist, "sw.js"), 'import "./ui/src/sw.js";\n');
const art = join(ui, "art-preview");
// The maintainers' preview art is private, so a public copy has no art folder until its owner adds
// one; without it the office is drawn as plain shapes.
if (existsSync(art)) cpSync(art, join(dist, "art"), { recursive: true });
console.log(`build:ui ok (${dist})`);
