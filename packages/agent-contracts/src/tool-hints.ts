/**
 * Friendly, secret-safe tool activity copy shared by chat channels.
 *
 * `toolHintFor()` preserves the original one-line hint behavior used by
 * streaming channels. `formatToolActivityLine()` is the richer final-only
 * status used by Slack and Telegram: it includes a bounded preview from a small
 * allowlist of scalar argument fields, but never serializes arbitrary tool
 * input or invokes getters/proxies.
 */

import { homedir } from "node:os";
import { types as nodeUtilTypes } from "node:util";

import type { AgentStreamEvent } from "./index.js";

/** The routing variant of {@link AgentStreamEvent}, narrowed for the formatter below. */
type ProviderStatusStreamEvent = Extract<AgentStreamEvent, { type: "provider_status" }>;

const BUILTIN_HINTS: Readonly<Record<string, string>> = {
  agent: "Delegating to a subagent…",
  websearch: "Searching the web…",
  webfetch: "Reading a page…",
  bash: "Running a command…",
  read: "Reading files…",
  write: "Writing a file…",
  edit: "Editing a file…",
  glob: "Looking through files…",
  grep: "Searching the workspace…",
};

// Keyword hints matched against the tool segment of MCP tool names
// (mcp__server__tool) so integrations get a natural hint without enumerating
// every tool. Ordered: first match wins.
const KEYWORD_HINTS: ReadonlyArray<readonly [test: RegExp, hint: string]> = [
  [/calendar|event|gcal/u, "Checking the calendar…"],
  [/mail|gmail|email/u, "Checking email…"],
  [/search|find|query|lookup/u, "Searching…"],
  [/todo|task|reminder/u, "Checking your tasks…"],
  [/note|draft|doc/u, "Looking through notes…"],
  [/slack|message|chat|send/u, "Checking messages…"],
  [/file|read|fetch|get|list/u, "Looking something up…"],
  [/web|browse|http|url/u, "Browsing the web…"],
];

export function toolHintFor(toolName: string): string {
  const raw = splitSubagentToolName(typeof toolName === "string" ? toolName.trim() : "").tool;
  if (raw.length === 0) {
    return "Working…";
  }

  // mcp__server__tool → use the tool segment (last) for matching + humanizing.
  const segment = raw.startsWith("mcp__")
    ? (raw.split("__").pop() ?? raw)
    : raw;
  const normalized = segment.toLowerCase();

  const builtin = BUILTIN_HINTS[normalized];
  if (builtin !== undefined) {
    return builtin;
  }
  for (const [test, hint] of KEYWORD_HINTS) {
    if (test.test(normalized)) {
      return hint;
    }
  }
  return "Working…";
}

const TOOL_PREVIEW_CODE_POINTS = 40;
const SUBAGENT_OUTCOME_PREVIEW_CODE_POINTS = 120;
const TOOL_PREVIEW_SCAN_CODE_POINTS = 4_096;
const REDACTED = "[redacted]";

interface ToolActivitySpec {
  readonly action: string;
  readonly actionWithoutPreview?: string;
  /**
   * Action used when the preview is a model-authored `description` — prose that
   * already reads as a sentence, so the verb would double up
   * ("Running Show working tree status").
   */
  readonly narrativeAction?: string;
  readonly previewFields: readonly string[];
  /**
   * Argv-shaped tools carry the program in one scalar field and the
   * subcommand/flags in a string array, so no single field is a usable preview.
   * Joining them into one shell-looking line is what keeps distinct calls on
   * distinct activity lines instead of collapsing into a bare `(×N)` entry.
   */
  readonly argvPreview?: { readonly head: string; readonly tail: string };
  readonly quotePreview?: boolean;
}

