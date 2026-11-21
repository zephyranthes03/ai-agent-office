// `detail`: the short label of what a session is doing, derived inside the hook from the tool call
// so that the raw tool input never leaves the hook process. At most 64 characters, no control
// characters. Self-contained (no imports): the hook entry point and the capture tooling load it.

export const DETAIL_MAX = 64;

/**
 * `privacy.detail_level`, least to most revealing: nothing, the tool name, the tool's target
 * (program or file base name; the default), or the target plus the description the model wrote
 * for a shell command. The description is free text, so it is shown only when the user opts in.
 */
export const DETAIL_LEVELS = ["none", "tool", "target", "description"] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/** C0 and C1 controls, DEL, and the bidirectional overrides that can make text display out of order. */
const HIDDEN = (code: number): boolean => code <= 31 || (code >= 127 && code <= 159) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

/** At most 64 characters, with control and bidi-override characters removed; null stays null. */
export function clipDetail(value: string | null | undefined): string | null {
  if (value == null) return null;
  return Array.from(value)
    .filter((ch) => !HIDDEN(ch.codePointAt(0) ?? 0))
    .slice(0, DETAIL_MAX)
    .join("");
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Shell syntax that makes a whitespace split meaningless: quotes, substitutions, escapes. */
const SHELL_SYNTAX = /["'`$()\\]/;
const PROGRAM = /^[\w.+/-]+$/;
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? "";
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * First program of a shell command: skips leading NAME=value assignments (they can hold secrets)
 * and keeps only the executable's base name. Returns "" when the command does not split plainly
 * on whitespace before its program (a quoted or substituted assignment such as `KEY="a b" cmd`),
 * since any token taken from it could be part of a value.
 */
export function commandProgram(command: unknown): string {
  const tokens = String(command ?? "").trim().split(/\s+/).filter(Boolean);
  const index = tokens.findIndex((token) => !ENV_ASSIGNMENT.test(token));
  if (index < 0) return "";
  if (tokens.slice(0, index).some((token) => SHELL_SYNTAX.test(token))) return "";
  const program = tokens[index]!;
  return PROGRAM.test(program) ? baseName(program) : "";
}

const FILE_TOOLS = new Set(["Edit", "Write", "Read", "MultiEdit", "NotebookEdit", "apply_patch"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);
/**
 * Tools that hand work to another session (the adapter descriptors class them `delegation`; a test keeps
 * the two lists equal). Only for these does the envelope carry the input's `target` and `initiation`
 * enums (`tool_meta`). Kept here, like the other per-tool rules, so the hook stays light.
 */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set(["mcp__ccd_session__start_session"]);

/**
 * The per-tool rules: `Bash: <program>` (`Bash: <description>` instead when `description` is set
 * and the call has one); file tools with the file's base name; `Agent: <subagent type>`; anything
 * else (MCP tools included) the tool name only. Null when the hook input names no tool.
 */
export function deriveDetail(input: unknown, { description: withDescription = false }: { description?: boolean } = {}): string | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const tool = text(record["tool_name"]);
  if (tool === null) return null;
  const raw = record["tool_input"];
  const toolInput = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let detail = tool;
  if (tool === "Bash") {
    const description = withDescription ? text(toolInput["description"]) : null;
    const program = commandProgram(toolInput["command"]);
    detail = description !== null ? `Bash: ${description}` : program !== "" ? `Bash: ${program}` : "Bash";
  } else if (FILE_TOOLS.has(tool)) {
    const path = text(toolInput["file_path"]) ?? text(toolInput["notebook_path"]);
    if (path !== null) detail = `${tool}: ${baseName(path)}`;
  } else if (AGENT_TOOLS.has(tool)) {
    const type = text(toolInput["subagent_type"]);
    if (type !== null) detail = `${tool}: ${type}`;
  }
  return clipDetail(detail);
}
