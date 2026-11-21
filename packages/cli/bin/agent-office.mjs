#!/usr/bin/env node
// agent-office <command>. Node's notice that node:sqlite is experimental is filtered out; every
// other warning still reaches stderr.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