const WEB_SEARCH_NAMES = new Set([
  "websearch",
  "searchquery",
  "searchweb",
  "internetsearch",
  "googlesearch",
  "bingsearch",
]);
const WEB_BROWSE_NAMES = new Set([
  "webfetch",
  "browse",
  "browseurl",
  "browseropen",
  "fetchurl",
  "navigate",
  "open",
  "openurl",
  "fetch",
]);
const READ_NAMES = new Set(["read", "readfile"]);
const SKILL_READ_NAMES = new Set(["readskill"]);
const FILE_SEARCH_NAMES = new Set(["glob", "grep", "searchfiles"]);
const WRITE_NAMES = new Set(["write", "writefile"]);
const EDIT_NAMES = new Set(["applypatch", "edit", "editfile", "patch"]);
const COMMAND_NAMES = new Set([
  "bash",
  "exec",
  "execcommand",
  "runcommand",
  "shell",
  "terminal",
]);
const CODE_NAMES = new Set([
  "code",
  "codeinterpreter",
  "executecode",
  "noderepl",
  "python",
  "pythoncode",
  "runcode",
]);
const IMAGE_NAMES = new Set([
  "analyzeimage",
  "image",
  "lookatimage",
  "viewimage",
  "vision",
]);
const MEMORY_NAMES = new Set([
  "memory",
  "memoryupdate",
  "memorywrite",
  "remember",
  "updatememory",
]);
const MEMORY_READ_NAMES = new Set(["memoryrecall"]);
/**
 * Tools that launch a subagent. Their activity line is a *header* for the work
 * that follows, not a leaf action, so renderers group the child tool calls
 * underneath it.
 */
const SUBAGENT_LAUNCH_NAMES = new Set(["agent", "task", "subagent", "dispatchagent"]);

/**
 * Separator the runtime puts between a subagent's profile name and the tool it
 * ran (`researcher▸Read`), so concurrent subagents stay visually distinct on
 * surfaces that render one flat list.
 */
export const SUBAGENT_TOOL_SEPARATOR = "▸";

/** Whether this tool name launches a subagent (case/namespace insensitive). */
export function isSubagentLaunchToolName(toolName: string): boolean {
  const raw = typeof toolName === "string" ? toolName.trim() : "";
  return SUBAGENT_LAUNCH_NAMES.has(toolLeaf(raw).toLowerCase().replace(/[^a-z0-9]+/gu, ""));
}

/**
 * Split a forwarded subagent tool name into its profile and the underlying
 * tool. A name without the separator is returned unchanged with no profile, so
 * this is safe to call on every tool name.
 */
export function splitSubagentToolName(
  toolName: string,
): { readonly profile?: string; readonly tool: string } {
  const raw = typeof toolName === "string" ? toolName : "";
  const index = raw.indexOf(SUBAGENT_TOOL_SEPARATOR);
  if (index < 0) return { tool: raw };
  const profile = raw.slice(0, index).trim();
  const tool = raw.slice(index + SUBAGENT_TOOL_SEPARATOR.length).trim();
  // A leading/trailing separator carries no profile or no tool; keep whichever
  // half is real rather than rendering an empty name.
  if (tool.length === 0) return { tool: raw };
  return profile.length === 0 ? { tool } : { profile, tool };
}

const SENSITIVE_ASSIGNMENT_PATTERN = /\b((?:[A-Za-z][A-Za-z0-9_-]*)?(?:authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|security[-_]?token|password|passwd|secret|private[-_]?key|credential|session[-_]?(?:id|token)|token))\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const SENSITIVE_QUERY_PATTERN = /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|password|passwd|secret|signature|x-amz-signature|ticket|token)=)[^&#\s]*/giu;
const URL_USERINFO_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]*@/gu;
const SENSITIVE_FLAG_PATTERN = /(^|\s)(--?(?:[A-Za-z][A-Za-z0-9_-]*[-_])?(?:authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|security[-_]?token|password|passwd|secret|private[-_]?key|credential|session[-_]?(?:id|token)|token))(?:\s+|=)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BASIC_AUTH_FLAG_PATTERN = /(^|\s)(-u|--user(?:name)?)(?:\s+|=)(?:"[^"]*:[^"]*"|'[^']*:[^']*'|[^\s,;]+:[^\s,;]+)/giu;
const MYSQL_PASSWORD_FLAG_PATTERN = /(\b(?:mysql|mysqladmin|mysqldump|mysqlshow|mysqlimport|mysqlslap|mariadb|mariadb-dump)\b(?:(?![;&|]).)*?\s)(-p)(?:\s+|=)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const MYSQL_ATTACHED_PASSWORD_FLAG_PATTERN = /(\b(?:mysql|mysqladmin|mysqldump|mysqlshow|mysqlimport|mysqlslap|mariadb|mariadb-dump)\b(?:(?![;&|]).)*?\s)(-p)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const KNOWN_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/gu,
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
];

