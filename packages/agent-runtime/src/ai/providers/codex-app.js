import { createHash } from "node:crypto";
import { normalizeCodexItemEvent } from "../streaming/codex-events.js";
import { createFileChangePayload } from "../file-change-stats.js";
import { formatLiveInputGuidance } from "../live-input-prompt.js";
import { estimateCost } from "../cost.js";
import { codexModelSupportsFastMode, normalizeFastMode } from "../runtime/fast-mode.js";
import { readRuntimeBrand } from "../../agent/tools/shared/runtime-context.js";
import { buildCapabilitiesUsed } from "../runtime/capabilities-used.js";
import { resolveSandboxPolicy } from "../../agent/tools/shared/tool-context.js";
import { createSessionRegistry } from "../runtime/sessions.js";
import { createSessionLiveness } from "../runtime/session-liveness.js";
import {
  isAllowAllToolPolicy,
  TOOL_POLICY_ALLOW_ALL_ONLY,
} from "../runtime/tool-policy.js";
import { toolLifecycleMetadata } from "../tool-lifecycle.js";
import {
  addOpaqueSensitiveValue,
  CODEX_APP_SERVER_ARGS,
  CODEX_APP_SERVER_ISOLATED_ARGS,
  codexErrorMessage,
  createCodexAppServerClient,
  isCodexRequestTimeout,
  isSensitivePayloadField,
  normalizedSensitiveName,
  redactCodexDiagnostic,
  redactCodexPayload,
  sanitizeCodexDiagnostic,
  sanitizeCodexNotification,
  sanitizeCodexResponseError,
  sensitiveEnvironmentValues,
  utf8Head,
} from "./codex/app-server-client.js";

export { createCodexAppServerClient };

const DEFAULT_THREAD_START_ATTEMPTS = 2;
const DEFAULT_THREAD_START_BACKOFF_MS = 5_000;
const MIN_THREAD_START_TIMEOUT_MS = 60_000;
const MAX_THREAD_START_TIMEOUT_MS = 180_000;
const THREAD_START_PROMPT_CHARS_PER_STEP = 50_000;
const THREAD_START_TIMEOUT_STEP_MS = 30_000;

function isSensitiveCliFlag(name) {
  const normalized = normalizedSensitiveName(String(name || "").replace(/^-+/u, ""));
  return isSensitivePayloadField(normalized)
    || /(?:^|_)(?:auth|private_key|access_key|signature|sig)$/u.test(normalized);
}

function addOpaqueSensitiveValues(target, values, { splitCredentials = false } = {}) {
  if (!values || typeof values !== "object") return;
  for (const value of Object.values(values)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => addOpaqueSensitiveValue(target, entry, { splitCredentials }));
    } else {
      addOpaqueSensitiveValue(target, value, { splitCredentials });
    }
  }
}

function addEncodedCredentialValue(target, value) {
  addOpaqueSensitiveValue(target, value);
  try {
    const decoded = decodeURIComponent(value);
    addOpaqueSensitiveValue(target, decoded);
    addOpaqueSensitiveValue(target, encodeURIComponent(decoded));
  } catch {
    // Invalid percent escapes are still covered by the original raw value.
  }
}

function addUrlSensitiveValues(target, rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return;
  try {
    const parsed = new URL(rawUrl);
    addEncodedCredentialValue(target, parsed.username);
    addEncodedCredentialValue(target, parsed.password);
    for (const value of parsed.searchParams.values()) {
      // Query parameter names are provider-defined. All opaque query values are
      // treated as credentials rather than betting on a finite key allowlist.
      addEncodedCredentialValue(target, value);
    }
    for (const part of parsed.search.slice(1).split("&")) {
      if (part.includes("=")) addEncodedCredentialValue(target, part.slice(part.indexOf("=") + 1));
    }
  } catch {
    // Non-URL templates are passed through unchanged and may still be covered
    // by a surrounding secret-bearing CLI flag or payload-field redaction.
  }
}

function addHeaderArgumentSensitiveValues(target, header) {
  if (typeof header !== "string") return;
  const separator = header.indexOf(":");
  const value = separator >= 0 ? header.slice(separator + 1).trim() : header.trim();
  addOpaqueSensitiveValue(target, value, { splitCredentials: true });
}

function addCliSensitiveValues(target, args) {
  if (!Array.isArray(args)) return;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (typeof argument !== "string") continue;
    addUrlSensitiveValues(target, argument);
    const equals = argument.indexOf("=");
    if (equals > 0) {
      const flag = argument.slice(0, equals);
      const value = argument.slice(equals + 1);
      // `--url=...` and `--endpoint=...` are not themselves secret flags, but
      // their inline RHS can contain URL userinfo or query credentials.
      addUrlSensitiveValues(target, value);
      if (/^(?:-H|--header|--http-header)$/iu.test(flag)) {
        addHeaderArgumentSensitiveValues(target, value);
        continue;
      }
      if (isSensitiveCliFlag(flag)) {
        addOpaqueSensitiveValue(target, value, { splitCredentials: true });
        continue;
      }
    }
    if (isSensitiveCliFlag(argument) && typeof args[index + 1] === "string") {
      addOpaqueSensitiveValue(target, args[index + 1], { splitCredentials: true });
      index += 1;
      continue;
    }
    if (/^(?:-H|--header|--http-header)$/iu.test(argument) && typeof args[index + 1] === "string") {
      addHeaderArgumentSensitiveValues(target, args[index + 1]);
      index += 1;
    }
  }
}

function codexRequestSensitiveValues(options = {}) {
  const values = new Set(sensitiveEnvironmentValues({
    ...process.env,
    ...(options.codexAppServerEnv || {}),
  }));
  for (const server of Object.values(options.mcpServers || {})) {
    if (!server || typeof server !== "object") continue;
    // MCP env/header names are provider-defined and need not contain words such
    // as "token" or "secret". Treat every opaque value on these credential-
    // bearing surfaces as sensitive instead of relying on a key-name heuristic.
    addOpaqueSensitiveValues(values, server.env);
    addOpaqueSensitiveValues(values, server.headers, { splitCredentials: true });
    addUrlSensitiveValues(values, server.url);
    addCliSensitiveValues(values, server.args);
  }
  addCliSensitiveValues(values, options.codexAppServerArgs);
  return [...values].sort((left, right) => right.length - left.length);
}

const CODEX_APP_CAPABILITIES = {
  kind: "codex-app",
  runtime: "app-server",
  streaming: true,
  structured_output: true,
  // codex-app emits the started thread id, surfaced as provider_session_id.
  // With options.sessionKeepAlive the app-server subprocess + thread stay
  // live in codexSessions, so a follow-up run can resume the thread via
  // options.sessionId. The protocol still has no thread/load primitive, so
  // resume only works while the subprocess is alive.
  supports_session_resume: true,
  native_runtime_config: null,
  supports_mcp: true,
  supports_skills: true,
  supports_builtin_tools: true,
  supports_live_input: true,
  // Codex owns its collaboration agents and exposes their lifecycle through
  // app-server. This does not mean the bridge can inject caller-defined
  // nativeSubagents profiles; that richer request contract is rejected below.
  supports_native_subagents: true,
  supports_fast_mode: true,
  tool_policy: TOOL_POLICY_ALLOW_ALL_ONLY,
};

function promptFromMessages(messages) {
  return Array.isArray(messages)
    ? messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n\n")
    : String(messages || "");
}

function pushUniqueText(texts, text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return;
  if (texts.some((existing) => existing.trim() === value)) return;
  texts.push(value);
}

function userTextInput(text) {
  return [{ type: "text", text: String(text || ""), text_elements: [] }];
}

function integerOption(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function defaultThreadStartTimeoutMs(systemPrompt) {
  const promptChars = String(systemPrompt || "").length;
  const sizeSteps = Math.max(0, Math.ceil(promptChars / THREAD_START_PROMPT_CHARS_PER_STEP) - 1);
  return clamp(
    MIN_THREAD_START_TIMEOUT_MS + (sizeSteps * THREAD_START_TIMEOUT_STEP_MS),
    MIN_THREAD_START_TIMEOUT_MS,
    MAX_THREAD_START_TIMEOUT_MS,
  );
}

function threadStartPolicy(systemPrompt, options = {}) {
  return {
    timeoutMs: integerOption(
      options.codexThreadStartTimeoutMs,
      defaultThreadStartTimeoutMs(systemPrompt),
      { min: 1, max: Number.MAX_SAFE_INTEGER },
    ),
    attempts: integerOption(
      options.codexThreadStartAttempts,
      DEFAULT_THREAD_START_ATTEMPTS,
      { min: 1, max: 5 },
    ),
    backoffMs: integerOption(
      options.codexThreadStartBackoffMs,
      DEFAULT_THREAD_START_BACKOFF_MS,
      { min: 0, max: 300_000 },
    ),
  };
}

function delay(ms, signal) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  if (!timeoutMs || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// `thread/start.sandbox` selects only the thread-level filesystem class; it
// does not own network. `sandboxPolicyForRun()` supplies authoritative per-turn
// networkAccess, per the app-server 0.147.0 / gpt-5.6-sol retained-thread matrix.
function sandboxForRun(options) {
  if (options.codexNoToolsProbe === true) return "read-only";
  if (options.permissionMode === "bypassPermissions") return "danger-full-access";
  if (options.permissionMode === "plan") return "read-only";
  return "workspace-write";
}

function approvalPolicyForRun(options) {
  // mono-agent channel turns are unattended: there is no interactive app-server
  // approval UI on the other end of stdio. `never` lets Codex execute within the
  // selected sandbox and deny escalations itself instead of waiting forever for
  // a client response that cannot arrive.
  return "never";
}

function sandboxPolicyForRun(options) {
  if (options.codexNoToolsProbe === true) return { type: "readOnly", networkAccess: false };
  if (options.permissionMode === "bypassPermissions") return { type: "dangerFullAccess" };
  // App-server 0.147.0 / gpt-5.6-sol retained-thread matrix proved per-turn
  // networkAccess authoritative in both directions.
  const networkAccess = options.codexSandboxNetworkAccess === true;
  if (options.permissionMode === "plan") return { type: "readOnly", networkAccess };
  return {
    type: "workspaceWrite",
    writableRoots: [options.cwd || process.cwd()],
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function codexToolPolicyProblem(options) {
  const allowedTools = Array.isArray(options.allowedTools) ? options.allowedTools : null;
  const disallowedTools = Array.isArray(options.disallowedTools) ? options.disallowedTools : [];
  if (options.codexNoToolsProbe === true) {
    const mcpServerCount = Object.keys(options.mcpServers || {}).length;
    if (allowedTools?.length === 0 && disallowedTools.length === 0 && mcpServerCount === 0 && options.sessionKeepAlive !== true) {
      return null;
    }
    return "Codex no-tool probe mode requires an empty tool policy, no MCP servers, and a disposable session.";
  }
  return isAllowAllToolPolicy(allowedTools, disallowedTools)
    ? null
    : "Direct Codex cannot enforce allowedTools/disallowedTools. Use allow-all-only (omit allowedTools or include \"*\", with no disallowedTools) or another runtime.";
}

const CODEX_NO_TOOL_ACTION_ITEMS = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "collabToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
]);

const CODEX_NO_TOOL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
  "item/tool/call",
  "mcpServer/elicitation/request",
  "applyPatchApproval",
  "execCommandApproval",
]);

