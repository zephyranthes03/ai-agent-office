// Agent descriptors, their pure hook → signal mappings, and the installer's pure edits of their hook settings.
import { claudeCodeDescriptor, claudeCodeMapper } from "./claude-code/map.ts";
import { codexDescriptor, codexMapper } from "./codex/map.ts";
import { opencodeDescriptor, opencodeMapper } from "./opencode/map.ts";
import { piDescriptor, piMapper } from "./pi/map.ts";
import { claudeCodeInstaller } from "./claude-code/install.ts";
import { codexInstaller } from "./codex/install.ts";
import { opencodeReporter } from "./opencode/install.ts";
import { piReporter } from "./pi/install.ts";
import hermesDescriptor from "./hermes/descriptor.json" with { type: "json" };
import openclawDescriptor from "./openclaw/descriptor.json" with { type: "json" };
import type { Mapper } from "./hook-common.ts";
import type { Installer, ReporterInstaller } from "./install-common.ts";

export type { HookEvent, Mapper, MappingDescriptor } from "./hook-common.ts";
export { createMapper, mapCommon, originFromMeta, returnedFromMeta, routeOf, toolClassOf } from "./hook-common.ts";
export type { HookEdit, HookEntry, Installer, ReporterInstaller } from "./install-common.ts";
export type { ClaudeUsageRecord } from "./claude-code/session-log.ts";
export { parseTranscriptUsage } from "./claude-code/session-log.ts";
export type { TranscriptMeta } from "./claude-code/transcript-meta.ts";
export { TRANSCRIPT_META_KEYS, transcriptMeta } from "./claude-code/transcript-meta.ts";
export { INTERRUPT_MARKERS, interruptedAt } from "./claude-code/interrupt.ts";
export { transcriptTitle } from "./claude-code/title.ts";
export type { CodexCursor, CodexLimitRecord, CodexLimitWindow, CodexLog, CodexSample, CodexTokenRecord, CodexTotals } from "./codex/session-log.ts";
export { codexSamples, parseRollout } from "./codex/session-log.ts";
export type { CodexTurnMeta } from "./codex/turn-meta.ts";
export { CODEX_TURN_META_KEYS, codexTurnMeta } from "./codex/turn-meta.ts";
export { CODEX_AUTO_REVIEWER } from "./codex/map.ts";
export { addHooks, composeReporter, isOurHandler, isOurReporter, removeHooks, REPORTER_FILE } from "./install-common.ts";
export { claudeCodeDescriptor, claudeCodeMapper, codexDescriptor, codexMapper, opencodeMapper, piMapper };

export const descriptors = { "claude-code": claudeCodeDescriptor, codex: codexDescriptor, opencode: opencodeDescriptor, pi: piDescriptor } as const;

/** The descriptors that may declare a background service, whether or not the agent has hook monitoring yet. */
export const serviceDescriptors = { codex: codexDescriptor, openclaw: openclawDescriptor, hermes: hermesDescriptor, opencode: opencodeDescriptor } as const;

const mappers: Record<string, Mapper> = { "claude-code": claudeCodeMapper, codex: codexMapper, opencode: opencodeMapper, pi: piMapper };

/** The mapper for an agent id, or undefined when no adapter exists for it. */
export function mapperFor(agent: string): Mapper | undefined {
  return Object.hasOwn(mappers, agent) ? mappers[agent] : undefined;
}

const installers: Record<string, Installer> = { "claude-code": claudeCodeInstaller, codex: codexInstaller };

/** How to add our hooks to an agent's settings, or undefined when no adapter exists for it. */
export function installerFor(agent: string): Installer | undefined {
  return Object.hasOwn(installers, agent) ? installers[agent] : undefined;
}

const reporters: Record<string, ReporterInstaller> = { opencode: opencodeReporter, pi: piReporter };

/** How to place our reporter file in an agent's plugin folder, for the agents that take one instead of hook settings. */
export function reporterInstallerFor(agent: string): ReporterInstaller | undefined {
  return Object.hasOwn(reporters, agent) ? reporters[agent] : undefined;
}