export interface ToolActivityLineOptions {
  /** Agent root used to relativize local paths; defaults to process.cwd(). */
  readonly workspaceRoot?: string;
  /** Home directory collapsed to `~`; defaults to os.homedir(). */
  readonly homeDir?: string;
}

let configuredPathRoots: ToolActivityLineOptions = {};

/**
 * Set the process-wide roots used to relativize paths in activity previews.
 *
 * The streaming call site formats an event with no per-message context to hand
 * a workspace down from, so without this the root falls back to
 * `process.cwd()` — which for a service-managed agent is whatever directory the
 * supervisor happened to start it in, not the agent root. Explicit
 * {@link ToolActivityLineOptions} still take precedence.
 *
 * A module-level default is the right shape here because a host process runs
 * exactly one agent; call it once during composition.
 */
export function setToolActivityPathRoots(roots: ToolActivityLineOptions): void {
  configuredPathRoots = roots;
}

/**
 * Format one cumulative tool-activity line for a user-visible transient status.
 * A malformed/proxied/accessor-backed argument object produces action-only copy.
 * Local absolute paths are shown relative to the agent root (or `~`) so the
 * operator's account/machine layout is not exposed in chat surfaces.
 */
export function formatToolActivityLine(
  toolName: string,
  toolArguments?: unknown,
  options?: ToolActivityLineOptions,
): string {
  // A forwarded subagent tool arrives as `researcher▸Read`. Without stripping
  // the profile the whole string normalizes to one unknown token and every
  // child renders as a generic "🔧 Researcher read".
  const rawName = splitSubagentToolName(typeof toolName === "string" ? toolName.trim() : "").tool;
  const leaf = toolLeaf(rawName);
  const normalized = leaf.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  const spec = activitySpec(normalized, leaf);
  const result = previewFromArguments(toolArguments, spec, options);
  if (result === undefined) return spec.actionWithoutPreview ?? spec.action;
  const action = result.narrative ? (spec.narrativeAction ?? spec.action) : spec.action;
  return `${action} ${spec.quotePreview ? JSON.stringify(result.preview) : result.preview}`;
}

/**
 * Format one applied live-input activity line for every structured stream.
 * The original follow-up remains a human message; this helper exposes only a
 * one-line, secret-redacted preview capped at the same 40-code-point boundary
 * used by transient tool activity.
 */
export function formatLiveInputActivityLine(
  text: string,
  options?: ToolActivityLineOptions,
): string {
  // Steering text is operator prose, not a shell line: no `cd` prefix to elide.
  const preview = sanitizePreview(text, { truncation: "head", shell: false, narrative: false }, options);
  return preview === undefined ? "↪️ Steered" : `↪️ Steered: “${preview}”`;
}

/**
 * Format the one non-tool detail retained after a chat activity ledger collapses
 * a completed subagent. Runtime-native completions can carry a direct summary;
 * the in-process Agent tool carries a structured text envelope whose answer or
 * `reason:` line precedes an `<activity>` block. Only that human-facing outcome
 * survives — status/count boilerplate and the tool log never do.
 */
export function formatSubagentOutcomeActivityLine(
  content: unknown,
  isError: boolean,
  options?: ToolActivityLineOptions,
): string | undefined {
  const candidate = subagentOutcomeCandidate(content, isError);
  if (candidate === undefined) return undefined;
  const preview = sanitizePreview(
    candidate,
    { truncation: "head", shell: false, narrative: true },
    options,
    SUBAGENT_OUTCOME_PREVIEW_CODE_POINTS,
  );
  return preview === undefined ? undefined : `${isError ? "Reason" : "Result"}: ${preview}`;
}

