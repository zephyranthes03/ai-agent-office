// Our plugin file for OpenCode: `plugins/` in its configuration folder. OpenCode 2 loads the files
// there by itself; opencode.json is not read or changed.
import type { ReporterInstaller } from "../install-common.ts";

export const opencodeReporter: ReporterInstaller = {
  agent: "opencode",
  configDir: (env, userHome) => `${env["XDG_CONFIG_HOME"] || `${userHome}/.config`}/opencode`,
  folder: "plugins",
  sources: ["reporter-runtime.js", "opencode/reporter.js"],
  afterInstall: "OpenCode loads it when its server next starts: restart the background server (opencode service restart) and any session started with --standalone.",
  minVersion: { command: "opencode", major: 2 },
};
