// Pi builtin declarations and execution adaptation.
import { isAbsolute, resolve, dirname, basename } from "node:path";
import { requireToolContext, resolveSandboxPolicy } from "./shared/tool-context.js";
import { isInsidePath } from "./shared/path-resolver.js";
import { statsForCompletedChange, fileChangeSummary, readFileChangeSnapshot } from "../telemetry/file-change-stats.js";
import { normalizeBashTimeoutMs, normalizeProcessTimeoutMs, readToolImpl, writeToolImpl, editToolImpl, globToolImpl, grepToolImpl, bashToolRun, execToolRun } from "./index.js";
import { objectSchema } from "./shared/tool-schema.js";
import { existsSync, readFileSync } from "node:fs";
import { formatSkillBodyWithPathNote } from "../agent/prompt/skill-index.js";
import { Type } from "@earendil-works/pi-ai";
import { MAX_TOOL_RESULT_BYTES, wrapToolsWithBloatGuard } from "../agent/tool-bloat.js";
import { startPreparedProcess } from "./commands/process-runner.js";
import { passthroughSandbox } from "../agent/sandbox-seam.js";
import { filterEnvelopeNextActions, webFailureEnvelope } from "./web/web-actionable.js";
import { createAgentTool } from "./delegation/agent-tool.js";
import { createAskParentTool } from "./delegation/ask-parent-tool.js";
import { silentTurnRefusalReason } from "../runtime/silent-turn.js";
import { createAgentManageTool } from "./delegation/agent-manage-tool.js";
import { wrapToolsWithApprovalGate } from "../agent/approval.js";

function textResult(text: any, details: any = {}) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    details,
  };
}

function imageResult(data: any, mimeType: any, details: any = {}) {
  return {
    content: [{ type: "image", data: String(data ?? ""), mimeType: mimeType || "image/png" }],
    details,
  };
}

function isImageToolResult(raw: any) {
  return Boolean(raw) && typeof raw === "object" && raw.kind === "image" && typeof raw.data === "string";
}

const DEFAULT_BASH_TIMEOUT_MS = 120_000;

function stripFrontmatter(content: any) {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? content.slice(m[0].length).trim() : content.trim();
}

function isErrorText(value: any) {
  return /^Error:|^Exit code \d+:/i.test(String(value || "").trim());
}

function absolutizePath(value: any, cwd: any) {
  if (!value || typeof value !== "string" || isAbsolute(value) || !cwd) return value;
  return resolve(cwd, value);
}

function normalizeWorkdir(value: any, cwd: any, ctx: any, allowOutside: boolean = false) {
  const base = resolve(cwd || (requireToolContext(ctx)).workspace || process.cwd());
  const resolved = value ? resolve(absolutizePath(value, base)) : base;
  // Command tools check the requested cwd against isWorkdirAllowed/isPathAllowed
  // before preparing either foreground or background execution. Keep the older
  // clamp for file tools: their workdir is not a schema field, and in legacy
  // mode it can itself become an allowed file-access root.
  return allowOutside || isInsidePath(base, resolved) ? resolved : base;
}

function withAbsolutePaths(name: any, params: any, cwd: any, ctx: any) {
  const next = { ...(params || {}) };
  if (["Read", "Write", "Edit"].includes(name)) next.file_path = absolutizePath(next.file_path, cwd);
  if (["Glob", "Grep"].includes(name)) next.path = absolutizePath(next.path, cwd);
  if (["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Exec"].includes(name)) {
    next.workdir = normalizeWorkdir(next.workdir, cwd, ctx, name === "Bash" || name === "Exec");
  }
  return next;
}

function toolText(result: any) {
  if (typeof result === "string") return result;
  if (result == null) return "";
  try { return JSON.stringify(result); } catch { return String(result); }
}

function writeFileChangeDetails(path: any, before: any, after: any) {
  const change = {
    path,
    kind: before && before.exists ? "update" : "add",
  };
  const lineStats = statsForCompletedChange(change, before, after);
  const completedChange = lineStats ? { ...change, line_stats: lineStats } : change;
  const summary = fileChangeSummary([completedChange]);
  return {
    status: "completed",
    changes: [completedChange],
    ...(summary ? { summary } : {}),
  };
}

/**
 * Render a budget for a tool description: the exact milliseconds the host
 * enforces, plus a human unit, so the model can both reason about the scale and
 * pass an exact value back.
 */