const SUBAGENT_STATUS_ONLY = /^(?:ok|complete|completed|failed|failure|timeout|timed out|cancelled|canceled|empty|stopped|ended)(?:\s*·\s*\d+\s+tool calls?)?(?:\s*·\s*\d+(?:\.\d+)?(?:ms|s))?$/iu;

function subagentOutcomeCandidate(content: unknown, isError: boolean): string | undefined {
  if (typeof content !== "string") return undefined;

  const lines = truncateCodePoints(content, TOOL_PREVIEW_SCAN_CODE_POINTS)
    .split(/\r?\n/u)
    .map((rawLine) =>
      rawLine
        .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim());
  const firstNonEmpty = lines.find((line) => line.length > 0);
  const structured = firstNonEmpty !== undefined
    && /^<subagent(?::[^>]*)?>$/iu.test(firstNonEmpty);
  if (!structured) {
    const direct = lines.filter((line) => line.length > 0).join(" ");
    if (direct.length === 0 || SUBAGENT_STATUS_ONLY.test(direct)) return undefined;
    return /^reason:\s*(.+)$/iu.exec(direct)?.[1] ?? direct;
  }

  let insideActivity = false;
  let reason: string | undefined;
  let summary: string | undefined;
  for (const line of lines) {
    if (/^<activity>$/iu.test(line)) {
      insideActivity = true;
      continue;
    }
    if (/^<\/activity>$/iu.test(line)) {
      insideActivity = false;
      continue;
    }
    if (insideActivity || line.length === 0) continue;
    if (/^<\/?subagent(?::[^>]*)?>$/iu.test(line)) continue;

    const reasonMatch = /^reason:\s*(.+)$/iu.exec(line);
    if (reasonMatch?.[1] !== undefined) {
      reason ??= reasonMatch[1];
      continue;
    }
    if (/^note:/iu.test(line) || SUBAGENT_STATUS_ONLY.test(line)) continue;
    summary ??= line;
  }
  return isError ? reason ?? summary : summary;
}

/**
 * Format one activity line for a provider routing transition, or `undefined`
 * when the kind is not worth a line.
 *
 * Only the two transitions an operator can act on are rendered: a route change
 * and a same-model retry. The request lifecycle is pure noise on a chat surface,
 * and `failover_completed` is deliberately silent — the run's final answer
 * carries the attribution, and a completion line would arrive after the answer
 * it explains.
 *
 * Route references are the full `sdk:provider:model` key rather than a short
 * name so the line can be matched against the configured chain unambiguously.
 * These come from the router's own `modelKey()`, never from tool arguments, so
 * no preview sanitization applies.
 */
export function formatProviderStatusLine(event: ProviderStatusStreamEvent): string | undefined {
  const cause = typeof event.reason === "string" && event.reason.length > 0 ? ` (${event.reason})` : "";
  if (event.kind === "failover_started") {
    return `⚠️ Failed over: ${event.from ?? "?"} → ${event.to ?? "?"}${cause}`;
  }
  if (event.kind === "retry_started") {
    // retryIndex is 1-based over retries; the human-facing count includes the
    // original attempt. Matches the TUI's wording in turn-presenter.ts.
    return `⏳ Retrying ${event.model ?? "?"} — attempt ${(event.retryIndex ?? 1) + 1}${cause}`;
  }
  return undefined;
}

