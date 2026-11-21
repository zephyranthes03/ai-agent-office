// `agent-office doctor`: is everything in place on this machine? Read-only: the office folder and its
// privacy, the daemon (and its proof of the token), each agent's hooks and the launcher they run,
// what waits in the spool, and recent hook errors. `--drift` also parses the user's own agent logs
// with the same strategies and reports how much still parses and which keys are new: counts and key
// names, never content. Exit code 1 when something is broken, 0 otherwise (warnings included).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseRollout, parseTranscriptUsage, transcriptMeta } from "@agent-office/adapters";
import { claudeTranscripts, codexRollouts, FALLBACK_MARKER, launcherPath, launcherTargets, MISSING_MARKER, pathsFor, privacyProblems, readTail } from "@agent-office/daemon";
import type { FoundFile } from "@agent-office/daemon";
import { hookStatus } from "./install.ts";
import type { InstallContext } from "./install.ts";
import { findDaemon, query } from "./transport.ts";
import type { Reply } from "./transport.ts";

export type DoctorContext = Pick<InstallContext, "env" | "userHome" | "officeHome" | "nodeVersion" | "platform" | "out" | "now">;
type Status = "ok" | "warn" | "FAIL" | "info";
type Check = { status: Status; name: string; detail: string };

const AGENTS = ["claude-code", "codex", "opencode", "pi"] as const;
const DAY_MS = 86_400_000;
const DRIFT_TAIL = 1024 * 1024;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const linesOf = (file: string): string[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

function nodeTooOld(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major < 22 || (major === 22 && minor < 18);
}

async function setupChecks(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const paths = pathsFor(ctx.officeHome);
  checks.push(nodeTooOld(ctx.nodeVersion) ? { status: "FAIL", name: "node", detail: `Node ${ctx.nodeVersion}; the hook program and daemon need 22.18 or later` } : { status: "ok", name: "node", detail: `Node ${ctx.nodeVersion}` });

  if (!existsSync(paths.home)) checks.push({ status: "warn", name: "office", detail: `${paths.home} does not exist yet; the daemon creates it on first start` });
  else {
    const problems = privacyProblems(paths, ctx.platform);
    checks.push(...(problems.length > 0 ? problems.map((problem) => ({ status: "FAIL" as const, name: "office", detail: problem })) : [{ status: "ok" as const, name: "office", detail: `${paths.home} is private` }]));
  }

  const daemon = findDaemon(paths.home);
  let sessions: { agent: string; ts: string }[] = [];
  if ("problem" in daemon) {
    checks.push({ status: "warn", name: "daemon", detail: daemon.problem === "daemon_down" ? "not running (agent-office daemon); hooks spool until it starts" : `not reachable (${daemon.problem})` });
  } else {
    const health = await query(daemon, "/v1/health", Date.now() + 2000);
    const body = replyJson(health) as { pid?: unknown; config?: unknown } | null | undefined;
    if ("problem" in health) checks.push({ status: health.problem === "daemon_unverified" ? "FAIL" : "warn", name: "daemon", detail: health.problem === "daemon_unverified" ? `the process on port ${daemon.port} did not prove it is the daemon` : `no answer on port ${daemon.port} (${health.problem})` });
    else if (health.status !== 200) checks.push({ status: "FAIL", name: "daemon", detail: `the daemon on port ${daemon.port} answered its health check with HTTP ${health.status}` });
    else if (typeof body?.pid !== "number") checks.push({ status: "warn", name: "daemon", detail: `the daemon on port ${daemon.port} proved itself, but its health reply could not be read` });
    else {
      checks.push({ status: body.config === "ok" ? "ok" : "warn", name: "daemon", detail: `listening on 127.0.0.1:${daemon.port}, pid ${body.pid}${body.config === "ok" ? "" : ", config.json could not be used (defaults)"}` });
      const reply = await query(daemon, "/v1/sessions", Date.now() + 2000);
      const list = (replyJson(reply) as { sessions?: unknown } | null | undefined)?.sessions;
      if (Array.isArray(list)) sessions = list as { agent: string; ts: string }[];
      else checks.push({ status: "warn", name: "daemon", detail: `could not read the session list (${"problem" in reply ? reply.problem : reply.status === 200 ? "unreadable reply" : `HTTP ${reply.status}`}); last events are not shown` });
    }
  }

  const launcher = launcherPath(paths);
  let anyInstalled = false;
  for (const agent of AGENTS) {
    const status = hookStatus(agent, ctx);
    if ("problem" in status) {
      // No config folder: the agent is not used here. Anything else: the agent cannot read our hooks either.
      checks.push({ status: status.absent ? "info" : "FAIL", name: agent, detail: status.problem });
      continue;
    }
    if (status.installed > 0) anyInstalled = true;
    const newest = sessions.filter((s) => s.agent === agent).map((s) => s.ts).sort().at(-1);
    const seen = newest === undefined ? "" : `; last event ${Math.max(0, Math.round((ctx.now() - Date.parse(newest)) / 60_000))} min ago`;
    if (status.installed === 0) checks.push({ status: "warn", name: agent, detail: `no hooks in ${status.path} (agent-office install-hooks ${agent})` });
    else if (status.installed < status.expected) checks.push({ status: "warn", name: agent, detail: `hooks for ${status.installed} of ${status.expected} events in ${status.path}; run install-hooks ${agent} again${seen}` });
    else checks.push({ status: "ok", name: agent, detail: `hooks installed in ${status.path}${agent === "codex" ? " (Codex runs them once trusted with /hooks)" : ""}${seen}` });
  }

  if (existsSync(launcher)) {
    const { node, entry } = launcherTargets(readFileSync(launcher, "utf8"));
    const missing = [node, entry].filter((path): path is string => path !== null && !existsSync(path));
    const marker = join(paths.logs, MISSING_MARKER);
    const fallback = join(paths.logs, FALLBACK_MARKER);
    if (node === null || entry === null) checks.push({ status: "warn", name: "launcher", detail: `${launcher} is not one this installer wrote` });
    else if (missing.length > 0) checks.push({ status: "FAIL", name: "launcher", detail: `${launcher} runs ${missing.join(" and ")}, which no longer exist${missing.includes(node) ? " (a Node upgrade?)" : ""}; run install-hooks again` });
    else checks.push({ status: "ok", name: "launcher", detail: `${launcher} runs ${node} ${entry}` });
    if (existsSync(marker)) checks.push({ status: missing.length > 0 ? "FAIL" : "warn", name: "launcher", detail: `hooks found the launcher's target missing, last at ${statSync(marker).mtime.toISOString()}${missing.length > 0 ? "" : " (fixed since?)"}` });
    // The fallback kept the hooks going, but a Node from the agent's PATH is nothing to rely on.
    if (existsSync(fallback)) checks.push({ status: "warn", name: "launcher", detail: `hooks ran with a Node from the agent's PATH, last at ${statSync(fallback).mtime.toISOString()}; run install-hooks again to fix the Node${missing.length > 0 ? "" : " (done since?)"}` });
  } else if (anyInstalled) checks.push({ status: "FAIL", name: "launcher", detail: `${launcher} is missing but hooks point at it; run install-hooks again` });

  const spooled = existsSync(paths.spool) ? readdirSync(paths.spool).filter((name) => name.includes(".jsonl")).reduce((sum, name) => sum + linesOf(join(paths.spool, name)).length, 0) : 0;
  if (spooled > 0) checks.push({ status: "info", name: "spool", detail: `${spooled} event(s) wait for the daemon in ${paths.spool}` });

  const since = new Date(ctx.now() - DAY_MS).toISOString();
  const errors = new Map<string, number>();
  for (const line of linesOf(join(paths.logs, "hook.log"))) {
    const [at = "", code = "unknown"] = line.split(" ");
    if (at >= since) errors.set(code, (errors.get(code) ?? 0) + 1);
  }
  if (errors.size > 0) checks.push({ status: "warn", name: "hook log", detail: `in the last day: ${[...errors].map(([code, n]) => `${code} ×${n}`).join(", ")}` });
  return checks;
}

/** Keys of an object that a known set does not have; names only, and only identifier-like ones. */
function unknownKeys(value: unknown, known: readonly string[], into: Set<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) if (!known.includes(key) && IDENTIFIER.test(key)) into.add(key);
}

