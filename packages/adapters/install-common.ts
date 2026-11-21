// Adding and removing our hook entries in an agent's hook settings. Claude Code's settings.json and
// Codex's hooks.json share the shape { hooks: { <Event>: [ { matcher?, hooks: [handler, ...] } ] } }.
// Pure: parsed JSON in, new JSON out. Nothing that is not ours is changed, reordered or removed;
// ours are recognised by the program their command runs (a base name of agent-office-hook).

/** One handler for one event: what the installer adds, or what it found and removes. */
export type HookEntry = { event: string; handler: Record<string, unknown> };

export type HookEdit = { next: Record<string, unknown>; added: HookEntry[]; removed: HookEntry[] } | { problem: string };

const OUR_PROGRAM = /^agent-office-hook(?:\.exe)?$/i;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? "";

/** The program part of a shell command string: its first token, without the quotes around it. */
function programOf(command: string): string {
  const trimmed = command.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end < 0 ? "" : trimmed.slice(1, end);
  }
  return trimmed.split(/\s/)[0] ?? "";
}

/**
 * Whether a hook handler runs our hook program (`…/agent-office-hook`, `.exe` on Windows). In exec
 * form (an `args` list) `command` is the program itself, spaces included; otherwise it is a
 * command string whose first token, quoted or not, is the program.
 */
export function isOurHandler(handler: unknown): boolean {
  if (!isObject(handler) || typeof handler["command"] !== "string") return false;
  const command = handler["command"];
  return OUR_PROGRAM.test(baseName(Array.isArray(handler["args"]) ? command.trim() : programOf(command)));
}

/** The settings' `hooks` object and its event arrays, or a problem when their shape is not the documented one. */
function hooksOf(settings: unknown): { settings: Json; hooks: Json } | { problem: string } {
  if (!isObject(settings)) return { problem: "the file does not hold a JSON object" };
  const hooks = settings["hooks"] ?? {};
  if (!isObject(hooks)) return { problem: "its `hooks` value is not an object" };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return { problem: `its \`hooks.${event}\` value is not a list` };
  }
  return { settings, hooks };
}

/** Our handlers in one event's groups, as they are. */
function oursIn(groups: unknown[]): Json[] {
  return groups.flatMap((group) => (isObject(group) && Array.isArray(group["hooks"]) ? (group["hooks"] as unknown[]).filter(isOurHandler) : [])) as Json[];
}

/** Drops our handlers from one event's groups; a group left empty by that is dropped too, any other group stays as it is. */
function withoutOurs(groups: unknown[]): unknown[] {
  return groups.flatMap((group) => {
    if (!isObject(group) || !Array.isArray(group["hooks"])) return [group];
    const handlers = group["hooks"] as unknown[];
    const kept = handlers.filter((handler) => !isOurHandler(handler));
    if (kept.length === handlers.length) return [group];
    return kept.length === 0 ? [] : [{ ...group, hooks: kept }];
  });
}

/** JSON text with object keys sorted, so two handlers compare equal whatever order their keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * The event lists after an edit, keeping their order; built from entries so that an event named
 * like an Object.prototype property (`__proto__`) stays an ordinary key.
 */
const fromEvents = (events: [string, unknown[]][]): Json => Object.fromEntries(events);

/**
 * Adds one matcher-less group holding `handler` to each event's list, after the groups already
 * there. An event that already has exactly that handler of ours is left alone (installing twice
 * changes nothing); a different handler of ours (an older install) is replaced, and handlers of
 * ours in events no longer subscribed are removed.
 */
export function addHooks(settings: unknown, wanted: HookEntry[]): HookEdit {
  const found = hooksOf(settings);
  if ("problem" in found) return found;
  const wantedByEvent = new Map(wanted.map((entry) => [entry.event, entry.handler]));
  const events = Object.entries(found.hooks) as [string, unknown[]][];
  for (const { event } of wanted) if (!Object.hasOwn(found.hooks, event)) events.push([event, []]);
  const added: HookEntry[] = [];
  const removed: HookEntry[] = [];
  const next = events.flatMap(([event, groups]): [string, unknown[]][] => {
    const ours = oursIn(groups);
    const handler = wantedByEvent.get(event);
    if (handler === undefined) {
      if (ours.length === 0) return [[event, groups]];
      for (const old of ours) removed.push({ event, handler: old });
      const kept = withoutOurs(groups);
      return kept.length > 0 ? [[event, kept]] : [];
    }
    if (ours.length === 1 && canonical(ours[0]) === canonical(handler)) return [[event, groups]];
    for (const old of ours) removed.push({ event, handler: old });
    added.push({ event, handler });
    return [[event, [...withoutOurs(groups), { hooks: [handler] }]]];
  });
  // Reported in the order the adapter lists its events, whatever order the file has them in.
  const order = [...wantedByEvent.keys()];
  added.sort((a, b) => order.indexOf(a.event) - order.indexOf(b.event));
  if (added.length + removed.length === 0) return { next: found.settings, added, removed };
  return { next: { ...found.settings, hooks: fromEvents(next) }, added, removed };
}

