// Our hook entries in Claude Code's user settings (~/.claude/settings.json, or CLAUDE_CONFIG_DIR):
// exec form (command + args, no shell), so the hook's parent process is Claude Code itself;
// asynchronous, so Claude Code never waits for it; one matcher-less group per subscribed event.
import descriptor from "./descriptor.json" with { type: "json" };
import type { Installer } from "../install-common.ts";

export const claudeCodeInstaller: Installer = {
  agent: "claude-code",
  configDirEnv: "CLAUDE_CONFIG_DIR",
  defaultConfigDir: ".claude",
  hooksFile: "settings.json",
  afterInstall: "Claude Code reads the new hooks when a session starts; sessions already running keep their old settings.",
  launcherProblem: () => null,
  entries: (launcher) =>
    descriptor.hook_events.map((event) => ({ event, handler: { type: "command", command: launcher, args: ["claude-code"], timeout: 5, async: true } })),
};