// These protocol items are conversation or lifecycle records rather than
// actionable child work. Keep them out of the unknown-item fallback: message
// and reasoning content has dedicated handling, while the remaining records
// would otherwise create misleading tool rows.
const CODEX_PASSIVE_CHILD_ITEM_TYPES = new Set([
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "plan",
  "reasoning",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
  "subAgentActivity",
]);

function codexMcpConfig(mcpServers = {}) {
  const servers = {};
  const invalidNames = [];
  for (const [name, cfg] of Object.entries(mcpServers || {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      invalidNames.push(name);
      continue;
    }
    if (cfg?.command) {
      servers[name] = {
        command: cfg.command,
        ...(Array.isArray(cfg.args) ? { args: cfg.args } : {}),
        ...(cfg.env && typeof cfg.env === "object" ? { env: cfg.env } : {}),
        ...(cfg.cwd && typeof cfg.cwd === "string" ? { cwd: cfg.cwd } : {}),
        enabled: true,
        required: false,
      };
    } else if (cfg?.url) {
      servers[name] = {
        url: cfg.url,
        ...(cfg.headers && typeof cfg.headers === "object" ? { http_headers: cfg.headers } : {}),
        enabled: true,
        required: false,
      };
    }
  }
  return { servers, invalidNames };
}

function codexMcpServerNameProblem(invalidNames) {
  if (!invalidNames.length) return null;
  const names = invalidNames.map((name) => JSON.stringify(name)).join(", ");
  return `Direct Codex cannot configure MCP server ${invalidNames.length === 1 ? "name" : "names"} ${names}. Rename ${invalidNames.length === 1 ? "it" : "them"} to use only ASCII letters, numbers, "_", or "-".`;
}

function stableConfigJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableConfigJson(entry)).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableConfigJson(value[key])}`)
    .join(",")}}`;
}

function codexMcpConfigFingerprint(config) {
  return createHash("sha256").update(stableConfigJson(config)).digest("hex");
}

function codexConfiguredMcpApprovalResponse(request, configuredMcpServerNames) {
  const params = request?.params;
  if (
    request?.method !== "mcpServer/elicitation/request"
    || params?._meta?.codex_approval_kind !== "mcp_tool_call"
    || typeof params?.serverName !== "string"
    || !configuredMcpServerNames.has(params.serverName)
  ) {
    return null;
  }
  return { action: "accept", content: {}, _meta: null };
}

function isActiveTurnNotSteerable(error) {
  const info = error?.data?.info || error?.data?.error?.info || error?.info;
  return info === "activeTurnNotSteerable" || Boolean(info?.activeTurnNotSteerable);
}

function isNoActiveTurnToSteer(error) {
  return /no active turn to steer/i.test(codexErrorMessage(error));
}

function codexErrorDiagnostics(error, sensitiveValues = []) {
  if (!error) return {};
  if (isCodexRequestTimeout(error)) {
    return {
      codex_error_code: "codex_app_server_request_timeout",
      codex_request_method: error.method ? sanitizeCodexDiagnostic(error.method, sensitiveValues, 256) : null,
      codex_request_timeout_ms: error.timeoutMs || null,
      ...(error.stderrTail
        ? { stderr_tail: sanitizeCodexDiagnostic(error.stderrTail, sensitiveValues) }
        : {}),
    };
  }
  return error.code
    ? { codex_error_code: sanitizeCodexDiagnostic(error.code, sensitiveValues, 256) }
    : {};
}

function withoutCodexRequestErrorDiagnostics(diagnostics) {
  const {
    codex_error_code: _codexErrorCode,
    codex_request_method: _codexRequestMethod,
    codex_request_timeout_ms: _codexRequestTimeoutMs,
    stderr_tail: _stderrTail,
    ...rest
  } = diagnostics || {};
  return rest;
}

function mapThreadItem(method, item) {
  if (!item || typeof item !== "object") return null;
  const type = method.endsWith("started") ? "item.started" : "item.completed";
  if (item.type === "agentMessage") {
    return { type, item: { type: "agent_message", id: item.id, text: item.text || "" } };
  }
  if (item.type === "commandExecution") {
    return {
      type,
      item: {
        type: "command_execution",
        id: item.id,
        command: item.command,
        aggregated_output: item.aggregatedOutput || "",
        exit_code: item.exitCode,
        status: item.status,
      },
    };
  }
  if (item.type === "fileChange") {
    return {
      type,
      item: {
        type: "file_change",
        id: item.id,
        changes: item.changes || [],
        status: item.status,
      },
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      type,
      item: {
        type: "mcp_tool_call",
        id: item.id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status,
      },
    };
  }
  if (item.type === "collabAgentToolCall" || item.type === "collabToolCall") {
    const name = `codex_${item.tool || "subagent"}`;
    if (method.endsWith("started")) {
      return {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: item.id,
            name,
            input: {
              prompt: item.prompt,
              model: item.model,
              reasoningEffort: item.reasoningEffort,
              receiverThreadIds: item.receiverThreadIds
                || [item.newThreadId, item.receiverThreadId].filter(Boolean),
            },
          }],
        },
      };
    }
    return {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: item.id,
          content: {
            status: item.status,
            receiverThreadIds: item.receiverThreadIds
              || [item.newThreadId, item.receiverThreadId].filter(Boolean),
            agentsStates: item.agentsStates || [],
            ...(item.error ? { error: item.error } : {}),
          },
          is_error: item.status === "failed" || Boolean(item.error),
          tool_lifecycle: toolLifecycleMetadata(item.status === "failed" || Boolean(item.error)
            ? { state: "error", failure_kind: "runtime_error", detail_code: "codex_collab_failed" }
            : { state: "success" }),
        }],
      },
    };
  }
  if (item.type === "dynamicToolCall") {
    if (method.endsWith("started")) {
      return {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: item.id,
            name: item.namespace ? `${item.namespace}__${item.tool}` : item.tool,
            input: item.arguments || {},
          }],
        },
      };
    }
    return {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: item.id,
          content: item.contentItems || item.result || item.error || "",
          is_error: item.status === "failed" || item.success === false || Boolean(item.error),
          tool_lifecycle: toolLifecycleMetadata(item.status === "failed" || item.success === false || Boolean(item.error)
            ? { state: "error", failure_kind: "runtime_error", detail_code: "codex_dynamic_tool_failed" }
            : { state: "success" }),
        }],
      },
    };
  }
  if (item.type === "reasoning") {
    const text = [...(item.summary || []), ...(item.content || [])].join("\n").trim();
    return text ? { type: "assistant", message: { content: [{ type: "thinking", text }] } } : null;
  }
  return null;
}

function normalizedCollabTool(tool) {
  return String(tool || "")
    .replace(/[^A-Za-z0-9]+/gu, "")
    .toLowerCase();
}

function isCodexCollabItem(item) {
  return item?.type === "collabAgentToolCall" || item?.type === "collabToolCall";
}

function codexCollabReceiverEntries(item) {
  const entries = [];
  const seen = new Set();
  const add = (nativeId, source = {}) => {
    const id = typeof nativeId === "string" ? nativeId.trim() : "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    const agentPath = typeof source.agentPath === "string" && source.agentPath.trim()
      ? source.agentPath
      : undefined;
    const name = [source.name, source.nickname, source.agentNickname, source.agentRole]
      .find((value) => typeof value === "string" && value.trim());
    entries.push({
      nativeId: id,
      ...(agentPath === undefined ? {} : { agentPath }),
      ...(name === undefined ? {} : { name }),
    });
  };

  add(item?.newThreadId, item);
  add(item?.receiverThreadId, item);
  for (const id of item?.receiverThreadIds || []) add(id, item);
  for (const receiver of item?.receiverAgents || []) {
    add(receiver?.threadId ?? receiver?.id, receiver);
  }
  if (item?.agentStatus && typeof item.agentStatus === "object") {
    add(item.agentStatus.threadId ?? item.agentStatus.id, item.agentStatus);
  }
  for (const id of Object.keys(item?.agentsStates || {})) add(id, item?.agentsStates?.[id]);
  return entries;
}

function codexAgentName(agentPath, fallback = "codex") {
  const path = typeof agentPath === "string" ? agentPath.trim() : "";
  if (!path) return fallback;
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) || path;
}

function codexItemFailed(item) {
  const agentStatus = typeof item?.agentStatus === "string"
    ? item.agentStatus
    : item?.agentStatus?.status;
  const status = String(item?.status || agentStatus || "").toLowerCase();
  const exitCode = item?.exitCode ?? item?.exit_code;
  return Boolean(
    item?.error
    || item?.success === false
    || status === "failed"
    || status === "errored"
    || status === "error"
    || status === "interrupted"
    || status === "cancelled"
    || status === "notfound"
    || (typeof exitCode === "number" && exitCode !== 0),
  );
}