/**
 * Removes every handler of ours. A group or an event list left empty by that is removed, and so
 * is the `hooks` object when nothing is left in it; everything else stays as it is.
 */
export function removeHooks(settings: unknown): HookEdit {
  const found = hooksOf(settings);
  if ("problem" in found) return found;
  const removed: HookEntry[] = [];
  const next = (Object.entries(found.hooks) as [string, unknown[]][]).flatMap(([event, groups]): [string, unknown[]][] => {
    const ours = oursIn(groups);
    if (ours.length === 0) return [[event, groups]];
    for (const handler of ours) removed.push({ event, handler });
    const kept = withoutOurs(groups);
    return kept.length > 0 ? [[event, kept]] : [];
  });
  if (removed.length === 0) return { next: found.settings, added: [], removed };
  const result: Json = { ...found.settings, hooks: fromEvents(next) };
  if (next.length === 0) delete result["hooks"];
  return { next: result, added: [], removed };
}

/** Where an agent keeps its hook settings and what our handler for each event is. */
export type Installer = {
  agent: string;
  /** The agent's settings folder: `configDirEnv` when set, else `defaultConfigDir` under the user's home. */
  configDirEnv: string;
  defaultConfigDir: string;
  /** The file in that folder that holds the hooks. */
  hooksFile: string;
  /** What to tell the user after installing. */
  afterInstall: string;
  /** Why this launcher path cannot be written into the agent's settings, or null. */
  launcherProblem: (launcher: string) => string | null;
  entries: (launcher: string) => HookEntry[];
};

/** An agent that reads plugin files from a folder: one file of ours goes there and no settings file is edited. */
export type ReporterInstaller = {
  agent: string;
  /** The agent's own folder; a missing one means the agent is not set up on this machine. */
  configDir: (env: Record<string, string | undefined>, userHome: string) => string;
  /** The folder inside it that the agent loads plugin files from. */
  folder: string;
  /** The shared runtime, then the agent's part, relative to this package. */
  sources: readonly [string, string];
  /** What to tell the user after installing. */
  afterInstall: string;
  /** The oldest major version whose plugin shape the file fits, and the command that tells the installed one. */
  minVersion?: { command: string; major: number };
};

export const REPORTER_FILE = "agent-office.js";
const REPORTER_MARKER = "// agent-office reporter, written by `agent-office install-hooks`; `agent-office uninstall-hooks` removes it.";
const LAUNCHER_PLACEHOLDER = '"__AGENT_OFFICE_LAUNCHER__"';
const RUNTIME_IMPORT = 'import { createReporter } from "../reporter-runtime.js";\n';

/** Whether a file at the reporter's path is one we wrote: only those are replaced or removed. */
export const isOurReporter = (text: string): boolean => text.startsWith(`${REPORTER_MARKER}\n`);

/**
 * The file the agent loads: the runtime and the agent's part as one module with no import of ours,
 * so that it still loads, and does nothing, when the office is gone. A source without its
 * placeholder or import is a defect of this repository, not of the machine.
 */
export function composeReporter(runtime: string, part: string, launcher: string): string {
  if (!runtime.includes(LAUNCHER_PLACEHOLDER) || !part.includes(RUNTIME_IMPORT)) throw new Error("reporter sources do not have the expected form");
  const body = runtime.replace(LAUNCHER_PLACEHOLDER, () => JSON.stringify(launcher)).replace(/^export function createReporter/m, "function createReporter");
  return `${REPORTER_MARKER}\n${body}\n${part.replace(RUNTIME_IMPORT, "")}`;
}