// The keys documented when the strategies were written (usage-and-cost.md, the 2026-10-19 local
// verification). Others are listed for a person to look at; they do not make the check fail.
const CODEX_USAGE_KEYS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
const CODEX_LIMIT_KEYS = ["limit_id", "limit_name", "primary", "secondary", "credits", "plan_type", "rate_limit_reached_type", "spend_control_reached", "individual_limit"];
const CLAUDE_USAGE_KEYS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];

/** The JSON body of a 200 reply; undefined for any other reply or a body that is not JSON (callers report it). */
function replyJson(reply: Reply): unknown {
  if ("problem" in reply || reply.status !== 200) return undefined;
  return lineValue(reply.body);
}

/** A line as JSON, or undefined when it is not (the parsers count those lines). */
function lineValue(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Already counted as unreadable by the strategy's parser.
  }
  return undefined;
}

/** The newest `max` of the files modified since `sinceMs`. */
const newest = (files: FoundFile[], sinceMs: number, max: number): string[] =>
  files
    .filter(({ mtimeMs }) => mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, max)
    .map(({ file }) => file);

/**
 * The tails of the files, and the error codes of those that could not be read (gone since the
 * listing, not a regular file, no permission): one bad file does not stop the check.
 */
function tails(files: string[]): { texts: string[]; unreadable: Map<string, number> } {
  const texts: string[] = [];
  const unreadable = new Map<string, number>();
  for (const file of files) {
    try {
      texts.push(readTail(file, DRIFT_TAIL).text);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined) throw error;
      unreadable.set(code, (unreadable.get(code) ?? 0) + 1);
    }
  }
  return { texts, unreadable };
}