function codexActivityContent(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function codexChildToolName(item) {
  if (item?.type === "commandExecution") return "command_execution";
  if (item?.type === "mcpToolCall") {
    return item.server && item.tool ? `mcp__${item.server}__${item.tool}` : item.tool || "mcp_tool_call";
  }
  if (item?.type === "dynamicToolCall") {
    return item.namespace && item.tool ? `${item.namespace}__${item.tool}` : item.tool || "dynamic_tool_call";
  }
  return item?.tool || item?.type || "tool";
}

function codexItemDurationMs(item) {
  const value = Number(item?.durationMs ?? item?.duration_ms);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedCodexActivityItemId(value, limit = 256) {
  const id = String(value || "item");
  if (Buffer.byteLength(id) <= limit) return id;
  const digest = createHash("sha256").update(id).digest("hex");
  const suffix = `:${digest}`;
  return `${utf8Head(id, Math.max(0, limit - Buffer.byteLength(suffix)))}${suffix}`;
}

function usageFromTokenUsage(tokenUsage) {
  const last = tokenUsage?.last || tokenUsage?.total || {};
  return {
    input_tokens: last.inputTokens ?? null,
    output_tokens: last.outputTokens ?? null,
    cache_read_tokens: last.cachedInputTokens ?? null,
  };
}

function contextUsageFromTokenUsage(tokenUsage) {
  const last = tokenUsage?.last;
  const total = Number(last?.totalTokens);
  if (!last || !Number.isFinite(total) || total <= 0) return null;
  const input = Number(last.inputTokens) || 0;
  const cachedInput = Number(last.cachedInputTokens) || 0;
  const output = Number(last.outputTokens) || 0;
  const reasoning = Number(last.reasoningOutputTokens) || 0;
  const contextWindow = Number(tokenUsage?.modelContextWindow) || 0;
  return {
    tokens: {
      input: Math.max(0, input - cachedInput),
      cachedInput,
      output,
      reasoning,
      total,
    },
    ...(contextWindow > 0 ? { contextWindow } : {}),
  };
}

const noopNotificationHandler = () => {};
const rejectIdleServerRequest = (request) => {
  throw new Error(
    `Codex app-server request arrived while its provider session was idle: ${String(request?.method || "unknown")}`,
  );
};

async function closeCodexClient(client) {
  if (!client?.close) return;
  try {
    await client.close();
  } catch {
    // Teardown is best-effort at result boundaries, but the returned promise is
    // always observed so a custom client cannot create an unhandled rejection.
  }
}

// Live keep-alive sessions keyed by codex thread id.
const codexSessions = createSessionRegistry({
  isBusy: (entry) => entry.busy === true,
  onEvict: async (entry) => {
    await closeCodexClient(entry.client);
  },
});
// Synchronous liveness primitives over the registry. Codex only needs the
// await-free busy claim (its resume handling is simpler than pi's — no durable
// reopen / create-on-miss reservation), so it consumes claim(); its keep-alive
// register + deletes stay direct registry ops.
const codexLiveness = createSessionLiveness(codexSessions);

export async function generateCodexAppResponse(systemPrompt, options = {}) {
  const start = Date.now();
  const resolved = options.model;
  const requestedReference = resolved?.reference || `codex:${resolved?.model || ""}`;
  // Resolve every credential-bearing value before the app-server client is
  // constructed. The same set protects transport errors and provider events,
  // including MCP servers whose custom env/header names are not recognizable
  // through key-name heuristics.
  const sensitiveValues = codexRequestSensitiveValues(options);
  const safeDiagnostic = (value, limit) => sanitizeCodexDiagnostic(value, sensitiveValues, limit);
  const safeResponseError = (error) => sanitizeCodexResponseError(error, sensitiveValues);
  // Test seam: lets tests drive the bridge with a stub app-server client.
  const makeClient = options.codexClientFactory || createCodexAppServerClient;
  const keepAlive = options.sessionKeepAlive === true;
  const noToolsProbe = options.codexNoToolsProbe === true;
  const {
    servers: configuredMcpServers,
    invalidNames: invalidMcpServerNames,
  } = codexMcpConfig(options.mcpServers);
  const configuredMcpServerNameList = Object.keys(configuredMcpServers);
  const configuredMcpServerNames = new Set(configuredMcpServerNameList);
  const mcpConfigFingerprint = codexMcpConfigFingerprint(configuredMcpServers);
  // The bridge TTL is a backstop behind the host's session policy; the grace
  // keeps the host's lazy expiry firing first so eviction stays host-driven.
  const sessionTtlMs = Number.isFinite(Number(options.sessionIdleTimeoutMs))
    ? Number(options.sessionIdleTimeoutMs) + 60_000
    : undefined;
  const resumeSessionId = typeof options.sessionId === "string" && options.sessionId.trim()
    ? options.sessionId
    : null;
  const prompt = promptFromMessages(options.messages);
  // Effort arrives pre-normalized; codex has no "max" reasoning tier, so clamp
  // to its ceiling here instead of failing the app-server turn.
  const requestedEffort = typeof options.effort === "string" && options.effort.trim()
    ? options.effort
    : null;
  const normalizedEffort = requestedEffort === "max" ? "xhigh" : requestedEffort;
  const events = [];
  const texts = [];
  const agentTextByItem = new Map();
  const childTextByItem = new Map();
  const childMessageDeltaCounts = new Map();
  const childReasoningDeltaCounts = new Map();
  const subagentGroupsBySpawnId = new Map();
  const subagentBindingsByThread = new Map();
  const pendingChildNotifications = new Map();
  const observedSubagentActivityItems = new Set();
  const compactionStatuses = new Map();
  const activeCompactions = new Map();
  const nativeCompactionTurnKeys = new Set();
  const legacyCompactionTurnKeys = new Set();
  let threadId = null;
  let activeTurnId = null;
  let actualModel = resolved?.model || null;
  let turnCompleted = false;
  let errorMessage = null;
  let failureKind = null;
  let usage = {};
  let codexDiagnostics = {};
  let noToolsViolation = null;
  let serverRequestViolation = null;
  let sentMcpServerNames = [];
  let resolveTurn;
  let resolveTurnReady;
  let resolveLiveInputStop;
  let turnReadyResolved = false;
  let liveInputStopped = false;
  let subagentCallIndex = 0;
  const fileChangeSnapshots = new Map();
  const codexItemContext = {
    fileChangePayload: (raw) => createFileChangePayload(raw, {
      cwd: options.cwd || process.cwd(),
      snapshots: fileChangeSnapshots,
    }),
  };
  const turnDone = new Promise((resolve) => { resolveTurn = resolve; });
  const turnReady = new Promise((resolve) => { resolveTurnReady = resolve; });
  const liveInputStop = new Promise((resolve) => { resolveLiveInputStop = resolve; });

  function stopLiveInput() {
    if (liveInputStopped) return;
    liveInputStopped = true;
    resolveLiveInputStop();
  }

  function setActiveTurnId(turnId, { steerReady = false } = {}) {
    activeTurnId = turnId || activeTurnId;
    if (steerReady && !turnReadyResolved && threadId && activeTurnId) {
      turnReadyResolved = true;
      resolveTurnReady();
    }
    // An abort that fired before the turn id was known could not interrupt;
    // deliver it as soon as the turn becomes addressable.
    if (abortRequested && !interruptSent && threadId && activeTurnId) {
      interruptSent = true;
      client?.request("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
    }
  }

  function emitEvent(event) {
    if (!event) return;
    const safeEvent = redactCodexPayload(event, sensitiveValues);
    events.push(safeEvent);
    options.onEvent?.(safeEvent);
  }

  function invokeLiveInputCallback(message, callbackName, ...args) {
    const callback = message?.[callbackName];
    if (typeof callback !== "function") return;
    try {
      callback.apply(message, args);
    } catch (err) {
      const detail = safeDiagnostic(err, 512);
      emitEvent({
        type: "runtime_warning",
        warning_kind: "live_input_callback_failed",
        message: safeDiagnostic(`Live-input ${callbackName} callback failed: ${detail}`, 1_024),
      });
    }
  }

  const compactionTurnKey = (params = {}) => `${params.threadId || threadId || "thread"}:${params.turnId || activeTurnId || "turn"}`;

  /**
   * @param {{operationId: string, status: string, turnKey?: string, reason?: string, message?: string}} event
   */
  function emitCompaction({
    operationId,
    status,
    turnKey,
    reason,
    message,
  }) {
    const previous = compactionStatuses.get(operationId);
    if (previous === status || previous === "succeeded" || previous === "failed" || previous === "skipped") return;
    compactionStatuses.set(operationId, status);
    if (status === "running") activeCompactions.set(operationId, { turnKey: turnKey || compactionTurnKey() });
    else activeCompactions.delete(operationId);
    emitEvent({
      type: "context_compaction",
      operationId,
      status,
      sdk: "codex",
      trigger: "automatic",
      timestamp: Date.now(),
      model: actualModel ? `codex:${actualModel}` : requestedReference,
      ...(reason ? { reason } : {}),
      ...(message ? { message } : {}),
    });
  }

  function finalizeOpenCompactions(reason, message) {
    for (const [operationId, active] of [...activeCompactions]) {
      emitCompaction({
        operationId,
        status: "failed",
        turnKey: active.turnKey,
        reason,
        message,
      });
    }
  }

  function handleContextCompactionItem(method, params) {
    const item = params.item;
    const turnKey = compactionTurnKey(params);
    nativeCompactionTurnKeys.add(turnKey);
    if (legacyCompactionTurnKeys.has(turnKey)) return;
    const operationId = `codex:${item.id}`;
    emitCompaction({
      operationId,
      status: method === "item/started" ? "running" : "succeeded",
      turnKey,
    });
  }

  function handleLegacyCompaction(params) {
    const turnKey = compactionTurnKey(params);
    const active = [...activeCompactions].find(([, value]) => value.turnKey === turnKey);
    if (active) {
      emitCompaction({ operationId: active[0], status: "succeeded", turnKey });
      return;
    }
    if (nativeCompactionTurnKeys.has(turnKey) || legacyCompactionTurnKeys.has(turnKey)) return;
    legacyCompactionTurnKeys.add(turnKey);
    emitCompaction({
      operationId: `codex:${turnKey}:legacy`,
      status: "succeeded",
      turnKey,
    });
  }

  function handleAgentText(text) {
    const safeText = redactCodexDiagnostic(text, sensitiveValues);
    pushUniqueText(texts, safeText);
    emitEvent({ type: "assistant", message: { content: [{ type: "text", text: safeText }] } });
  }

  function notificationThreadId(params = {}) {
    if (typeof params.threadId === "string" && params.threadId) return params.threadId;
    if (typeof params.item?.senderThreadId === "string" && params.item.senderThreadId) {
      return params.item.senderThreadId;
    }
    return null;
  }

  function notificationTurnId(params = {}) {
    const candidate = params.turn?.id ?? params.turnId;
    return typeof candidate === "string" && candidate ? candidate : null;
  }

  function isRootThreadNotification(params = {}) {
    const sourceThreadId = notificationThreadId(params);
    return sourceThreadId === null || threadId === null || sourceThreadId === threadId;
  }

  function isRootActiveTurnNotification(params = {}) {
    if (!isRootThreadNotification(params)) return false;
    const sourceTurnId = notificationTurnId(params);
    return sourceTurnId === null || activeTurnId === null || sourceTurnId === activeTurnId;
  }

  function ensureSubagentGroup(spawnId, item = {}) {
    const id = typeof spawnId === "string" && spawnId ? spawnId : "codex-subagent";
    let group = subagentGroupsBySpawnId.get(id);
    if (!group) {
      group = {
        id,
        callIndex: subagentCallIndex++,
        name: "codex",
        prompt: typeof item.prompt === "string" ? safeDiagnostic(item.prompt, 2_000) : undefined,
        primaryThreadId: null,
        started: false,
        finished: false,
        startedAt: Date.now(),
        completedTurns: new Set(),
        bindings: new Set(),
        openActivities: new Map(),
        settledActivities: new Set(),
        primaryOutcome: null,
      };
      subagentGroupsBySpawnId.set(id, group);
    } else if (group.prompt === undefined && typeof item.prompt === "string") {
      group.prompt = safeDiagnostic(item.prompt, 2_000);
    }
    return group;
  }

  function metadataForSubagent(group, binding = null) {
    const agentPath = typeof binding?.agentPath === "string" && binding.agentPath.trim()
      ? binding.agentPath
      : undefined;
    const name = binding?.name || codexAgentName(agentPath, group.name || "codex");
    return {
      id: group.id,
      ...(binding?.nativeId ? { nativeId: binding.nativeId } : {}),
      name,
      callIndex: group.callIndex,
      ...(agentPath === undefined ? {} : { label: agentPath, agentPath }),
    };
  }

  function observedSubagentCapabilities() {
    const names = [];
    const seenNames = new Set();
    for (const binding of subagentBindingsByThread.values()) {
      const name = metadataForSubagent(binding.group, binding).name;
      if (typeof name !== "string" || !name.trim() || seenNames.has(name)) continue;
      seenNames.add(name);
      names.push(name);
    }
    return {
      invoked: subagentGroupsBySpawnId.size > 0,
      names,
    };
  }

  function emitSubagentActivity(group, binding, activity) {
    // Once the canonical terminal row is emitted, no late provider frame may
    // append more activity to that group.
    if (group.finished && activity.phase !== "agent_completed") return;
    if (activity.phase === "started" && typeof activity.id === "string") {
      if (group.openActivities.has(activity.id) || group.settledActivities.has(activity.id)) return;
      group.openActivities.set(activity.id, {
        binding,
        name: activity.name,
        startedAt: Date.now(),
      });
    } else if (activity.phase === "completed" && typeof activity.id === "string") {
      if (group.settledActivities.has(activity.id)) return;
      group.openActivities.delete(activity.id);
      group.settledActivities.add(activity.id);
    }
    emitEvent({
      type: "subagent_activity",
      subagent: metadataForSubagent(group, binding),
      ...activity,
    });
  }

  function drainOpenSubagentActivities(group, reason, onlyBinding = null) {
    for (const [id, activity] of [...group.openActivities]) {
      if (onlyBinding && activity.binding !== onlyBinding) continue;
      emitSubagentActivity(group, activity.binding, {
        phase: "completed",
        id,
        name: activity.name,
        isError: true,
        executionMs: Math.max(0, Date.now() - activity.startedAt),
        content: safeDiagnostic(reason, 2_000),
      });
    }
  }

  function ensureSubagentStarted(group, binding = null) {
    if (group.started) return;
    group.started = true;
    group.startedAt = Date.now();
    const subagent = metadataForSubagent(group, binding);
    group.name = subagent.name;
    emitSubagentActivity(group, binding, {
      phase: "agent_started",
      id: `agent:${group.id}`,
      name: `Agent(${subagent.name})`,
      arguments: {
        name: subagent.name,
        ...(subagent.agentPath === undefined ? {} : { description: subagent.agentPath }),
        ...(group.prompt === undefined ? {} : { prompt: group.prompt }),
      },
    });
  }

  /**
   * @param {any} group
   * @param {any} binding
   * @param {{status?: string, error?: any, content?: string, executionMs?: number}} [outcome]
   */
  function finishSubagentGroup(group, binding, {
    status = "completed",
    error,
    content,
    executionMs,
  } = {}) {
    if (group.finished) return;
    ensureSubagentStarted(group, binding);
    const isError = Boolean(error) || codexItemFailed({ status });
    const subagent = metadataForSubagent(group, binding);
    const summary = content
      || (error ? safeDiagnostic(error, 2_000) : `${status || "completed"}`);
    drainOpenSubagentActivities(
      group,
      error
        ? safeDiagnostic(error, 2_000)
        : "Codex subagent ended before this activity completed.",
    );
    // Mark terminal before invoking host callbacks so even re-entrant provider
    // frames cannot append an event after this row.
    group.finished = true;
    emitSubagentActivity(group, binding, {
      phase: "agent_completed",
      id: `agent:${group.id}`,
      name: `Agent(${subagent.name})`,
      isError,
      ...(Number.isFinite(executionMs) ? { executionMs } : {}),
      content: safeDiagnostic(summary, 2_000),
    });
  }

  function maybeFinishSubagentGroup(group) {
    if (group.finished || !group.primaryOutcome) return;
    if ([...group.bindings].some((binding) => !binding.terminal)) return;
    finishSubagentGroup(
      group,
      group.primaryOutcome.binding,
      group.primaryOutcome.outcome,
    );
  }

  function recordPrimarySubagentOutcome(group, binding, outcome) {
    if (!group.primaryOutcome) group.primaryOutcome = { binding, outcome };
    maybeFinishSubagentGroup(group);
  }

  function finalizeOpenSubagents(status, content) {
    for (const group of subagentGroupsBySpawnId.values()) {
      if (group.finished) continue;
      const binding = group.primaryThreadId
        ? subagentBindingsByThread.get(group.primaryThreadId)
        : null;
      finishSubagentGroup(group, binding, { status, error: content, content });
    }
  }

  function subagentActivityId(group, binding, itemId, suffix = "") {
    const nativeId = binding?.nativeId || "child";
    return `agent:${group.id}:${nativeId}:${itemId || "item"}${suffix}`;
  }

  function flushPendingChildNotifications(nativeId) {
    const queued = pendingChildNotifications.get(nativeId);
    if (!queued?.length) return;
    pendingChildNotifications.delete(nativeId);
    for (const notification of queued) handleChildNotification(notification);
  }

  function bindSubagentThread(group, receiver, { primary = false, flush = true } = {}) {
    const nativeId = typeof receiver?.nativeId === "string" ? receiver.nativeId.trim() : "";
    if (!nativeId) return null;
    let binding = subagentBindingsByThread.get(nativeId);
    if (binding && binding.group !== group) return binding;
    if (!binding) {
      binding = {
        group,
        nativeId,
        agentPath: undefined,
        name: undefined,
        lastText: "",
        turnStartedAt: new Map(),
        turnStates: new Map(),
        terminal: false,
        usage: null,
      };
      subagentBindingsByThread.set(nativeId, binding);
    }
    group.bindings.add(binding);
    if (typeof receiver.agentPath === "string" && receiver.agentPath.trim()) {
      binding.agentPath = receiver.agentPath;
      binding.name = codexAgentName(receiver.agentPath, binding.name || group.name);
    }
    if (typeof receiver.name === "string" && receiver.name.trim()) binding.name = receiver.name.trim();
    // A root spawn can report multiple receiver ids. The first is the primary
    // result source; every additional binding remains part of the same group
    // and must terminate before the group terminal row is emitted.
    if (group.primaryThreadId === null && (primary || group.bindings.size === 1)) {
      group.primaryThreadId = nativeId;
    }
    ensureSubagentStarted(group, binding);
    if (flush) flushPendingChildNotifications(nativeId);
    return binding;
  }

  function handleCollabSpawn(method, params, item, sourceBinding = null) {
    const isRootSpawn = sourceBinding === null;
    const group = sourceBinding?.group || ensureSubagentGroup(item.id, item);
    const receivers = codexCollabReceiverEntries(item);
    const bindings = [];
    for (const receiver of receivers) {
      const binding = bindSubagentThread(group, receiver, {
        primary: isRootSpawn,
        // Bind the complete receiver set before replaying out-of-order child
        // frames, otherwise the first queued completion can close the group
        // before later receivers are known to it.
        flush: false,
      });
      if (binding) bindings.push(binding);
    }
    for (const binding of bindings) flushPendingChildNotifications(binding.nativeId);
    if (sourceBinding) {
      const phase = method === "item/started" ? "started" : "completed";
      emitSubagentActivity(group, sourceBinding, {
        phase,
        id: subagentActivityId(group, sourceBinding, item.id),
        name: `${metadataForSubagent(group, sourceBinding).name}▸spawn_agent`,
        ...(phase === "started"
          ? { arguments: { prompt: item.prompt || "", receivers: receivers.map(({ nativeId }) => nativeId) } }
          : {
            isError: codexItemFailed(item),
            content: safeDiagnostic(codexActivityContent({
              status: item.status,
              receivers: receivers.map(({ nativeId }) => nativeId),
              ...(item.error ? { error: item.error } : {}),
            }), 2_000),
          }),
      });
      return;
    }
    if (method === "item/completed" && receivers.length === 0 && codexItemFailed(item)) {
      finishSubagentGroup(group, null, {
        status: item.status || "failed",
        error: item.error || "Codex failed to spawn the subagent",
      });
    }
  }

  function handleSubAgentActivityItem(params, item, sourceBinding = null) {
    const sourceThreadId = notificationThreadId(params) || threadId || "root";
    const signalKey = `${sourceThreadId}:${item.id}:${item.kind}`;
    if (observedSubagentActivityItems.has(signalKey)) return;
    observedSubagentActivityItems.add(signalKey);

    const targetNativeId = typeof item.agentThreadId === "string" ? item.agentThreadId : null;
    const targetBinding = targetNativeId ? subagentBindingsByThread.get(targetNativeId) : null;
    const group = sourceBinding?.group
      || targetBinding?.group
      || ensureSubagentGroup(item.id, item);
    const binding = targetNativeId
      ? bindSubagentThread(group, {
        nativeId: targetNativeId,
        agentPath: item.agentPath,
      }, { primary: sourceBinding === null && targetBinding === undefined })
      : sourceBinding;

    const kind = String(item.kind || "started");
    if (kind === "interrupted") {
      if (binding) {
        for (const turnId of binding.turnStates.keys()) binding.turnStates.set(turnId, "completed");
        binding.terminal = true;
        drainOpenSubagentActivities(
          group,
          `Codex subagent ${binding.agentPath || binding.nativeId} was interrupted before this activity completed.`,
          binding,
        );
      }
      if (binding?.nativeId === group.primaryThreadId) {
        recordPrimarySubagentOutcome(group, binding, {
          status: "interrupted",
          error: `Codex subagent ${binding.agentPath || binding.nativeId} was interrupted`,
        });
      } else {
        emitSubagentActivity(group, binding || sourceBinding, {
          phase: "message",
          id: subagentActivityId(group, binding || sourceBinding, item.id, ":interrupted"),
          name: `${metadataForSubagent(group, binding || sourceBinding).name}▸status`,
          kind: "status",
          role: "assistant",
          content: `interrupted ${item.agentPath || targetNativeId || "subagent"}`,
        });
        maybeFinishSubagentGroup(group);
      }
    } else if (kind === "interacted" || sourceBinding) {
      emitSubagentActivity(group, binding || sourceBinding, {
        phase: "message",
        id: subagentActivityId(group, binding || sourceBinding, item.id, `:${kind}`),
        name: `${metadataForSubagent(group, binding || sourceBinding).name}▸status`,
        kind: "status",
        role: "assistant",
        content: `${kind} ${item.agentPath || targetNativeId || "subagent"}`,
      });
    }
  }

  function emitChildMessage(binding, {
    itemId,
    kind,
    content,
    index = 0,
  }) {
    const text = safeDiagnostic(content, 2_000);
    if (!text) return;
    const { group } = binding;
    emitSubagentActivity(group, binding, {
      phase: "message",
      id: subagentActivityId(group, binding, itemId, `:${kind}:${index}`),
      name: `${metadataForSubagent(group, binding).name}▸${kind}`,
      kind,
      role: "assistant",
      content: text,
    });
  }

  function handleChildItem(method, params, binding) {
    const item = params.item;
    if (!item || typeof item !== "object") return;
    const { group } = binding;
    if (isCodexCollabItem(item) && normalizedCollabTool(item.tool) === "spawnagent") {
      handleCollabSpawn(method, params, item, binding);
      return;
    }
    if (item.type === "subAgentActivity") {
      handleSubAgentActivityItem(params, item, binding);
      return;
    }
    const messageKey = `${binding.nativeId}:${item.id}`;
    if (item.type === "agentMessage") {
      if (method !== "item/completed") return;
      const text = item.text || childTextByItem.get(messageKey) || "";
      binding.lastText = safeDiagnostic(text, 2_000);
      if (!childMessageDeltaCounts.has(messageKey)) {
        emitChildMessage(binding, { itemId: item.id, kind: "text", content: text });
      }
      return;
    }
    if (item.type === "reasoning") {
      if (method !== "item/completed" || childReasoningDeltaCounts.has(messageKey)) return;
      const text = [...(item.summary || []), ...(item.content || [])].join("\n").trim();
      emitChildMessage(binding, { itemId: item.id, kind: "thinking", content: text });
      return;
    }

    const raw = mapThreadItem(method, item);
    const normalized = /** @type {any} */ (normalizeCodexItemEvent(raw, codexItemContext) || raw);
    if (normalized?.type === "file_change") {
      const phase = method === "item/started" ? "started" : "completed";
      const executionMs = codexItemDurationMs(item);
      emitSubagentActivity(group, binding, {
        phase,
        id: subagentActivityId(group, binding, item.id),
        name: `${metadataForSubagent(group, binding).name}▸file_change`,
        ...(phase === "started"
          ? { arguments: { changes: normalized.changes || [], status: normalized.status } }
          : {
            isError: normalized.is_error === true,
            ...(executionMs === undefined ? {} : { executionMs }),
            content: safeDiagnostic(codexActivityContent({
              changes: normalized.changes || [],
              status: normalized.status,
              ...(normalized.error ? { error: normalized.error } : {}),
            }), 2_000),
          }),
      });
      return;
    }
    const blocks = normalized?.message?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block?.type === "tool_use") {
          emitSubagentActivity(group, binding, {
            phase: "started",
            id: subagentActivityId(group, binding, block.id || item.id),
            name: `${metadataForSubagent(group, binding).name}▸${block.name || item.type || "tool"}`,
            arguments: block.input || {},
          });
        } else if (block?.type === "tool_result") {
          const executionMs = codexItemDurationMs(item);
          emitSubagentActivity(group, binding, {
            phase: "completed",
            id: subagentActivityId(group, binding, block.tool_use_id || item.id),
            name: `${metadataForSubagent(group, binding).name}▸${codexChildToolName(item)}`,
            isError: block.is_error === true,
            ...(executionMs === undefined ? {} : { executionMs }),
            content: safeDiagnostic(codexActivityContent(block.content), 2_000),
          });
        }
      }
      return;
    }
    if (item.type === "webSearch" || item.type === "imageView") {
      const phase = method === "item/started" ? "started" : "completed";
      emitSubagentActivity(group, binding, {
        phase,
        id: subagentActivityId(group, binding, item.id),
        name: `${metadataForSubagent(group, binding).name}▸${item.type}`,
        ...(phase === "started"
          ? { arguments: item.type === "webSearch" ? { query: item.query } : { path: item.path } }
          : {
            isError: codexItemFailed(item),
            content: safeDiagnostic(codexActivityContent(item.results || item.result || item.status), 2_000),
          }),
      });
      return;
    }
    if (item.type === "sleep") {
      const phase = method === "item/started" ? "started" : "completed";
      const durationMs = codexItemDurationMs(item);
      emitSubagentActivity(group, binding, {
        phase,
        id: subagentActivityId(group, binding, item.id),
        name: `${metadataForSubagent(group, binding).name}▸sleep`,
        ...(phase === "started"
          ? { arguments: durationMs === undefined ? {} : { durationMs } }
          : {
            isError: codexItemFailed(item),
            content: safeDiagnostic(codexActivityContent({
              ...(durationMs === undefined ? {} : { durationMs }),
              ...(item.status === undefined ? {} : { status: item.status }),
              ...(item.error === undefined ? {} : { error: item.error }),
            }), 2_000),
          }),
      });
      return;
    }
    if (item.type === "imageGeneration") {
      const phase = method === "item/started" ? "started" : "completed";
      const startedDetails = {
        ...(item.status === undefined ? {} : { status: safeDiagnostic(item.status, 128) }),
        ...(item.revisedPrompt === undefined
          ? {}
          : {
            revisedPrompt: item.revisedPrompt === null
              ? null
              : safeDiagnostic(item.revisedPrompt, 1_000),
          }),
      };
      const details = {
        ...(item.status === undefined ? {} : { status: safeDiagnostic(item.status, 128) }),
        ...(item.savedPath === undefined ? {} : { savedPath: safeDiagnostic(item.savedPath, 512) }),
        ...(item.revisedPrompt === undefined
          ? {}
          : {
            revisedPrompt: item.revisedPrompt === null
              ? null
              : safeDiagnostic(item.revisedPrompt, 1_000),
          }),
        ...(item.result === undefined
          ? {}
          : { resultBytes: Buffer.byteLength(String(item.result)) }),
        ...(item.error === undefined ? {} : { error: safeDiagnostic(item.error, 512) }),
      };
      emitSubagentActivity(group, binding, {
        phase,
        id: subagentActivityId(group, binding, item.id),
        name: `${metadataForSubagent(group, binding).name}▸imageGeneration`,
        ...(phase === "started"
          ? { arguments: startedDetails }
          : {
            isError: codexItemFailed(item),
            content: safeDiagnostic(codexActivityContent(details), 2_000),
          }),
      });
      return;
    }
    if (
      CODEX_PASSIVE_CHILD_ITEM_TYPES.has(item.type)
      || typeof item.type !== "string"
      || !item.type.trim()
      || typeof item.id !== "string"
      || !item.id.trim()
    ) {
      return;
    }
    // The protocol has no action/category discriminator. Favor visibility for
    // unknown non-passive items until the bridge gains a first-class mapper;
    // bound opaque details so a new provider payload cannot inflate the stream.
    const phase = method === "item/started" ? "started" : "completed";
    const executionMs = codexItemDurationMs(item);
    const itemId = boundedCodexActivityItemId(item.id);
    const itemType = safeDiagnostic(item.type, 128);
    emitSubagentActivity(group, binding, {
      phase,
      id: subagentActivityId(group, binding, itemId),
      name: `${metadataForSubagent(group, binding).name}▸${itemType}`,
      ...(phase === "started"
        ? { arguments: { item: safeDiagnostic(item, 1_000) } }
        : {
          isError: codexItemFailed(item),
          ...(executionMs === undefined ? {} : { executionMs }),
          content: safeDiagnostic(item, 2_000),
        }),
    });
  }

  function handleChildNotification(notification) {
    const { method, params = {} } = notification;
    const sourceThreadId = notificationThreadId(params);
    const binding = sourceThreadId ? subagentBindingsByThread.get(sourceThreadId) : null;
    if (!binding) {
      if (!sourceThreadId) return;
      const queued = pendingChildNotifications.get(sourceThreadId) || [];
      if (queued.length >= 1_000) queued.shift();
      queued.push(notification);
      pendingChildNotifications.set(sourceThreadId, queued);
      return;
    }
    const { group } = binding;
    if (method === "turn/started") {
      const childTurnId = notificationTurnId(params) || "turn";
      binding.turnStartedAt.set(childTurnId, Date.now());
      binding.turnStates.set(childTurnId, "running");
      binding.terminal = false;
      return;
    }
    if (method === "turn/completed") {
      const childTurnId = notificationTurnId(params) || "turn";
      const terminalKey = `${binding.nativeId}:${childTurnId}`;
      if (group.completedTurns.has(terminalKey)) return;
      group.completedTurns.add(terminalKey);
      const status = params.turn?.status || "completed";
      const error = params.turn?.error?.message || params.turn?.error;
      const startedAt = binding.turnStartedAt.get(childTurnId);
      const executionMs = startedAt === undefined ? undefined : Date.now() - startedAt;
      binding.turnStates.set(childTurnId, "completed");
      binding.terminal = [...binding.turnStates.values()].every((state) => state === "completed");
      drainOpenSubagentActivities(
        group,
        error
          ? safeDiagnostic(error, 2_000)
          : `Codex subagent turn ${status} before this activity completed.`,
        binding,
      );
      if (binding.nativeId === group.primaryThreadId) {
        recordPrimarySubagentOutcome(group, binding, {
          status,
          error,
          content: error || binding.lastText || status,
          executionMs,
        });
      } else {
        emitSubagentActivity(group, binding, {
          phase: "message",
          id: subagentActivityId(group, binding, childTurnId, ":completed"),
          name: `${metadataForSubagent(group, binding).name}▸status`,
          kind: "status",
          role: "assistant",
          content: safeDiagnostic(error || `${status} ${binding.agentPath || binding.nativeId}`, 2_000),
        });
        maybeFinishSubagentGroup(group);
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const itemId = params.itemId || "message";
      const key = `${binding.nativeId}:${itemId}`;
      const current = childTextByItem.get(key) || "";
      childTextByItem.set(key, `${current}${params.delta || ""}`);
      const index = childMessageDeltaCounts.get(key) || 0;
      childMessageDeltaCounts.set(key, index + 1);
      emitChildMessage(binding, { itemId, kind: "text", content: params.delta || "", index });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const itemId = params.itemId || "reasoning";
      const key = `${binding.nativeId}:${itemId}`;
      const index = childReasoningDeltaCounts.get(key) || 0;
      childReasoningDeltaCounts.set(key, index + 1);
      emitChildMessage(binding, { itemId, kind: "thinking", content: params.delta || "", index });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      handleChildItem(method, params, binding);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      binding.usage = usageFromTokenUsage(params.tokenUsage);
      return;
    }
    if (method === "warning" || method === "error" || method === "configWarning" || method === "guardianWarning") {
      emitChildMessage(binding, {
        itemId: notificationTurnId(params) || "warning",
        kind: method === "error" ? "error" : "warning",
        content: params.message || params.error || params,
      });
    }
  }

  function failNoToolsProbe(action) {
    if (!noToolsProbe || noToolsViolation) return;
    const safeAction = safeDiagnostic(action, 512);
    noToolsViolation = safeAction;
    errorMessage = `Codex attempted ${safeAction} during a no-tool readiness probe`;
    failureKind = "tool_policy_violation";
    codexDiagnostics = { ...codexDiagnostics, codex_error_code: "codex_no_tools_violation", codex_tool_action: safeAction };
    emitEvent({
      type: "runtime_warning",
      warning_kind: "codex_no_tools_violation",
      message: "Codex attempted a tool action during the no-tool readiness probe; the turn was interrupted.",
    });
    if (threadId && activeTurnId && !interruptSent) {
      interruptSent = true;
      client?.request("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
    }
    turnCompleted = true;
    stopLiveInput();
    resolveTurn({ id: activeTurnId, status: "interrupted" });
  }

  function failUnsupportedServerRequest(method) {
    if (noToolsProbe) {
      failNoToolsProbe(method);
      return;
    }
    if (serverRequestViolation) return;
    const safeMethod = safeDiagnostic(method, 512);
    serverRequestViolation = safeMethod;
    errorMessage = `Codex requested unsupported client interaction (${safeMethod}); the unattended turn was stopped.`;
    failureKind = "skipped_capability_mismatch";
    codexDiagnostics = {
      ...codexDiagnostics,
      codex_error_code: "codex_server_request_unsupported",
      codex_server_request_method: safeMethod,
    };
    emitEvent({
      type: "runtime_warning",
      warning_kind: "codex_server_request_unsupported",
      message: errorMessage,
    });
    turnCompleted = true;
    stopLiveInput();
    resolveTurn({ id: activeTurnId, status: "interrupted" });
  }

  function assertNoUnsupportedServerRequest() {
    if (serverRequestViolation) {
      throw new Error(errorMessage || `Unsupported Codex app-server request: ${serverRequestViolation}`);
    }
  }

  function rejectUnsupportedChildServerRequest(request, method, binding) {
    if (!binding) return false;
    const params = request?.params || {};
    const sourceThreadId = notificationThreadId(params);
    handleChildNotification({
      method: "error",
      params: {
        threadId: sourceThreadId,
        ...(notificationTurnId(params) ? { turnId: notificationTurnId(params) } : {}),
        message: `Codex subagent requested unsupported client interaction (${safeDiagnostic(method, 512)}).`,
      },
    });
    return true;
  }

  function handleNotification(notification) {
    const safeNotification = sanitizeCodexNotification(notification, sensitiveValues);
    const { method, params = {} } = safeNotification;
    if (noToolsProbe) {
      const itemType = params.item?.type;
      if (
        CODEX_NO_TOOL_REQUEST_METHODS.has(method)
        || ((method === "item/started" || method === "item/completed") && CODEX_NO_TOOL_ACTION_ITEMS.has(itemType))
      ) {
        failNoToolsProbe(typeof itemType === "string" ? itemType : method);
        return;
      }
    }
    const sourceThreadId = notificationThreadId(params);
    if (threadId && sourceThreadId && sourceThreadId !== threadId) {
      handleChildNotification(safeNotification);
      return;
    }
    if (method === "turn/started") {
      if (!isRootThreadNotification(params)) return;
      setActiveTurnId(params.turn?.id, { steerReady: true });
      emitEvent({ type: "cli_event", raw: { type: "turn_started", turn: params.turn } });
      return;
    }
    if (method === "turn/completed") {
      if (!isRootActiveTurnNotification(params)) return;
      setActiveTurnId(params.turn?.id);
      turnCompleted = true;
      stopLiveInput();
      if (params.turn?.status === "failed") {
        errorMessage = safeDiagnostic(params.turn?.error?.message || params.turn?.error || "Codex turn failed");
        failureKind = "provider_unavailable";
      }
      if (activeCompactions.size > 0) {
        const cancelled = params.turn?.status === "cancelled" || params.turn?.status === "interrupted";
        finalizeOpenCompactions(
          cancelled ? "cancelled" : "incomplete",
          cancelled ? "Compaction was interrupted." : "Compaction ended without a completion event.",
        );
      }
      const safeTurn = params.turn?.error === undefined
        ? params.turn
        : { ...params.turn, error: safeResponseError(params.turn.error) };
      emitEvent({ type: "cli_event", raw: { type: "turn_completed", turn: safeTurn } });
      resolveTurn(params.turn);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      if (!isRootActiveTurnNotification(params)) return;
      usage = usageFromTokenUsage(params.tokenUsage);
      const contextUsage = contextUsageFromTokenUsage(params.tokenUsage);
      if (contextUsage) {
        emitEvent({
          type: "context_usage",
          sdk: "codex",
          model: actualModel ? `codex:${actualModel}` : requestedReference,
          timestamp: Date.now(),
          ...(typeof params.turnId === "string" && params.turnId.length > 0
            ? { measurementId: params.turnId }
            : {}),
          ...contextUsage,
        });
      }
      return;
    }
    if (method === "model/rerouted") {
      if (!isRootActiveTurnNotification(params)) return;
      if (typeof params.toModel === "string" && params.toModel.trim().length > 0) actualModel = params.toModel;
      return;
    }
    if (method === "thread/compacted") {
      if (!isRootActiveTurnNotification(params)) return;
      handleLegacyCompaction(params);
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (!isRootActiveTurnNotification(params)) return;
      const current = agentTextByItem.get(params.itemId) || "";
      agentTextByItem.set(params.itemId, `${current}${params.delta || ""}`);
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      if (!isRootActiveTurnNotification(params)) return;
      emitEvent({ type: "assistant", message: { content: [{ type: "thinking", text: params.delta || "" }] } });
      return;
    }
    if (method === "warning" || method === "error" || method === "configWarning" || method === "guardianWarning") {
      emitEvent({
        type: "runtime_warning",
        warning_kind: method.replace(/\W+/g, "_"),
        message: safeDiagnostic(params.message || params.error || params),
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (!isRootActiveTurnNotification(params)) return;
      if (isCodexCollabItem(params.item) && normalizedCollabTool(params.item.tool) === "spawnagent") {
        handleCollabSpawn(method, params, params.item);
        return;
      }
      if (params.item?.type === "subAgentActivity") {
        handleSubAgentActivityItem(params, params.item);
        return;
      }
      if (params.item?.type === "contextCompaction") {
        handleContextCompactionItem(method, params);
        return;
      }
      const raw = mapThreadItem(method, params.item);
      if (params.item?.type === "agentMessage") {
        const text = params.item.text || agentTextByItem.get(params.item.id) || "";
        if (method === "item/completed") handleAgentText(text);
        return;
      }
      if (raw) emitEvent(normalizeCodexItemEvent(raw, codexItemContext) || raw);
    }
  }

  let client = null;
  let resumeEntry = null;
  let sessionRetained = false;
  let abortRequested = false;
  let interruptSent = false;
  let unownedChildRequestObserved = false;
  // Mutable holder so keep-alive clients can outlive this run: each run
  // installs its own notification and server-request handlers. The bridge
  // restores idle handlers once the session is no longer executing a turn.
  const notificationTarget = { handler: handleNotification };
  function handleServerRequest(request) {
    const method = typeof request?.method === "string" ? request.method : "unknown";
    // A same-batch request can arrive after turn/completed but before the
    // generate promise reaches finally. Never let that frame approve work or
    // mutate the already-final provider result.
    if (turnCompleted || abortRequested || !activeTurnId) return rejectIdleServerRequest(request);
    const params = request?.params || {};
    const sourceThreadId = notificationThreadId(params);
    const sourceTurnId = notificationTurnId(params);
    const isChildRequest = Boolean(
      threadId && sourceThreadId && sourceThreadId !== threadId,
    );
    if (!isChildRequest && sourceTurnId !== activeTurnId) {
      throw new Error(
        `Codex app-server request does not match the active turn: ${method}`,
      );
    }
    // A foreign thread id is not enough to establish child ownership. Retained
    // app-server processes can still deliver work from an earlier logical run;
    // only a live binding created by this run's root/descendant spawn records
    // may inherit configured-MCP approval.
    const currentChildBinding = isChildRequest
      ? subagentBindingsByThread.get(sourceThreadId)
      : null;
    if (isChildRequest && (
      !currentChildBinding
      || currentChildBinding.terminal
      || currentChildBinding.group.finished
      || !sourceTurnId
      || currentChildBinding.turnStates.get(sourceTurnId) !== "running"
    )) {
      unownedChildRequestObserved = true;
      throw new Error(`Unsupported Codex app-server request: ${method}`);
    }
    const approval = noToolsProbe
      ? null
      : codexConfiguredMcpApprovalResponse(request, configuredMcpServerNames);
    if (approval) return approval;
    // A child turn can fail an interaction it cannot service without
    // terminating the still-active root turn. The app-server receives the
    // JSON-RPC error and reports the child lifecycle separately.
    if (rejectUnsupportedChildServerRequest(request, method, currentChildBinding)) {
      throw new Error(`Unsupported Codex app-server request: ${method}`);
    }
    failUnsupportedServerRequest(method);
    throw new Error(`Unsupported Codex app-server request: ${method}`);
  }
  const serverRequestTarget = { handler: handleServerRequest };
  function createClient() {
    const args = options.codexAppServerArgs !== undefined
      ? options.codexAppServerArgs
      : options.codexLoadProjectDocs === true
        ? CODEX_APP_SERVER_ARGS
        : CODEX_APP_SERVER_ISOLATED_ARGS;
    return makeClient({
      command: options.codexAppServerCommand,
      args,
      cwd: options.cwd,
      env: options.codexAppServerEnv,
      redactionValues: sensitiveValues,
      onNotification: (notification) => notificationTarget.handler(
        sanitizeCodexNotification(notification, sensitiveValues),
      ),
      onServerRequest: (request) => serverRequestTarget.handler(request),
    });
  }

  async function initializeClient(nextClient) {
    const brand = options.toolContext?.runtimeBrand ?? readRuntimeBrand();
    await nextClient.request("initialize", {
      clientInfo: { name: brand.clientInfoName, title: brand.clientInfoTitle, version: "0" },
      capabilities: { experimentalApi: true },
    });
    assertNoUnsupportedServerRequest();
  }

  async function requestThreadStart(params) {
    const policy = threadStartPolicy(systemPrompt, options);
    const startedAt = Date.now();
    let lastError = null;
    for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
      if (!client) {
        client = createClient();
        await initializeClient(client);
      }
      try {
        const thread = await client.request("thread/start", params, { timeoutMs: policy.timeoutMs });
        assertNoUnsupportedServerRequest();
        codexDiagnostics = {
          ...withoutCodexRequestErrorDiagnostics(codexDiagnostics),
          codex_thread_start_attempts: attempt,
          codex_thread_start_timeout_ms: policy.timeoutMs,
          codex_thread_start_duration_ms: Date.now() - startedAt,
          ...(attempt > 1 ? { codex_thread_start_retried: true } : {}),
        };
        return thread;
      } catch (err) {
        lastError = err;
        codexDiagnostics = {
          ...codexDiagnostics,
          ...codexErrorDiagnostics(err, sensitiveValues),
          codex_thread_start_attempts: attempt,
          codex_thread_start_timeout_ms: policy.timeoutMs,
          codex_thread_start_duration_ms: Date.now() - startedAt,
          ...(attempt > 1 ? { codex_thread_start_retried: true } : {}),
        };
        if (!isCodexRequestTimeout(err, "thread/start") || attempt >= policy.attempts || options.abortSignal?.aborted) {
          throw err;
        }
        emitEvent({
          type: "runtime_warning",
          warning_kind: "codex_thread_start_retry",
          message: `Codex app-server thread/start timed out after ${policy.timeoutMs}ms; retrying with a fresh app-server.`,
        });
        await closeCodexClient(client);
        client = null;
        await delay(policy.backoffMs, options.abortSignal);
      }
    }
    throw lastError || new Error("codex app-server request timed out: thread/start");
  }

  const abortHandler = () => {
    abortRequested = true;
    stopLiveInput();
    if (threadId && activeTurnId && !interruptSent) {
      interruptSent = true;
      client?.request("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
    }
    // Resumed sessions stay alive across an interrupt; only fresh runs tear
    // down their subprocess on abort.
    if (!resumeEntry) void closeCodexClient(client);
  };

  async function steerLiveInput() {
    if (!options.liveInput) return;
    const iterator = options.liveInput[Symbol.asyncIterator]();
    try {
      while (!turnCompleted && !liveInputStopped) {
        const next = await Promise.race([
          iterator.next(),
          liveInputStop.then(() => ({ done: true, value: undefined })),
        ]);
        if (next.done || turnCompleted || liveInputStopped) break;
        const message = next.value;
        if (!threadId || !activeTurnId || !turnReadyResolved) {
          await Promise.race([
            turnReady,
            liveInputStop,
          ]);
          if (turnCompleted || liveInputStopped || !turnReadyResolved) break;
        }
        const input = userTextInput(formatLiveInputGuidance(message.body, options.prompts));
        try {
          const response = await client.request("turn/steer", {
            threadId,
            expectedTurnId: activeTurnId,
            input,
          });
          activeTurnId = response?.turnId || activeTurnId;
          invokeLiveInputCallback(message, "acknowledge");
        } catch (err) {
          const providerError = err?.responseError;
          if (isNoActiveTurnToSteer(providerError || err)) {
            await Promise.race([
              turnReady,
              liveInputStop,
            ]);
            if (turnCompleted || liveInputStopped) break;
            try {
              const response = await client.request("turn/steer", {
                threadId,
                expectedTurnId: activeTurnId,
                input,
              });
              activeTurnId = response?.turnId || activeTurnId;
              invokeLiveInputCallback(message, "acknowledge");
              continue;
            } catch (retryErr) {
              invokeLiveInputCallback(message, "reject", retryErr);
              const retryProviderError = retryErr?.responseError
                ? safeResponseError(retryErr.responseError)
                : null;
              emitEvent({
                type: "runtime_warning",
                warning_kind: isActiveTurnNotSteerable(retryProviderError) ? "active_turn_not_steerable" : "live_input_rejected",
                message: safeDiagnostic(codexErrorMessage(retryProviderError || retryErr)),
              });
              // Preserve FIFO fallback: once one message is rejected, later
              // entries must not overtake it inside this provider attempt.
              break;
            }
          }
          invokeLiveInputCallback(message, "reject", err);
          emitEvent({
            type: "runtime_warning",
            warning_kind: isActiveTurnNotSteerable(providerError) ? "active_turn_not_steerable" : "live_input_rejected",
            message: safeDiagnostic(codexErrorMessage(
              providerError ? safeResponseError(providerError) : err,
            )),
          });
          break;
        }
      }
    } finally {
      if (typeof iterator.return === "function") {
        try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* best-effort */ }
      }
    }
  }

  function sessionUnavailableResult(kind, error, codexErrorCode) {
    const subagentCapabilities = observedSubagentCapabilities();
    return {
      text: null,
      structuredResult: undefined,
      structuredResultSource: null,
      events: [],
      usage: {},
      durationMs: Date.now() - start,
      numTurns: 0,
      model: resolved?.reference || `codex:${resolved?.model || ""}`,
      effort: options.effort || null,
      sdk: "codex",
      providerSessionId: resumeSessionId,
      provider_session_id: resumeSessionId,
      cancelled: false,
      error,
      failureKind: kind,
      diagnostics: { codex_error_code: codexErrorCode },
      capabilitiesUsed: buildCapabilitiesUsed({
        promptCacheActive: null,
        thinkingEnabled: null,
        structuredOutputEnforced: !!options.outputSchema,
        subagentInvoked: subagentCapabilities.invoked,
        mcpServersUsed: sentMcpServerNames,
        nativeSubagentsUsed: subagentCapabilities.names,
        toolCompactionApplied: false,
        contextCompactionApplied: null,
      }),
    };
  }

  if (
    Array.isArray(options.nativeSubagents?.teammates)
    && options.nativeSubagents.teammates.length > 0
  ) {
    return sessionUnavailableResult(
      "skipped_capability_mismatch",
      "Direct Codex owns its native collaboration agents and does not accept mono-agent nativeSubagents teammate/profile definitions. Remove nativeSubagents, use codexLoadProjectDocs for repository instructions, or route this run to Claude.",
      "codex_native_subagent_definitions_unsupported",
    );
  }

  const mcpServerNameProblem = codexMcpServerNameProblem(invalidMcpServerNames);
  if (mcpServerNameProblem) {
    return sessionUnavailableResult(
      "skipped_capability_mismatch",
      mcpServerNameProblem,
      "codex_mcp_server_name_invalid",
    );
  }

  if (resolveSandboxPolicy(options.toolContext, options.sandboxPolicy) !== undefined) {
    return sessionUnavailableResult(
      "skipped_capability_mismatch",
      "Direct Codex cannot enforce mono-agent's native srt sandbox scopes. Remove the mono-agent sandbox policy or use a Pi runtime for exact readableRoots, writableRoots, denyWrite, and network rules.",
      "codex_sandbox_policy_unsupported",
    );
  }

  const toolPolicyProblem = codexToolPolicyProblem(options);
  if (toolPolicyProblem) {
    return sessionUnavailableResult(
      "skipped_capability_mismatch",
      toolPolicyProblem,
      "codex_tool_policy_unsupported",
    );
  }

  if (resumeSessionId) {
    // Await-free busy claim (get -> busy check -> set-busy in one span). A miss
    // fails fast: the host sent no conversation history for a resume, so silently
    // starting a fresh thread would lose context. A busy entry is executing a
    // turn already.
    const claimed = codexLiveness.claim(resumeSessionId);
    if (!claimed.ok) {
      // @ts-check does not narrow the ClaimResult union on `!claimed.ok`,
      // though the loser branch always carries `reason`.
      return /** @type {{reason: string}} */ (claimed).reason === "missing"
        ? sessionUnavailableResult(
          "session_not_found",
          `Codex session ${resumeSessionId} is not live; cannot resume`,
          "codex_session_not_found",
        )
        : sessionUnavailableResult(
          "session_busy",
          `Codex session ${resumeSessionId} is already executing a turn`,
          "codex_session_busy",
        );
    }
    resumeEntry = claimed.entry;
    if (resumeEntry.mcpConfigFingerprint !== mcpConfigFingerprint) {
      await codexSessions.dispose(resumeSessionId);
      return sessionUnavailableResult(
        "session_not_found",
        `Codex session ${resumeSessionId} was invalidated because its MCP configuration changed; retry without the provider session to replay history`,
        "codex_session_config_mismatch",
      );
    }
    // A retained thread keeps the MCP configuration sent with thread/start.
    sentMcpServerNames = noToolsProbe ? [] : configuredMcpServerNameList;
  }

  try {
    if (resumeEntry) {
      client = resumeEntry.client;
      threadId = resumeEntry.threadId;
      resumeEntry.notificationTarget.handler = handleNotification;
      resumeEntry.serverRequestTarget.handler = handleServerRequest;
      // Keep the idle TTL from firing while the turn is in flight.
      codexSessions.touch(resumeSessionId, { idleTimeoutMs: sessionTtlMs });
    } else {
      client = createClient();
    }
    if (options.abortSignal) {
      if (options.abortSignal.aborted) abortHandler();
      else options.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
    if (!resumeEntry) await initializeClient(client);
    const fastMode = codexModelSupportsFastMode(resolved.model) && normalizeFastMode(options.fastMode, true);
    if (!resumeEntry) {
      const mcpServers = noToolsProbe ? {} : configuredMcpServers;
      // Incrementally assembled config handed across the codex app-server
      // boundary; the reasoning fields below are attached conditionally.
      const config = /** @type {any} */ ({
        ...(fastMode ? { service_tier: "fast" } : {}),
        features: { fast_mode: fastMode },
        ...(noToolsProbe
          ? { mcp_servers: {} }
          : Object.keys(mcpServers).length
            ? { mcp_servers: mcpServers }
            : {}),
      });
      if (normalizedEffort) {
        config.model_reasoning_effort = normalizedEffort;
        if (normalizedEffort !== "none") config.model_reasoning_summary = "auto";
      }
      sentMcpServerNames = Object.keys(mcpServers);
      // The codex app-server protocol exposes thread/start but no thread/load
      // primitive, so cold continuations always start a fresh thread; a
      // thread is only resumable while its subprocess stays live in
      // codexSessions (options.sessionKeepAlive + options.sessionId).
      const thread = await requestThreadStart({
        model: resolved.model,
        modelProvider: "openai",
        ...(fastMode ? { serviceTier: "fast" } : {}),
        cwd: options.cwd || process.cwd(),
        approvalPolicy: approvalPolicyForRun(options),
        sandbox: sandboxForRun(options),
        config,
        serviceName: (options.toolContext?.runtimeBrand ?? readRuntimeBrand()).serviceName,
        developerInstructions: systemPrompt,
        ephemeral: true,
        sessionStartSource: "startup",
        ...(noToolsProbe ? { environments: [], dynamicTools: [], selectedCapabilityRoots: [] } : {}),
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });
      threadId = thread?.thread?.id;
      if (!threadId) throw new Error("Codex app-server did not return a thread id");
    }

    const steerTask = steerLiveInput();
    steerTask.catch((err) => {
      emitEvent({
        type: "runtime_warning",
        warning_kind: "live_input_failed",
        message: safeDiagnostic(err?.message || err),
      });
    });
    const turnParams = {
      threadId,
      input: userTextInput(prompt),
      cwd: options.cwd || process.cwd(),
      approvalPolicy: approvalPolicyForRun(options),
      sandboxPolicy: sandboxPolicyForRun(options),
      model: resolved.model,
      ...(fastMode ? { serviceTier: "fast" } : {}),
      effort: normalizedEffort,
      summary: normalizedEffort && normalizedEffort !== "none" ? "auto" : "none",
      outputSchema: options.outputSchema,
    };
    const turn = await client.request("turn/start", turnParams);
    assertNoUnsupportedServerRequest();
    setActiveTurnId(turn?.turn?.id);

    let prematureClose = false;
    // Resumed runs watch subprocess death through the entry's mutable hook
    // instead of client.closed.then: a long-lived thread would otherwise
    // accumulate one permanent .then closure per turn.
    const closedSignal = resumeEntry
      ? new Promise((resolve) => { resumeEntry.closedTarget.handler = resolve; })
      : client.closed;
    // Resumed runs never close the client on abort, so the wait must also
    // resolve on the abort signal or an interrupted turn could hang forever.
    let abortRaceCleanup = () => {};
    const abortedSignal = resumeEntry && options.abortSignal
      ? new Promise((resolve) => {
        if (options.abortSignal.aborted) {
          resolve(null);
          return;
        }
        const onAbort = () => resolve(null);
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
        abortRaceCleanup = () => options.abortSignal.removeEventListener?.("abort", onAbort);
      })
      : null;
    try {
      await Promise.race([
        turnDone,
        ...(abortedSignal === null ? [] : [abortedSignal]),
        closedSignal.then((err) => {
          if (!turnCompleted) {
            prematureClose = true;
            stopLiveInput();
            throw err || new Error("codex app-server closed");
          }
          return null;
        }),
      ]);
    } catch (err) {
      if (prematureClose && !errorMessage) {
        errorMessage = safeDiagnostic(err?.message || "codex app-server stream closed before turn completed");
        failureKind = "provider_unavailable";
      } else if (!prematureClose) {
        throw err;
      }
    } finally {
      abortRaceCleanup();
      stopLiveInput();
    }
    turnCompleted = true;
    await steerTask;

    const text = texts[texts.length - 1] || "";
    let codexErrorCode = prematureClose ? "codex_app_server_closed" : null;
    if (!errorMessage && !text.trim()) {
      errorMessage = "codex app-server completed without final output";
      failureKind = "provider_unavailable";
      codexErrorCode = codexErrorCode || "codex_app_server_no_output";
    }
    // The app-server owns native descendants. If a known descendant remains
    // open, or an unowned/stale descendant requests work, retaining this
    // process would let old execution cross into another logical turn. Close
    // the provider session after the unaffected root finishes; the host can
    // replay history on a fresh process.
    const hasUnfinishedProviderDescendants = [...subagentGroupsBySpawnId.values()]
      .some((group) => !group.finished);
    const providerSessionHasUnsafeDescendants = hasUnfinishedProviderDescendants
      || unownedChildRequestObserved;
    if (resumeEntry) {
      // A failed turn or a closed transport leaves the thread untrustworthy,
      // but an interrupt is normal steering only when no provider descendant
      // remains live.
      const aborted = !!options.abortSignal?.aborted;
      sessionRetained = !providerSessionHasUnsafeDescendants
        && ((aborted && !prematureClose) || (!errorMessage && !failureKind));
      if (sessionRetained) codexSessions.touch(resumeSessionId, { idleTimeoutMs: sessionTtlMs });
      else codexSessions.delete(resumeSessionId);
    } else if (
      keepAlive
      && threadId
      && !errorMessage
      && !failureKind
      && !options.abortSignal?.aborted
      && !providerSessionHasUnsafeDescendants
    ) {
      sessionRetained = true;
      notificationTarget.handler = noopNotificationHandler;
      serverRequestTarget.handler = rejectIdleServerRequest;
      const entry = {
        client,
        threadId,
        busy: false,
        notificationTarget,
        serverRequestTarget,
        mcpConfigFingerprint,
        closedTarget: { handler: null },
      };
      codexSessions.set(threadId, entry, { idleTimeoutMs: sessionTtlMs });
      client.closed.then(() => {
        codexSessions.delete(threadId);
        entry.closedTarget.handler?.(new Error("codex app-server closed"));
      });
    }
    const hadPartialProgress = events.length > 0 || texts.length > 0;
    const reference = requestedReference;
    const inputTokens = usage?.input_tokens ?? usage?.inputTokens ?? 0;
    const outputTokens = usage?.output_tokens ?? usage?.outputTokens ?? 0;
    const cachedTokens = usage?.cache_read_tokens ?? usage?.cachedInputTokens ?? 0;
    const cacheCreationTokens = usage?.cache_creation_tokens ?? usage?.cacheCreationTokens ?? 0;
    const billableInputTokens = Math.max(0, inputTokens - cachedTokens - cacheCreationTokens);
    const costUsd = estimateCost({
      resolveCustomPricing: options.resolveCustomPricing,
      model: reference,
      inputTokens: billableInputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens: cacheCreationTokens,
    });
    const enrichedUsage = {
      ...usage,
      input_tokens: inputTokens || null,
      output_tokens: outputTokens || null,
      cache_read_tokens: cachedTokens || null,
      cache_creation_tokens: cacheCreationTokens || null,
      cost_usd: costUsd,
    };
    const subagentCapabilities = observedSubagentCapabilities();
    return {
      text,
      structuredResult: undefined,
      structuredResultSource: null,
      events,
      usage: enrichedUsage,
      durationMs: Date.now() - start,
      numTurns: 1,
      model: reference,
      effort: options.effort || null,
      sdk: "codex",
      providerSessionId: threadId || null,
      provider_session_id: threadId || null,
      cancelled: !!options.abortSignal?.aborted,
      error: errorMessage,
      failureKind,
      diagnostics: {
        ...codexDiagnostics,
        ...(codexErrorCode ? { codex_error_code: codexErrorCode } : {}),
        ...(hadPartialProgress && failureKind === "provider_unavailable"
          ? { had_partial_progress: true }
          : {}),
      },
      capabilitiesUsed: buildCapabilitiesUsed({
        promptCacheActive: (cachedTokens || 0) > 0 || (cacheCreationTokens || 0) > 0,
        thinkingEnabled: null,
        structuredOutputEnforced: !!options.outputSchema,
        subagentInvoked: subagentCapabilities.invoked,
        mcpServersUsed: sentMcpServerNames,
        nativeSubagentsUsed: subagentCapabilities.names,
        toolCompactionApplied: false,
        contextCompactionApplied: null,
      }),
    };
  } catch (err) {
    if (resumeEntry) codexSessions.delete(resumeSessionId);
    const subagentCapabilities = observedSubagentCapabilities();
    return {
      text: texts[texts.length - 1] || null,
      structuredResult: undefined,
      structuredResultSource: null,
      events,
      usage,
      durationMs: Date.now() - start,
      numTurns: texts.length || (events.length ? 1 : 0),
      model: resolved?.reference || `codex:${resolved?.model || ""}`,
      effort: options.effort || null,
      sdk: "codex",
      providerSessionId: threadId || null,
      provider_session_id: threadId || null,
      cancelled: !!options.abortSignal?.aborted,
      error: safeDiagnostic(err?.message || err),
      failureKind: failureKind || "provider_unavailable",
      diagnostics: {
        ...codexDiagnostics,
        ...codexErrorDiagnostics(err, sensitiveValues),
        ...(events.length > 0 || texts.length > 0 ? { had_partial_progress: true } : {}),
      },
      capabilitiesUsed: buildCapabilitiesUsed({
        promptCacheActive: null,
        thinkingEnabled: null,
        structuredOutputEnforced: !!options.outputSchema,
        subagentInvoked: subagentCapabilities.invoked,
        mcpServersUsed: sentMcpServerNames,
        nativeSubagentsUsed: subagentCapabilities.names,
        toolCompactionApplied: false,
        contextCompactionApplied: null,
      }),
    };
  } finally {
    stopLiveInput();
    // The returned result is already being finalized. Park every transport
    // callback before lifecycle drains or close() so shutdown-time frames
    // cannot mutate its event array or stale per-run state.
    if (resumeEntry) {
      resumeEntry.notificationTarget.handler = noopNotificationHandler;
      resumeEntry.serverRequestTarget.handler = rejectIdleServerRequest;
      resumeEntry.closedTarget.handler = null;
    } else {
      notificationTarget.handler = noopNotificationHandler;
      serverRequestTarget.handler = rejectIdleServerRequest;
    }
    if ([...subagentGroupsBySpawnId.values()].some((group) => !group.finished)) {
      const cancelled = !!options.abortSignal?.aborted;
      const failed = Boolean(errorMessage || failureKind);
      finalizeOpenSubagents(
        cancelled ? "cancelled" : failed ? "failed" : "incomplete",
        cancelled
          ? "Parent Codex turn was cancelled before the subagent completed."
          : failed
            ? "Parent Codex turn failed before the subagent completed."
            : "Parent Codex turn ended before the subagent completed.",
      );
    }
    if (activeCompactions.size > 0) {
      const cancelled = !!options.abortSignal?.aborted;
      finalizeOpenCompactions(
        cancelled ? "cancelled" : "incomplete",
        cancelled ? "Compaction was interrupted." : "Compaction ended without a completion event.",
      );
    }
    options.abortSignal?.removeEventListener?.("abort", abortHandler);
    if (resumeEntry) {
      resumeEntry.busy = false;
    }
    if (!sessionRetained) await closeCodexClient(client);
  }
}

// CLI bridge for sdk='codex' agents that opt into execution_mode='cli'. The
// codex `app-server` is more capable than `codex exec` (better event
// streaming, MCP support), so this is the default CLI path for Codex.
export const codexAppRuntimeBridge = {
  id: "codex-app",
  kind: "codex-app",
  capabilities: CODEX_APP_CAPABILITIES,
  supports: (ref, options) => ref?.sdk === "codex" && options?.executionMode === "cli",
  execute: generateCodexAppResponse,
};
