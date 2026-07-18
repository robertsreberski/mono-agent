/**
 * Friendly, secret-safe tool activity copy shared by chat channels.
 *
 * `toolHintFor()` preserves the original one-line hint behavior used by
 * streaming channels. `formatToolActivityLine()` is the richer final-only
 * status used by Slack and Telegram: it includes a bounded preview from a small
 * allowlist of scalar argument fields, but never serializes arbitrary tool
 * input or invokes getters/proxies.
 */

import { types as nodeUtilTypes } from "node:util";

const BUILTIN_HINTS: Readonly<Record<string, string>> = {
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
  const raw = typeof toolName === "string" ? toolName.trim() : "";
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
const TOOL_PREVIEW_SCAN_CODE_POINTS = 4_096;
const REDACTED = "[redacted]";

interface ToolActivitySpec {
  readonly action: string;
  readonly actionWithoutPreview?: string;
  readonly previewFields: readonly string[];
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

const SENSITIVE_ASSIGNMENT_PATTERN = /\b((?:[A-Za-z][A-Za-z0-9_-]*)?(?:authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|security[-_]?token|password|passwd|secret|private[-_]?key|credential|session[-_]?(?:id|token)|token))\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const SENSITIVE_QUERY_PATTERN = /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|password|passwd|secret|signature|x-amz-signature|ticket|token)=)[^&#\s]*/giu;
const URL_USERINFO_PATTERN = /\b(https?:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/giu;
const KNOWN_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/gu,
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
];

/**
 * Format one cumulative tool-activity line for a user-visible transient status.
 * A malformed/proxied/accessor-backed argument object produces action-only copy.
 */
export function formatToolActivityLine(toolName: string, toolArguments?: unknown): string {
  const rawName = typeof toolName === "string" ? toolName.trim() : "";
  const leaf = toolLeaf(rawName);
  const normalized = leaf.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  const spec = activitySpec(normalized, leaf);
  const preview = previewFromArguments(toolArguments, spec.previewFields);
  return preview === undefined
    ? (spec.actionWithoutPreview ?? spec.action)
    : `${spec.action} ${spec.quotePreview ? JSON.stringify(preview) : preview}`;
}

function activitySpec(normalized: string, leaf: string): ToolActivitySpec {
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
    return { action: "🖥️ Running", previewFields: ["command", "cmd", "script"] };
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

function previewFromArguments(
  toolArguments: unknown,
  previewFields: readonly string[],
): string | undefined {
  const record = safePlainRecord(toolArguments);
  if (record === undefined) return undefined;

  for (const key of previewFields) {
    const value = safeOwnScalar(record, key);
    if (value === undefined) continue;
    const preview = sanitizePreview(value);
    if (preview !== undefined) return preview;
  }
  return undefined;
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

function sanitizePreview(value: string): string | undefined {
  let sanitized = truncateCodePoints(value, TOOL_PREVIEW_SCAN_CODE_POINTS)
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (sanitized.length === 0) return undefined;

  sanitized = sanitized
    .replace(URL_USERINFO_PATTERN, "$1")
    .replace(SENSITIVE_QUERY_PATTERN, `$1${REDACTED}`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  for (const pattern of KNOWN_SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, REDACTED);
  }
  sanitized = sanitized.replace(/\s+/gu, " ").trim();
  if (sanitized.length === 0) return undefined;
  return truncateCodePoints(sanitized, TOOL_PREVIEW_CODE_POINTS);
}

function truncateCodePoints(value: string, maxCodePoints: number): string {
  const points = Array.from(value);
  return points.length <= maxCodePoints
    ? value
    : `${points.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`;
}