function activitySpec(normalized: string, leaf: string): ToolActivitySpec {
  if (SUBAGENT_LAUNCH_NAMES.has(normalized)) {
    // An identifier either way — a configured subagent's name, or the
    // kebab-case one a caller gave a subagent it authored at call time — so
    // quoting it reads as a name rather than as part of the sentence.
    return {
      action: "🤖 Starting agent",
      actionWithoutPreview: "🤖 Starting a subagent",
      previewFields: ["name", "subagent", "agent", "profile"],
      quotePreview: true,
    };
  }
  if (WEB_SEARCH_NAMES.has(normalized)) {
    return {
      action: "🌐 Searching the web for",
      actionWithoutPreview: "🌐 Searching the web",
      previewFields: ["query", "q", "search_query", "text", "prompt"],
    };
  }
  if (WEB_BROWSE_NAMES.has(normalized)) {
    return { action: "🌐 Browsing", previewFields: ["url", "href", "uri", "ref_id"] };
  }
  if (SKILL_READ_NAMES.has(normalized)) {
    return { action: "📚 Reading", previewFields: ["name"], quotePreview: true };
  }
  if (READ_NAMES.has(normalized)) {
    return { action: "📖 Reading", previewFields: ["file_path", "path", "name", "skill", "skill_name"] };
  }
  if (FILE_SEARCH_NAMES.has(normalized)) {
    return {
      action: "🔎 Searching files for",
      actionWithoutPreview: "🔎 Searching files",
      previewFields: ["pattern", "query", "glob", "path"],
    };
  }
  if (WRITE_NAMES.has(normalized)) {
    return { action: "📝 Writing", previewFields: ["file_path", "path", "destination", "name"] };
  }
  if (EDIT_NAMES.has(normalized)) {
    return { action: "✏️ Editing", previewFields: ["file_path", "path", "destination", "name"] };
  }
  if (COMMAND_NAMES.has(normalized)) {
    return {
      action: "🖥️ Running",
      narrativeAction: "🖥️",
      // A `description` states the intent better than the command line ever
      // can. It arrives two ways: a runtime that declares the field (the Claude
      // Agent SDK) or a model that volunteers it anyway — the event carries the
      // raw `tool_use.input`, not a schema-filtered copy, so an undeclared key
      // survives. Fall back to the command whenever it is absent.
      previewFields: ["description", "command", "cmd", "script"],
      argvPreview: { head: "executable", tail: "args" },
    };
  }
  if (CODE_NAMES.has(normalized)) {
    return { action: "🐍 Running code", previewFields: ["code", "source", "script"] };
  }
  if (IMAGE_NAMES.has(normalized)) {
    return { action: "👁️ Looking at the image", previewFields: ["question", "prompt", "path", "file_path", "name"] };
  }
  if (MEMORY_READ_NAMES.has(normalized)) {
    // A recall query can contain private user context. Keep this status both
    // semantically distinct from writes and deliberately preview-free.
    return { action: "🧠 Recalling memory", previewFields: [] };
  }
  if (MEMORY_NAMES.has(normalized) || normalized.includes("memory")) {
    // Deliberately exclude content/text fields: memory prose can itself be
    // sensitive. Only the operation or destination is suitable for a preview.
    return { action: "🧠 Updating memory", previewFields: ["action", "target", "path", "name"] };
  }
  return {
    action: `🔧 ${humanizeToolLeaf(leaf)}`,
    previewFields: ["query", "url", "path", "name", "action", "target", "command", "cmd"],
  };
}

function toolLeaf(toolName: string): string {
  if (toolName.length === 0) return "Tool";
  const mcpLeaf = toolName.split("__").at(-1) ?? toolName;
  const dottedLeaf = mcpLeaf.split(/[./:]/u).at(-1) ?? mcpLeaf;
  return dottedLeaf.length > 0 ? dottedLeaf : "Tool";
}

function humanizeToolLeaf(leaf: string): string {
  const cleaned = leaf
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  if (cleaned.length === 0) return "Tool";
  const bounded = truncateCodePoints(cleaned, TOOL_PREVIEW_CODE_POINTS);
  return `${bounded.charAt(0).toUpperCase()}${bounded.slice(1)}`;
}

interface ActivityPreview {
  readonly preview: string;
  /** Preview is model-authored prose that already reads as a sentence. */
  readonly narrative: boolean;
}

function previewFromArguments(
  toolArguments: unknown,
  spec: ToolActivitySpec,
  options?: ToolActivityLineOptions,
): ActivityPreview | undefined {
  const record = safePlainRecord(toolArguments);
  if (record === undefined) return undefined;

  for (const key of spec.previewFields) {
    const value = safeOwnScalar(record, key);
    if (value === undefined) continue;
    const shape = previewShapeForField(key);
    const preview = sanitizePreview(value, shape, options);
    if (preview !== undefined) return { preview, narrative: shape.narrative };
  }
  // Argv is the fallback, not the first choice: a tool that offers a whole
  // command line already has the more complete rendering.
  return spec.argvPreview === undefined
    ? undefined
    : previewFromArgv(record, spec.argvPreview, options);
}

