// Our extension file for pi: `extensions/` in its agent folder, which pi loads by itself.
import type { ReporterInstaller } from "../install-common.ts";

export const piReporter: ReporterInstaller = {
  agent: "pi",
  configDir: (env, userHome) => env["PI_CODING_AGENT_DIR"] || `${userHome}/.pi/agent`,
  folder: "extensions",
  sources: ["reporter-runtime.js", "pi/reporter.js"],
  afterInstall: "pi loads it when a session next starts; sessions already running need a restart.",
};