const counted = (counts: Map<string, number>, what: string): string => (counts.size === 0 ? "" : `; ${[...counts.values()].reduce((a, b) => a + b, 0)} ${what} (${[...counts].map(([code, n]) => `${code} ×${n}`).join(", ")})`);
const unreadableFiles = (unreadable: Map<string, number>): string => counted(unreadable, "file(s) could not be read");

/** Counts the folders a walk could not list, by error code; the walk goes on without them. */
function listing(): { unlisted: (code: string) => void; folders: Map<string, number>; note: () => string } {
  const folders = new Map<string, number>();
  return { unlisted: (code) => folders.set(code, (folders.get(code) ?? 0) + 1), folders, note: () => counted(folders, "folder(s) could not be listed") };
}

/** The strategies run over the user's own recent logs: what still parses, and which keys are new. */
function driftChecks(ctx: DoctorContext): Check[] {
  const checks: Check[] = [];
  const claude = ctx.env["CLAUDE_CONFIG_DIR"] || join(ctx.userHome, ".claude");
  const codex = ctx.env["CODEX_HOME"] || join(ctx.userHome, ".codex");

  const codexListing = listing();
  const rollouts = newest(codexRollouts(codex, codexListing.unlisted), ctx.now() - 7 * DAY_MS, 50);
  if (rollouts.length === 0) checks.push({ status: codexListing.folders.size > 0 ? "warn" : "info", name: "codex logs", detail: `no rollout in the last 7 days${codexListing.note()}` });
  else {
    let tokens = 0;
    let limits = 0;
    let bad = 0;
    let lines = 0;
    const unknown = new Set<string>();
    const { texts, unreadable } = tails(rollouts);
    for (const text of texts) {
      const log = parseRollout(text);
      tokens += log.tokens.length;
      limits += log.limits.length;
      bad += log.badLines;
      for (const line of text.split("\n")) {
        if (!line.includes('"token_count"')) continue;
        lines++;
        const value = lineValue(line) as { payload?: { info?: { total_token_usage?: unknown }; rate_limits?: unknown } } | undefined;
        unknownKeys(value?.payload?.info?.total_token_usage, CODEX_USAGE_KEYS, unknown);
        unknownKeys(value?.payload?.rate_limits, CODEX_LIMIT_KEYS, unknown);
      }
    }
    const status: Status = lines > 0 && tokens + limits === 0 ? "FAIL" : bad > 0 || unreadable.size > 0 || codexListing.folders.size > 0 ? "warn" : "ok";
    checks.push({ status, name: "codex logs", detail: `${rollouts.length} rollout(s): ${lines} token_count line(s), ${tokens} usage and ${limits} limit record(s) read, ${bad} unreadable line(s)${unreadableFiles(unreadable)}${codexListing.note()}${unknown.size > 0 ? `; other keys: ${[...unknown].slice(0, 10).join(", ")}` : ""}` });
  }

  const claudeListing = listing();
  const transcripts = newest(claudeTranscripts(claude, undefined, claudeListing.unlisted), ctx.now() - 7 * DAY_MS, 20);
  if (transcripts.length === 0) checks.push({ status: claudeListing.folders.size > 0 ? "warn" : "info", name: "claude logs", detail: `no transcript in the last 7 days${claudeListing.note()}` });
  else {
    let records = 0;
    let bad = 0;
    let candidates = 0;
    let withOrigin = 0;
    const unknown = new Set<string>();
    const { texts, unreadable } = tails(transcripts);
    for (const text of texts) {
      const usage = parseTranscriptUsage(text);
      records += usage.records.length;
      bad += usage.badLines;
      if (transcriptMeta(text)?.turnOrigin !== undefined) withOrigin++;
      for (const line of text.split("\n")) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
        candidates++;
        const value = lineValue(line) as { message?: { usage?: unknown } } | undefined;
        unknownKeys(value?.message?.usage, CLAUDE_USAGE_KEYS, unknown);
      }
    }
    const status: Status = candidates > 0 && records === 0 ? "FAIL" : bad > 0 || unreadable.size > 0 || claudeListing.folders.size > 0 ? "warn" : "ok";
    checks.push({ status, name: "claude logs", detail: `${transcripts.length} transcript(s): ${records} usage record(s) from ${candidates} line(s), ${bad} unreadable; ${withOrigin} with a turn origin${unreadableFiles(unreadable)}${claudeListing.note()}${unknown.size > 0 ? `; other usage keys: ${[...unknown].slice(0, 10).join(", ")}` : ""}` });
  }
  return checks;
}

export async function runDoctor(args: string[], ctx: DoctorContext): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--drift");
  if (unknown.length > 0) {
    ctx.out(`unexpected argument ${JSON.stringify(unknown[0])}\nusage: agent-office doctor [--drift]\n`);
    return 2;
  }
  const checks = [...(await setupChecks(ctx)), ...(args.includes("--drift") ? driftChecks(ctx) : [])];
  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) ctx.out(`${check.status.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}\n`);
  return checks.some((check) => check.status === "FAIL") ? 1 : 0;
}