function previewFromArgv(
  record: object,
  fields: { readonly head: string; readonly tail: string },
  options?: ToolActivityLineOptions,
): ActivityPreview | undefined {
  const head = safeOwnScalar(record, fields.head);
  if (head === undefined) return undefined;
  // Space-joined so the shell-shaped redactions (`--token x`, `-u user:pass`,
  // `Authorization: Bearer …`) match argv exactly as they match a command line,
  // and so the preview truncates like the command it stands in for.
  const argv = [head, ...safeOwnStringArray(record, fields.tail)].join(" ");
  const preview = sanitizePreview(argv, { truncation: "balanced", shell: true, narrative: false }, options);
  return preview === undefined ? undefined : { preview, narrative: false };
}

/**
 * Read a bounded, contiguous run of string elements using the same descriptor
 * discipline as `safeOwnScalar`: no getters, no proxy traps, no iterator
 * protocol. A non-string element ends the run, because a hole makes the rest of
 * an argv positionally meaningless — a truthful prefix beats a spliced line.
 */
function safeOwnStringArray(record: object, key: string): readonly string[] {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) return [];
    const value = descriptor.value as unknown;
    if (nodeUtilTypes.isProxy(value) || !Array.isArray(value)) return [];

    const parts: string[] = [];
    let budget = TOOL_PREVIEW_SCAN_CODE_POINTS;
    const count = Number(safeOwnScalar(value, "length") ?? 0);
    for (let index = 0; index < count && budget > 0; index += 1) {
      const element = Object.getOwnPropertyDescriptor(value, String(index));
      if (element === undefined || !("value" in element) || typeof element.value !== "string") break;
      parts.push(element.value);
      budget -= element.value.length + 1;
    }
    return parts;
  } catch {
    return [];
  }
}

/**
 * Show local paths relative to the agent root (and collapse the operator's
 * home directory to `~`) before truncation, so transient chat statuses never
 * expose the full absolute machine layout.
 */
function relativizeLocalPaths(value: string, options?: ToolActivityLineOptions): string {
  let result = value;
  for (const [root, replacement] of [
    [normalizeRoot(options?.workspaceRoot ?? configuredPathRoots.workspaceRoot ?? safeCwd()), ""],
    [normalizeRoot(options?.homeDir ?? configuredPathRoots.homeDir ?? safeHomedir()), "~/"],
  ] as const) {
    if (root === undefined) continue;
    result = result.replaceAll(`${root}/`, replacement);
  }
  return result;
}

const LEADING_CD_PATTERN = /^cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))\s*(?:&&|;)\s*/u;

/**
 * Drop a leading `cd <agent root> &&` from a command preview. Every shell call
 * an agent makes already runs in the agent root, so the prefix is constant — it
 * eats half of the 40-code-point budget and pushes the part that distinguishes
 * one call from the next out of view. A `cd` to anywhere *else* is real
 * information and is kept.
 */
function stripRedundantWorkspaceCd(value: string, options?: ToolActivityLineOptions): string {
  const root = normalizeRoot(
    options?.workspaceRoot ?? configuredPathRoots.workspaceRoot ?? safeCwd(),
  );
  if (root === undefined) return value;
  const match = LEADING_CD_PATTERN.exec(value);
  if (match === null) return value;
  const target = match[1] ?? match[2] ?? match[3];
  if (target === undefined || expandHomePrefix(target, options) !== root) return value;
  const remainder = value.slice(match[0].length);
  // A bare `cd <root>` is the whole command; stripping it would leave the line
  // with nothing to say.
  return remainder.length === 0 ? value : remainder;
}

/** Resolve a `cd` target for comparison against the agent root, expanding `~`. */
function expandHomePrefix(target: string, options?: ToolActivityLineOptions): string | undefined {
  const home = normalizeRoot(options?.homeDir ?? configuredPathRoots.homeDir ?? safeHomedir());
  if (target === "~") return home;
  return normalizeRoot(
    target.startsWith("~/") && home !== undefined ? `${home}/${target.slice(2)}` : target,
  );
}