function formatDurationForModel(ms: any) {
  const hours = ms / 3_600_000;
  const minutes = ms / 60_000;
  const human = hours >= 1
    ? `${Number.isInteger(hours) ? String(hours) : hours.toFixed(1)}h`
    : (minutes >= 1 ? `${Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)}m` : `${String(Math.round(ms / 1_000))}s`);
  return `${human} (${String(ms)} ms)`;
}

function limitedNumber(value: any, fallback: any) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), fallback);
}

function withToolLimits(name: any, params: any, limits: any = {}) {
  const next = { ...(params || {}) };
  if (["Read", "Glob", "Grep", "WebFetch"].includes(name)) {
    next.max_output_chars = limitedNumber(next.max_output_chars, limits.toolTextLimitChars || 16000);
  }
  if (name === "Glob") {
    next.limit = limitedNumber(next.limit ?? next.max_matches, limits.searchResultLimit || 100);
    delete next.max_matches;
  }
  if (name === "Grep") {
    next.head_limit = limitedNumber(next.head_limit ?? next.max_matches, limits.searchResultLimit || 100);
    next.output_mode = next.output_mode || "files_with_matches";
    delete next.max_matches;
  }
  if (name === "Bash" || name === "Exec") {
    const timeoutLimit = limits.bashTimeoutMs || DEFAULT_BASH_TIMEOUT_MS;
    next.max_output_chars = limitedNumber(next.max_output_chars, limits.bashOutputLimitChars || limits.toolTextLimitChars || 20000);
    // A background hand-off is bounded by the host's processJobs budget, so the
    // FOREGROUND DEFAULT must never bound it: falling back to that default is what
    // silently capped multi-hour background jobs at two minutes, and the `else`
    // branch injects it even when no timeout was requested at all. An explicitly
    // configured bashTimeoutMs still narrows them — a host that sets one means it
    // for background work too.
    const effectiveTimeoutLimit = next.background === true ? limits.bashTimeoutMs : timeoutLimit;
    if (effectiveTimeoutLimit !== undefined) {
      if (name === "Bash" && next.timeout_ms === undefined && next.timeout !== undefined) {
        next.timeout = normalizeBashTimeoutMs(next.timeout, effectiveTimeoutLimit);
      } else {
        next.timeout_ms = normalizeProcessTimeoutMs(next.timeout_ms, effectiveTimeoutLimit);
      }
    }
  }
  return next;
}

export function normalizePiBuiltinToolParams(name: any, params: any, { cwd, toolLimits, ctx }: { cwd?: any; toolLimits?: any; ctx?: any } = {}): any {
  return withToolLimits(name, withAbsolutePaths(name, params, cwd, ctx), toolLimits);
}

function integerSchema() {
  return { type: "integer" };
}

function isReadOnlyShellCommand(command: any) {
  const text = String(command || "").trim();
  if (!text) return false;
  if (/[;&|`<>]|\$\(/.test(text)) return false;
  return [
    /^pwd(\s|$)/,
    /^ls(\s|$)/,
    /^find(\s|$)/,
    /^rg(\s|$)/,
    /^grep(\s|$)/,
    /^sed(\s|$)/,
    /^awk(\s|$)/,
    /^cat(\s|$)/,
    /^head(\s|$)/,
    /^tail(\s|$)/,
    /^wc(\s|$)/,
    /^git\s+(status|diff|log|show|branch|rev-parse|ls-files)(\s|$)/,
  ].some((pattern: RegExp) => pattern.test(text));
}

const ALWAYS_SEQUENTIAL_BUILTINS = new Set(["Write", "Edit", "Bash", "Exec", "NodeRepl"]);

const SENSITIVE_RESULT_PARAMS = new Set(["Bash", "Exec", "WebFetch", "WebSearch"]);

function isStructuredToolRun(value: any) {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.text === "string"
    && value.outcome
    && typeof value.outcome === "object";
}

function createBuiltinTool(name: any, label: any, description: any, parameters: any, execute: any, {
  cwd,
  onEvent,
  toolLimits,
  toolPolicy,
  sandboxPolicy,
  sandboxEngine,
  ctx,
  processJobsController,
  ownedForegroundProcessController,
  forceSequential = false,
}: { cwd?: any; onEvent?: ((event: any) => void) | undefined; toolLimits?: any; toolPolicy?: any; sandboxPolicy?: any; sandboxEngine?: any; ctx?: any; processJobsController?: any; ownedForegroundProcessController?: any; forceSequential?: boolean; } = {}) {
  return {
    name,
    label,
    description,
    parameters,
    executionMode: forceSequential || ALWAYS_SEQUENTIAL_BUILTINS.has(name) ? "sequential" : undefined,
    async execute(toolCallId: any, params: any, signal: any) {
      if (signal?.aborted) throw new Error("tool execution aborted");
      const normalized = normalizePiBuiltinToolParams(name, params, { cwd, toolLimits, ctx });
      if (processJobsController && params?.background === true && (name === "Bash" || name === "Exec")) {
        // Foreground normalization always materializes the established default
        // limits. A background omission instead belongs to the host's compiled
        // process-job config, so preserve absence while still narrowing every
        // explicitly supplied per-call value through the ordinary tool caps.
        if (params.max_output_chars === undefined) delete normalized.max_output_chars;
        if (params.timeout_ms === undefined && (name !== "Bash" || params.timeout === undefined)) {
          delete normalized.timeout_ms;
        }
      }
      if (name === "Bash"
        && toolPolicy?.bashReadOnly
        && !isReadOnlyShellCommand(normalized.command)) {
        throw new Error("Error: Planning shell policy allows only read-only inspection commands.");
      }
      const shouldTrackWrite = name === "Write" && typeof normalized.file_path === "string" && normalized.file_path.length > 0;
      const beforeWrite = shouldTrackWrite ? readFileChangeSnapshot(normalized.file_path) : null;
      const raw = await execute(normalized, {
        toolCallId,
        toolLimits,
        signal,
        sandboxPolicy,
        sandboxEngine,
        ctx,
        processJobsController,
        ownedForegroundProcessController,
      });
      // Image reads (e.g. Read on a .png) come back as a structured image
      // result so vision models see pixels; emit an image content block and let
      // the shared bloat guard cap oversize payloads.
      if (isImageToolResult(raw)) {
        return imageResult(raw.data, raw.mimeType, { tool: name, params: normalized });
      }
      const structured = isStructuredToolRun(raw) ? raw : null;
      const text = structured ? structured.text : toolText(raw);
      if (!structured && isErrorText(text)) throw new Error(text);
      if (structured?.outcome?.legacyTimeoutUsed) {
        onEvent?.({
          type: "runtime_warning",
          warning_kind: "deprecated_bash_timeout",
          message: "Bash.timeout is deprecated; use timeout_ms for exact millisecond semantics.",
        });
      }
      const details = (({
        tool: name,
        ...(SENSITIVE_RESULT_PARAMS.has(name) ? {} : { params: normalized }),
        ...(structured ? { outcome: structured.outcome } : {}),
      }) as any);
      if (shouldTrackWrite) {
        details.file_change = writeFileChangeDetails(normalized.file_path, beforeWrite, readFileChangeSnapshot(normalized.file_path));
      }
      return textResult(text, details);
    },
  };
}

/**
 * Progressive skill disclosure: exposes a `ReadSkill` tool so the agent can pull
 * a named skill's FULL body on demand (skills are otherwise injected index-only).
 *
 * Two input shapes are accepted, matching what hosts pass:
 *  - Minimal / legacy (mono-agent's agent-harness): bare `skillNames` + a shared
 *    `skillsRoot` (the directory that directly contains `<name>/SKILL.md`), or the
 *    back-compat `dataDir` (skills under `<dataDir>/skills`). This path is UNCHANGED.
 *  - pi's neutral `Skill` shape (`{name, description, content, filePath, ...}`,
 *    what worklab passes): each skill carries an absolute `filePath`. When NO shared
 *    `skillsRoot`/`dataDir` is configured, ReadSkill derives each skill's root from
 *    its own `filePath` — pi has no lazy-body equivalent, so the body is still read
 *    from disk on demand rather than injected up front.
 *
 * The path-traversal guard (resolved file must stay under the shared root) is
 * preserved on the shared-root path; on the filePath path the name→file binding is
 * fixed at build time and the model can only pick an enum value, so there is no
 * name-driven traversal surface.
 */
function readSkillTool(skillNames: any[] = [], { skillsRoot, dataDir, skills = [] }: { skillsRoot?: any; dataDir?: any; skills?: any[]; } = {}) {
  const sharedRoot = skillsRoot
    ? resolve(skillsRoot)
    : (dataDir ? resolve(dataDir, "skills") : null);
  const isSafeName = (name: any) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);

  // name -> {path, assetsPath, skillsRoot} derived from the pi Skill filePath.
  // filePath is the skill file itself (nested `<root>/<name>/SKILL.md` or a flat
  // `<root>/<name>.md`): assetsPath is its directory; the note-only skills root is
  // one level up for the nested layout, else the directory itself.
  const filePathEntries = new Map();
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill || typeof skill !== "object") continue;
    if (!isSafeName(skill.name) || typeof skill.filePath !== "string" || !skill.filePath) continue;
    if (filePathEntries.has(skill.name)) continue;
    const path = resolve(skill.filePath);
    const assetsPath = dirname(path);
    const root = basename(path) === "SKILL.md" ? dirname(assetsPath) : assetsPath;
    filePathEntries.set(skill.name, { path, assetsPath, skillsRoot: root });
  }

  // A shared root (minimal/legacy form) drives the tool exactly as before;
  // filePath is consulted ONLY when it is absent — "derive root from
  // skill.filePath when skillsRoot is absent".
  const enumNames = sharedRoot
    ? skillNames.filter(isSafeName)
    : [...filePathEntries.keys()];
  if (!enumNames.length) return null;

  return {
    name: "ReadSkill",
    label: "Read Skill",
    description: "Load the complete instructions for a named skill. Use ReadSkill instead of Read for SKILL.md files. If a skill's instructions are already present in this conversation, apply those instead of loading it again.",
    parameters: objectSchema({ name: { type: "string", enum: [...new Set(enumNames)].sort() } }, ["name"]),
    async execute(_toolCallId: any, { name }: { name: any; }) {
      if (sharedRoot) {
        const path = resolve(sharedRoot, name, "SKILL.md");
        if (!path.startsWith(sharedRoot + "/")) throw new Error(`invalid skill path: ${name}`);
        if (!existsSync(path)) throw new Error(`SKILL.md not found for ${name}`);
        return textResult(formatSkillBodyWithPathNote({
          body: stripFrontmatter(readFileSync(path, "utf8")),
          assetsPath: resolve(sharedRoot, name),
          skillsRoot: sharedRoot,
        }), { skill: name, path });
      }
      const entry = filePathEntries.get(name);
      if (!entry || !existsSync(entry.path)) throw new Error(`SKILL.md not found for ${name}`);
      return textResult(formatSkillBodyWithPathNote({
        body: stripFrontmatter(readFileSync(entry.path, "utf8")),
        assetsPath: entry.assetsPath,
        skillsRoot: entry.skillsRoot,
      }), { skill: name, path: entry.path });
    },
  };
}

export function createStructuredOutputTool(outputSchema: any, onStructuredOutput: any): { name: string; label: string; description: string; parameters: Type.TUnsafe<unknown>; executionMode: string; execute(_toolCallId: any, params: any): Promise<{ content: { type: string; text: string; }[]; details: any; terminate: boolean; }>; };
export function createStructuredOutputTool(outputSchema: any, onStructuredOutput: any): { name: string; label: string; description: string; parameters: Type.TUnsafe<unknown>; executionMode: string; execute(_toolCallId: any, params: any): Promise<{ content: { type: string; text: string }[]; details: any; terminate: boolean }> } | null {
  if (!outputSchema) return null;
  return {
    name: "StructuredOutput",
    label: "Structured Output",
    description: "Submit the final structured result object. Call this once when the response is complete.",
    parameters: Type.Unsafe(outputSchema),
    executionMode: "sequential",
    async execute(_toolCallId: any, params: any) {
      onStructuredOutput?.(params);
      return {
        content: [{ type: "text", text: "Structured output received." }],
        details: params,
        terminate: true,
      };
    },
  };
}

export function getPiBuiltinTools(allowedTools: any, {
  disallowedTools = [],
  skillNames = [],
  skills = [],
  skillsRoot,
  dataDir,
  cwd,
  onEvent,
  toolLimits,
  persistArtifact = null,
  onTruncate = null,
  toolPayloadMaxBytes = MAX_TOOL_RESULT_BYTES,
  imageInlineMaxBytes = toolPayloadMaxBytes,
  toolPolicy = null,
  sandboxPolicy = null,
  sandboxEngine = null,
  approvalManager = null,
  approvalModel = null,
  nodeReplController = null,
  webController = null,
  processJobsController = null,
  ownedForegroundProcessController = null,
  processJobsAvailability,
  subagents = null,
  askParentController = null,
  finishSilentlyController = null,
  silentTurnState = null,
  subagentContext = null,
  toolExposure = {},
  toolExecutionMode = "safe-parallel",
  ctx = null,
}: { disallowedTools?: any[]; skillNames?: any[]; skills?: any[]; skillsRoot?: any; dataDir?: any; cwd?: any; onEvent?: (event: any) => void; toolLimits?: any; persistArtifact?: any; onTruncate?: any; toolPayloadMaxBytes?: number; imageInlineMaxBytes?: any; toolPolicy?: any; sandboxPolicy?: any; sandboxEngine?: any; approvalManager?: any; approvalModel?: any; nodeReplController?: any; webController?: any; processJobsController?: any; ownedForegroundProcessController?: any; processJobsAvailability?: any; toolExecutionMode?: "sequential" | "safe-parallel"; subagents?: any; askParentController?: any; finishSilentlyController?: any; silentTurnState?: any; toolExposure?: any; subagentContext?: any; ctx?: any } = {}): any[] {
  const instancesEnabled = ["Agent", "AgentManage"].every((name: string) =>
    (!Array.isArray(allowedTools) || allowedTools.includes("*") || allowedTools.includes(name))
    && !disallowedTools.includes(name));
  const textLimitSchema = integerSchema();
  const bashLimitSchema = integerSchema();
  const legacyBashTimeoutSchema = {
    type: "integer",
    description: "Deprecated compatibility timeout. Values up to 600 mean seconds and larger values mean milliseconds; use timeout_ms instead.",
  };
  // Definitions describe the stable profile; only current controllers admit calls.
  const foregroundTimeoutDescription = "Foreground commands are bounded by the current host command ceiling and owning job deadline; see host_turn_context.";
  const processTimeoutSchema = {
    type: "integer", minimum: 1,
    description: "Exact timeout in milliseconds. The host clamps this to the current command ceiling and kills the command at that limit. Background execution requires current host admission.",
  };
  const backgroundSchema = {
    type: "boolean",
    description: "Run as a durable background process job, only when currently available. Foreground is the default: background costs an extra turn and defers the answer. Use only for work expected to exceed the foreground ceiling or outlive your reply, not work whose output you need now. A restart interrupts jobs. Do not daemonize into another process group or session. The start receipt reports the granted max_runtime_ms; timeout_ms may lower but never raise it.",
  };
  const processDescriptionSchema = {
    type: "string",
    description: "Short present-participle phrase describing what the command is doing, shown in tool activity and background-job lifecycle messages (for example, \"Running the full repository test suite\"). Always provide this when background=true. Describe the purpose, not command syntax; never include arguments, paths, credentials, or secrets.",
  };
  // Per-tool closure config (cwd/event sink/limits/policy) plus the per-instance
  // ToolContext `ctx` that the tool impls and shared helpers read from.
  const toolContext = {
    cwd,
    onEvent,
    toolLimits,
    toolPolicy,
    sandboxPolicy,
    sandboxEngine,
    processJobsController,
    ownedForegroundProcessController,
    forceSequential: toolExecutionMode === "sequential",
    ctx,
  };
  // Host-only, request-current observation capability; no raw environment or
  // executable parameters are exposed through Agent/AgentManage schemas.
  const recoveryAccess = {
    workspace: (requireToolContext(ctx)).workspace ?? (requireToolContext(ctx)).repoRoot,
    readableRoots: (requireToolContext(ctx)).additionalReadRoots ?? [],
    sandboxPolicy: resolveSandboxPolicy(requireToolContext(ctx), sandboxPolicy),
    sandboxEngine: sandboxEngine ?? (requireToolContext(ctx)).sandboxEngine,
    runProbe: async (prepared: any, timeoutMs: any) => {
      if (prepared?.sandboxed !== true) throw new Error("Readonly observation sandbox is unavailable.");
      const handle = startPreparedProcess({ ...prepared, args: [...prepared.args] }, {
        timeoutMs: Math.max(1, Math.min(1500, timeoutMs)), maxBufferBytes: 16384, exactEnvironment: true, waitForProcessGroup: true,
      });
      try { await handle.release(); return await handle.completion; }
      catch { handle.cancel(); return { ...await handle.completion, spawnError: new Error("Readonly observation gate failed.") }; }
    },
  };
  // Delivery-time guard for web next actions. Search results (including
  // shared-cache hits) carry the producing call's suggestions, so the bridge
  // re-filters them against the effective tool policy and the resolved
  // network policy before the model ever sees them. A suggestion the run
  // cannot execute — WebFetch not exposed, or its URL denied — is stripped,
  // never delivered. Hints confer no authority.
  const webDeliveryDenied = new Set(Array.isArray(disallowedTools) ? disallowedTools : []);
  const webDeliveryAllowAll = !Array.isArray(allowedTools) || allowedTools.includes("*");
  const webDeliveryExposed = (name: any) => (webDeliveryAllowAll || allowedTools.includes(name)) && !webDeliveryDenied.has(name);
  const filterWebDelivery = (result: any) => {
    if (!result || result.error || typeof result.text !== "string" || !result.outcome) return result;
    const runtime = requireToolContext(ctx);
    const sandbox = runtime.sandbox ?? passthroughSandbox;
    const policy = resolveSandboxPolicy(runtime, sandboxPolicy);
    const filtered = filterEnvelopeNextActions(result.text, result.outcome, (action: any) => {
      if (action?.tool !== "WebFetch" && action?.tool !== "WebSearch") return false;
      if (!webDeliveryExposed(action.tool)) return false;
      if (action?.tool === "WebFetch") {
        const url = action?.args?.url;
        if (typeof url !== "string") return false;
        try {
          return sandbox.networkAllowsUrl(policy, url);
        } catch {
          return false;
        }
      }
      return true;
    });
    if (!filtered) return result;
    return { ...result, text: filtered.text, outcome: filtered.outcome };
  };
  const all = {
    Read: createBuiltinTool("Read", "Read", "Read a local file. Text files return line-numbered content; image files (PNG, JPEG, GIF, WebP, BMP) are returned as a viewable image you can see directly — use this to look at image attachments.", objectSchema({
      file_path: { type: "string" },
      offset: { type: "integer" },
      start_line: { type: "integer" },
      limit: { type: "integer" },
      max_output_chars: textLimitSchema,
    }, ["file_path"]), readToolImpl, toolContext),
    Write: createBuiltinTool("Write", "Write", "Write content to a local file.", objectSchema({
      file_path: { type: "string" },
      content: { type: "string" },
    }, ["file_path", "content"]), writeToolImpl, toolContext),
    Edit: createBuiltinTool("Edit", "Edit", "Replace an exact string in a local file.", objectSchema({
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    }, ["file_path", "old_string", "new_string"]), editToolImpl, toolContext),
    Glob: createBuiltinTool("Glob", "Glob", "Find files matching a pattern.", objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      limit: { type: "integer" },
      offset: { type: "integer" },
      max_matches: { type: "integer" },
      max_output_chars: textLimitSchema,
    }, ["pattern"]), globToolImpl, toolContext),
    Grep: createBuiltinTool("Grep", "Grep", "Search file contents with ripgrep. Defaults to returning matching file paths; use output_mode='content' only for exact snippets.", objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      type: { type: "string" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
      context: { type: "integer" },
      case_insensitive: { type: "boolean" },
      multiline: { type: "boolean" },
      head_limit: { type: "integer" },
      offset: { type: "integer" },
      max_matches: { type: "integer" },
      max_output_chars: textLimitSchema,
    }, ["pattern"]), grepToolImpl, toolContext),
    Bash: createBuiltinTool("Bash", "Bash", "Execute a shell command for pipelines, redirection, conditionals, or other shell syntax. Prefer Exec for one executable with an argv array. This is macOS: do not assume GNU-only commands or flags." + " " + foregroundTimeoutDescription, objectSchema({
      command: { type: "string" },
      workdir: { type: "string", description: "Run in this directory. Relative paths resolve from the session cwd/workspace; directories outside it are accepted only when path policy allows them. A denied directory returns workdir_denied, never a fallback cwd." },
      description: processDescriptionSchema,
      timeout_ms: processTimeoutSchema,
      timeout: legacyBashTimeoutSchema,
      max_output_chars: bashLimitSchema,
      ...({ background: backgroundSchema, wake_on_completion: { type: "boolean", description: "Only with background=true. Defaults to true. Set false explicitly to update the terminal lifecycle card without waking this conversation." } }),
    }, ["command"]), bashToolRun, toolContext),
    Exec: createBuiltinTool("Exec", "Exec", "Execute one program directly from an argv array without shell parsing. Prefer this for ordinary commands; use Bash only when shell syntax is required." + " " + foregroundTimeoutDescription, objectSchema({
      executable: { type: "string", minLength: 1 },
      args: { type: "array", items: { type: "string" }, maxItems: 256 },
      workdir: { type: "string", description: "Run in this directory. Relative paths resolve from the session cwd/workspace; directories outside it are accepted only when path policy allows them. A denied directory returns workdir_denied, never a fallback cwd." },
      description: processDescriptionSchema,
      timeout_ms: processTimeoutSchema,
      max_output_chars: bashLimitSchema,
      ...({ background: backgroundSchema, wake_on_completion: { type: "boolean", description: "Only with background=true. Defaults to true. Set false explicitly to update the terminal lifecycle card without waking this conversation." } }),
    }, ["executable"]), execToolRun, toolContext),
    NodeRepl: nodeReplController
      ? createBuiltinTool(
        "NodeRepl",
        "Node REPL",
        "Evaluate JavaScript in a run-scoped Node.js REPL. Variables persist across NodeRepl calls in this run.",
        objectSchema({ code: { type: "string", minLength: 1 } }, ["code"]),
        (params: any, { signal }: { signal: any; }) => typeof nodeReplController.executeDetailed === "function"
          ? nodeReplController.executeDetailed(params, { signal })
          : nodeReplController.execute(params, { signal }),
        toolContext,
      )
      : null,
    // Built directly (not via createBuiltinTool) so a subagent answer starting
    // with "Error:" is not reclassified as a tool failure, discarding its log.
    // The host artifact sink lets an over-cap subagent result spill its full
    // text to the run's tool-output directory instead of being cut.
    Agent: createAgentTool(subagents, { onEvent, persistArtifact, ...(subagentContext || {}), instancesEnabled, persistentExposure: toolExposure.persistentSubagents, recoveryAccess }),
    AskParent: createAskParentTool(askParentController, toolExposure.askParent),
    FinishSilently: finishSilentlyController && silentTurnState ? {
      name: "FinishSilently",
      label: "Finish Silently",
      description: "End this admitted host notification turn without a visible reply. Call this alone, without narration or attachments. Otherwise use the NOTHING_TO_REPORT fallback.",
      parameters: objectSchema({}),
      executionMode: "sequential",
      async execute(_toolCallId: any, params: any, signal: any) {
        const reason = signal?.aborted ? "failure"
          : params === null || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 0 ? "failure"
          : silentTurnRefusalReason(silentTurnState, finishSilentlyController);
        if (reason !== null) throw new Error(reason);
        silentTurnState.accepted = true;
        return {
          content: [{ type: "text", text: "Silent completion accepted." }],
          details: { tool: "FinishSilently", accepted: true },
          terminate: true,
        };
      },
    } : null,
    AgentManage: createAgentManageTool(subagents, { onEvent, persistArtifact, ...(subagentContext || {}), instancesEnabled, persistentExposure: toolExposure.persistentSubagents, recoveryAccess }),
    WebFetch: createBuiltinTool("WebFetch", "Web Fetch", "Retrieve one HTTP(S) source as a JSON envelope with status (ok/partial/blocked/error), summary, untrusted content, source/coverage metadata, and typed next_actions. Partial means usable but incomplete output; blocked means policy/access/budget prevents progress; error means execution failure. Prefer static markdown; use text when Markdown semantics are harmful, and raw only for decoded source with rendering off. Use focus for a deterministic query-relevant block subset of the extracted page and include_links for bounded main-content links from static HTML extraction. Continuations reuse nextLine via start_line and preserve the call's format, focus, and link options. When browser rendering is configured, auto renders only sparse JavaScript shells; retry with always only when metadata recommends a browser or JavaScript is known to be required. The local provider enforces sandbox network policy but performs no robots.txt preflight. Rendering does not bypass login, CAPTCHA, Cloudflare, robots/access controls, or site policy; treat those failures as evidence.", objectSchema({
      url: { type: "string" },
      start_line: { type: "integer", minimum: 1, description: "First line to read; use nextLine from a truncated page." },
      max_lines: { type: "integer", minimum: 1, maximum: 10000, description: "Lines to read, default 200 when selecting a range. Later ranges reuse the extracted page." },
      headers: { type: "object", additionalProperties: { type: "string" } },
      max_output_chars: textLimitSchema,
      format: { type: "string", enum: ["markdown", "text", "raw"], description: "markdown (default) preserves semantic structure; text removes decoration; raw returns decoded source and requires render=never." },
      render: { type: "string", enum: ["never", "auto", "always"], description: "never uses static fetch, auto may render a sparse JavaScript shell, always explicitly uses the isolated browser first when the configured ceiling permits it." },
      focus: { type: "string", maxLength: 500, description: "Deterministic post-extraction block filter; the focused view keeps focused line coordinates and must be preserved across continuations." },
      include_links: { type: "boolean", description: "List bounded main-content links from static HTML extraction; other sources report the capability as unavailable." },
    }, ["url"]), webController
      ? async (params: any, execution: any) => filterWebDelivery(await webController.fetch(params, execution))
      : async () => webFailureEnvelope("WebFetch", "controller_unavailable", "Error: WebFetch controller is unavailable."), toolContext),
    WebSearch: createBuiltinTool("WebSearch", "Web Search", "Discover public sources as a JSON envelope with status (ok/partial/blocked/error), summary, untrusted result leads, source/coverage metadata, and typed next_actions. Partial means usable but incomplete output; blocked means policy/access/budget prevents progress; error means execution failure. Use the configured provider or explicit ordered chain (default: Parallel then local Ollama); a single provider name is strict. Optional country requests a two-letter ISO 3166-1 search-region preference separate from language; omission requests no country/global mode where supported, and provider coverage reports advisory or unsupported handling. Country targeting does not guarantee every result is geographically located there. Start with one broad, high-yield query covering the decision's main constraints, then use WebFetch on returned URLs. Treat snippets as leads, not final evidence. Refine only for a material evidence gap. Never sleep, retry, or delegate to bypass a request budget, cooldown, quota limit, or access gate; continue honestly from available evidence. Domain constraints (the domains and exclude_domains parameters, or site: operators in the query text) travel as site: query operators and are additionally enforced client-side; per-provider handling is reported in coverage filterSupport.domains.", objectSchema({
      query: { type: "string" },
      limit: { type: "integer" },
      alternate_queries: { type: "array", items: { type: "string" }, maxItems: 3 },
      domains: { type: "array", items: { type: "string" }, description: "Restrict results to these domains; sent as site: query operators and enforced client-side." },
      exclude_domains: { type: "array", items: { type: "string" }, description: "Exclude these domains from results; enforced client-side." },
      language: { type: "string" },
      country: { type: "string", pattern: "^[A-Za-z]{2}$", description: "Optional ISO 3166-1 alpha-2 search-region preference, normalized case-insensitively." },
      time_range: { type: "string", enum: ["day", "month", "year"] },
    }, ["query"]), webController
      ? async (params: any, execution: any) => filterWebDelivery(await webController.search(params, execution))
      : async () => webFailureEnvelope("WebSearch", "controller_unavailable", "Error: WebSearch controller is unavailable."), toolContext),
  };
  // allowedTools honors the `"*"` allow-all sentinel (and undefined) as "every
  // built-in"; disallowedTools is the deny-wins filter applied to the final set.
  const allowAll = !Array.isArray(allowedTools) || allowedTools.includes("*");
  const selected = allowAll ? Object.keys(all) : allowedTools;
  const denied = new Set(Array.isArray(disallowedTools) ? disallowedTools : []);
  const names = [...new Set(selected)].filter((name: any) => !denied.has(name)).sort();
  const tools = names.map((name: any) => all[name as keyof typeof all]).filter(Boolean);
  const skillTool = readSkillTool(skillNames, { skillsRoot, dataDir, skills });
  // Deny-check the canonical PascalCase name AND the legacy snake_case alias so
  // an old denylist keeps disabling the tool after the rename.
  if (skillTool && !denied.has("ReadSkill") && !denied.has("read_skill" /* legacy alias */)) tools.push(skillTool);
  tools.sort((a: any, b: any) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (toolExecutionMode === "sequential") {
    for (const tool of tools) tool.executionMode = "sequential";
  }
  const gated = approvalManager
    ? wrapToolsWithApprovalGate(tools, approvalManager, { model: approvalModel })
    : tools;
  return wrapToolsWithBloatGuard(gated, {
    persistArtifact,
    maxBytes: toolPayloadMaxBytes,
    imageMaxBytes: imageInlineMaxBytes,
    onTruncate,
  });
}