function normalizeRoot(root: string | undefined): string | undefined {
  if (root === undefined || root === "" || root === "/") return undefined;
  return root.endsWith("/") ? root.slice(0, -1) : root;
}

function safeCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

type PreviewTruncation = "head" | "middle" | "balanced";

interface PreviewShape {
  readonly truncation: PreviewTruncation;
  /** Value is a shell command line, so a redundant `cd` prefix can be elided. */
  readonly shell: boolean;
  /** Value is prose the model wrote to explain itself, not an argument. */
  readonly narrative: boolean;
}

function previewShapeForField(field: string): PreviewShape {
  // Prose reads left to right, so it truncates from the end like a sentence.
  if (field === "description") {
    return { truncation: "head", shell: false, narrative: true };
  }
  if (field === "file_path" || field === "path" || field === "destination") {
    return { truncation: "middle", shell: false, narrative: false };
  }
  if (field === "command" || field === "cmd" || field === "script") {
    return { truncation: "balanced", shell: true, narrative: false };
  }
  // Program source, not a shell line: a `cd` inside it is code, not a prefix.
  if (field === "code" || field === "source") {
    return { truncation: "balanced", shell: false, narrative: false };
  }
  return { truncation: "head", shell: false, narrative: false };
}

function safePlainRecord(value: unknown): object | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (nodeUtilTypes.isProxy(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeOwnScalar(record: object, key: string): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const value = descriptor.value as unknown;
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return String(value);
  } catch {
    return undefined;
  }
  return undefined;
}

function sanitizePreview(
  value: string,
  shape: PreviewShape,
  options?: ToolActivityLineOptions,
  maxCodePoints = TOOL_PREVIEW_CODE_POINTS,
): string | undefined {
  let sanitized = truncateCodePoints(value, TOOL_PREVIEW_SCAN_CODE_POINTS)
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (sanitized.length === 0) return undefined;
  // Before relativization, so the comparison sees the raw absolute root.
  if (shape.shell) sanitized = stripRedundantWorkspaceCd(sanitized, options);
  sanitized = relativizeLocalPaths(sanitized, options);

  sanitized = sanitized
    .replace(URL_USERINFO_PATTERN, "$1")
    .replace(SENSITIVE_QUERY_PATTERN, `$1${REDACTED}`)
    .replace(SENSITIVE_FLAG_PATTERN, (_match, boundary: string, flag: string) =>
      `${boundary}${flag} ${REDACTED}`)
    .replace(BASIC_AUTH_FLAG_PATTERN, (_match, boundary: string, flag: string) =>
      `${boundary}${flag} ${REDACTED}`)
    .replace(MYSQL_PASSWORD_FLAG_PATTERN, (_match, prefix: string, flag: string) =>
      `${prefix}${flag} ${REDACTED}`)
    .replace(MYSQL_ATTACHED_PASSWORD_FLAG_PATTERN, (_match, prefix: string, flag: string) =>
      `${prefix}${flag}${REDACTED}`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  for (const pattern of KNOWN_SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, REDACTED);
  }
  sanitized = sanitized.replace(/\s+/gu, " ").trim();
  if (sanitized.length === 0) return undefined;
  return truncatePreview(sanitized, maxCodePoints, shape.truncation);
}

function truncatePreview(value: string, maxCodePoints: number, mode: PreviewTruncation): string {
  if (mode === "head") return truncateCodePoints(value, maxCodePoints);
  const points = Array.from(value);
  if (points.length <= maxCodePoints) return value;
  const visible = Math.max(0, maxCodePoints - 1);
  const prefixLength = mode === "middle" ? Math.floor(visible / 3) : Math.ceil(visible / 2);
  const suffixLength = visible - prefixLength;
  return `${points.slice(0, prefixLength).join("")}…${points.slice(-suffixLength).join("")}`;
}

function truncateCodePoints(value: string, maxCodePoints: number): string {
  const points = Array.from(value);
  return points.length <= maxCodePoints
    ? value
    : `${points.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`;
}
