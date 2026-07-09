import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { formatLiveInputGuidance } from "../live-input-prompt.js";
import { estimateCost } from "../cost.js";
import { modelWithContextWindow } from "../runtime/context-windows.js";
import { runtimeCapabilities } from "../runtime/capabilities.js";
import { buildCapabilitiesUsed, toolCompactionAppliedFromWarnings } from "../runtime/capabilities-used.js";
import { MAX_TOOL_RESULT_BYTES, summarisePayload } from "../../agent/tool-bloat.js";
import { normalizeMcpToolParams } from "../../agent/tools/pi-bridge.js";
import { deprecatedSettingsWarning } from "../../agent/compaction.js";
import { readRuntimeBrand } from "../../agent/tools/shared/runtime-context.js";
import { createApprovalManager } from "../../agent/approval.js";
import {
  claudeNativeAgentDefinitions,
  resolveClaudeAllowedTools,
} from "./claude-subagents.js";

function thinkingForEffort(effort) {
  if (effort === "low") return { thinking: { type: "disabled" } };
  return { thinking: { type: "adaptive" }, effort };
}

function extractText(event) {
  if (event.type !== "assistant" || !event.message?.content) return "";
  let out = "";
  for (const block of event.message.content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

function assistantToolNames(event) {
  if (event.type !== "assistant" || !Array.isArray(event.message?.content)) return [];
  return event.message.content
    .filter((block) => block?.type === "tool_use" && block.name)
    .map((block) => block.name);
}

function extractResultText(event) {
  if (event.type !== "result") return "";
  if (typeof event.result === "string") return event.result;
  if (event.result != null) return JSON.stringify(event.result);
  if (typeof event.final_output === "string") return event.final_output;
  if (event.final_output != null) return JSON.stringify(event.final_output);
  return "";
}

function stringifyError(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.message === "string") return value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function humanizeSubtype(subtype) {
  return String(subtype || "").replace(/^error_/, "").replace(/_/g, " ").trim();
}

function resultEventError(event) {
  if (event.type !== "result") return null;
  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  const errors = Array.isArray(event.errors) ? event.errors.filter(Boolean) : [];
  const explicit = stringifyError(event.error) || stringifyError(event.message);
  if (!event.is_error && !subtype.startsWith("error_") && errors.length === 0 && !explicit) return null;

  const detail = explicit || errors.map(stringifyError).filter(Boolean).join("; ");
  const label = humanizeSubtype(subtype);
  const message = subtype === "error_max_turns"
    ? "Claude stopped before final output: max turns reached"
    : `Claude result error${label ? ` (${label})` : ""}${detail ? `: ${detail}` : ""}`;
  return {
    message,
    failureKind: subtype === "error_max_turns"
      ? "usage_limit"
      : subtype === "error_max_structured_output_retries"
        ? "invalid_result"
        : "provider_unavailable",
  };
}

function makeRuntimeWarning(message, warningKind = "claude_post_success_error") {
  return {
    warning_kind: warningKind,
    message,
  };
}

function extractStructuredOutput(event) {
  if (event?.type === "result" && Object.prototype.hasOwnProperty.call(event, "structured_output")) {
    return event.structured_output;
  }
  return undefined;
}

function structuredOutputEvent(value) {
  return {
    type: "structured_output",
    source: "claude_sdk_output_format",
    value,
  };
}

function structuredOutputToolUses(event) {
  if (event?.type !== "assistant" || !Array.isArray(event.message?.content)) return [];
  return event.message.content
    .filter((block) => (
      block?.type === "tool_use"
      && block?.name === "StructuredOutput"
      && block.input !== undefined
      && (block.id || block.tool_use_id)
    ))
    .map((block) => ({
      id: block.id || block.tool_use_id,
      input: block.input,
    }));
}

function acceptedStructuredOutputValues(event, pendingStructuredOutputById) {
  if (event?.type !== "user" || !Array.isArray(event.message?.content)) return [];
  const values = [];
  for (const block of event.message.content) {
    if (block?.type !== "tool_result") continue;
    const id = block.tool_use_id || block.toolUseId;
    if (!id || !pendingStructuredOutputById.has(id)) continue;
    const value = pendingStructuredOutputById.get(id);
    pendingStructuredOutputById.delete(id);
    if (block.is_error === true) continue;
    values.push(value);
  }
  return values;
}

function pickSessionId(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function sessionIdFromEvent(event) {
  return pickSessionId(event?.session_id, event?.sessionId);
}

function lastTextSnippet(texts, limit = 200) {
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const text = texts[i];
    if (typeof text === "string" && text.trim()) {
      const trimmed = text.trim();
      return trimmed.length > limit ? trimmed.slice(-limit) : trimmed;
    }
  }
  return null;
}

function buildClaudeErrorDetails({
  event = null,
  subtype = null,
  providerSessionId = null,
  assistantTexts = [],
  lastToolName = null,
  toolResultsSeen = 0,
  numTurns = 0,
  lastStructuredOutputRejection = null,
}) {
  const resolvedSubtype = subtype || event?.subtype || event?.type || null;
  const turnCount = Number(event?.num_turns ?? numTurns) || 0;
  const excerpt = lastTextSnippet(assistantTexts);
  return {
    claude_error_subtype: resolvedSubtype,
    last_text_excerpt: excerpt,
    last_tool_name: lastToolName || null,
    had_partial_progress: !!(excerpt || lastToolName || toolResultsSeen > 0),
    tool_results_seen: toolResultsSeen,
    turn_count: turnCount,
    max_turns_hit: resolvedSubtype === "error_max_turns",
    structured_output_retry_exhausted: resolvedSubtype === "error_max_structured_output_retries",
    last_structured_output_rejection: lastStructuredOutputRejection || null,
    provider_session_id: providerSessionId || null,
  };
}

function toolResultText(block) {
  const content = block?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => item?.text || item?.content || "").filter(Boolean).join("\n");
  }
  if (content == null) return "";
  try { return JSON.stringify(content); } catch { return String(content); }
}

function structuredOutputRejectionFromEvent(event) {
  if (event?.type !== "user" || !Array.isArray(event.message?.content)) return null;
  for (const block of event.message.content) {
    if (block?.type === "tool_result" && block.is_error) {
      const text = toolResultText(block);
      if (/structured output|required schema|did not match schema|schema violation/i.test(text)) return text;
    }
  }
  const result = event.is_error === true ? stringifyError(event.tool_use_result) : null;
  return /structured output|required schema|did not match schema|schema violation/i.test(result) ? result : null;
}

function mergeHookMatchers(existing = {}, additions = {}) {
  const merged = {};
  for (const [name, groups] of Object.entries(existing || {})) {
    if (Array.isArray(groups)) merged[name] = [...groups];
  }
  for (const [name, groups] of Object.entries(additions || {})) {
    if (!Array.isArray(groups) || !groups.length) continue;
    merged[name] = [...(merged[name] || []), ...groups];
  }
  return merged;
}

function objectInput(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseMcpToolName(toolName) {
  const name = String(toolName || "");
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  return {
    serverName: rest.slice(0, sep),
    toolName: rest.slice(sep + 2),
  };
}

function normalizeClaudeMcpInput(input, qaOutputDir) {
  const parsed = parseMcpToolName(input?.tool_name);
  if (!parsed) return null;
  const current = objectInput(input?.tool_input);
  const normalized = normalizeMcpToolParams(parsed.serverName, parsed.toolName, current, { qaOutputDir });
  if (normalized === current) return null;
  try {
    if (JSON.stringify(normalized) === JSON.stringify(current)) return null;
  } catch {
    // Non-serializable input is unexpected, but returning an SDK override is
    // still safe when the normalizer produced a different object.
  }
  return normalized;
}

function claudeToolResponseBlocks(toolResponse) {
  if (toolResponse && typeof toolResponse === "object" && Array.isArray(toolResponse.content)) {
    return toolResponse.content;
  }
  if (typeof toolResponse === "string") return [{ type: "text", text: toolResponse }];
  if (toolResponse == null) return [];
  try {
    return [{ type: "text", text: JSON.stringify(toolResponse) }];
  } catch {
    return [{ type: "text", text: String(toolResponse) }];
  }
}

// Resolve the tool_result byte cap. Precedence is PER-GROUP (MIGRATION.md §8):
//   explicit options.toolPayloadMaxBytes
//   -> typed options.toolLimits — when this group is PRESENT it wins wholesale:
//      its toolPayloadMaxBytes is used if valid, otherwise the default; the
//      DEPRECATED settings fallback below is never consulted for this group,
//      even if toolLimits.toolPayloadMaxBytes itself is absent/invalid.
//   -> DEPRECATED options.settings.agent_tool_payload_max_bytes (usedSettings),
//      only consulted when options.toolLimits is entirely absent.
//   -> MAX_TOOL_RESULT_BYTES default.
// `usedSettings` lets the caller emit one deprecation warning per run when the
// legacy settings fallback was actually consumed.
export function toolPayloadLimit(options) {
  const explicit = Number(options.toolPayloadMaxBytes);
  if (Number.isFinite(explicit) && explicit > 0) return { bytes: Math.floor(explicit), usedSettings: false };
  if (options.toolLimits) {
    const typed = Number(options.toolLimits.toolPayloadMaxBytes);
    if (Number.isFinite(typed) && typed > 0) return { bytes: Math.floor(typed), usedSettings: false };
    return { bytes: MAX_TOOL_RESULT_BYTES, usedSettings: false };
  }
  const configured = Number(options.settings?.agent_tool_payload_max_bytes);
  if (Number.isFinite(configured) && configured > 0) return { bytes: Math.floor(configured), usedSettings: true };
  return { bytes: MAX_TOOL_RESULT_BYTES, usedSettings: false };
}

function createClaudeRuntimeHooks({
  emitEvent,
  persistArtifact,
  qaOutputDir,
  toolPayloadMaxBytes,
  onToolUse,
  onToolResult,
}) {
  return {
    PreToolUse: [{
      matcher: "*",
      hooks: [async (input) => {
        onToolUse?.(input?.tool_name);
        const updatedInput = normalizeClaudeMcpInput(input, qaOutputDir);
        if (!updatedInput) return {};
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput,
          },
        };
      }],
    }],
    PostToolUse: [{
      matcher: "*",
      hooks: [async (input, toolUseID) => {
        const toolName = input?.tool_name || "tool";
        onToolUse?.(toolName);
        onToolResult?.(toolName);
        const blocks = claudeToolResponseBlocks(input?.tool_response);
        if (!blocks.length) return {};
        const summary = summarisePayload(toolName, blocks, persistArtifact, {
          maxBytes: toolPayloadMaxBytes,
          toolUseId: toolUseID || input?.tool_use_id || input?.toolUseID || null,
        });
        if (!summary.truncated) return {};
        emitEvent({
          type: "runtime_warning",
          warning_kind: "tool_payload_truncated",
          source: "tool_bloat_guard",
          tool: toolName,
          tool_use_id: toolUseID || input?.tool_use_id || input?.toolUseID || null,
          original_bytes: summary.originalBytes,
          max_bytes: toolPayloadMaxBytes,
          saved_paths: summary.savedPaths,
        });
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            updatedMCPToolOutput: summary.rewrittenBlocks,
          },
        };
      }],
    }],
    PostToolUseFailure: [{
      matcher: "*",
      hooks: [async (input) => {
        onToolUse?.(input?.tool_name);
        return {};
      }],
    }],
  };
}

function promptStringFromMessages(messages) {
  return Array.isArray(messages)
    ? messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n")
    : String(messages || "");
}

function makeSdkUserMessage(body, sessionId, uuid = randomUUID()) {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid,
    message: {
      role: "user",
      content: body,
    },
  };
}

function createClaudeCanUseTool(approvalManager, modelName) {
  return async function canUseTool(toolName, input, context = {}) {
    const decision = await approvalManager.request({
      toolName,
      input,
      model: modelName,
      toolUseId: context?.toolUseId || context?.tool_use_id || null,
    });
    if (decision.decision === "deny") {
      return {
        behavior: "deny",
        message: `Tool ${toolName} denied by host approval gate (${decision.reason || "no reason"})`,
      };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

async function* livePromptMessages({ initialPrompt, liveInput, sessionId, prompts }) {
  yield makeSdkUserMessage(initialPrompt, sessionId);
  for await (const message of liveInput) {
    yield makeSdkUserMessage(formatLiveInputGuidance(message.body, prompts), sessionId, message.id || randomUUID());
  }
}

export async function generateClaudeResponse(systemPrompt, options) {
  const {
    messages,
    model,
    effort = "medium",
    cwd,
    mcpServers,
    allowedTools,
    disallowedTools,
    hooks,
    permissionMode = "bypassPermissions",
    maxTurns,
    abortSignal,
    onEvent = () => {},
  } = options;

  const thinkingOpts = thinkingForEffort(effort);

  const promptString = promptStringFromMessages(messages);
  const runtimeWarnings = [];
  const capturedEvents = [];
  const assistantTextFragments = [];
  const reusableProviderSessionId = pickSessionId(options.sessionId, options.providerSessionId);
  const persistArtifact = options.persistArtifact || null;
  const qaOutputDir = options.qaOutputDir || options.runArtifactDir || null;
  const { bytes: toolPayloadMaxBytes, usedSettings: toolPayloadFromSettings } = toolPayloadLimit(options);
  let providerSessionId = reusableProviderSessionId;
  let lastToolName = null;
  let toolResultsSeen = 0;

  function emitEvent(event) {
    if (!event) return;
    capturedEvents.push(event);
    onEvent(event);
  }

  // Deprecated `settings` fallback for the tool_result byte cap was consumed;
  // surface the one-per-run deprecation warning (the typed `toolLimits` object
  // is the supported path). mono-agent never passes `settings`, so this never
  // fires there.
  if (toolPayloadFromSettings) {
    const warning = deprecatedSettingsWarning(["agent_tool_payload_max_bytes"]);
    runtimeWarnings.push(warning);
    emitEvent({ type: "runtime_warning", ...warning });
  }

  function noteToolUse(toolName) {
    if (toolName) lastToolName = toolName;
  }

  function noteToolResult(toolName) {
    if (toolName) lastToolName = toolName;
    toolResultsSeen += 1;
  }

  const approvalManager = options.onToolApprovalRequest
    ? createApprovalManager({
      onToolApprovalRequest: options.onToolApprovalRequest,
      defaultRiskTier: options.approvalDefaultRiskTier,
      timeoutMs: options.approvalTimeoutMs,
      onEvent: emitEvent,
      riskTiersByTool: options.toolRiskTiers,
      alwaysAllowTools: options.approvalAlwaysAllowTools,
    })
    : null;
  // The Claude SDK invokes `canUseTool` only when permissionMode opts out of
  // bypass. When the host enabled approval gates, force the SDK out of
  // bypass; otherwise the callback would be skipped silently.
  const effectivePermissionMode = approvalManager && permissionMode === "bypassPermissions"
    ? "default"
    : permissionMode;
  const nativeAgents = claudeNativeAgentDefinitions(options.nativeSubagents);
  // `"*"` allow-all → pass `allowedTools: undefined` so the SDK uses its default
  // toolset (every tool, incl. Task — not double-added). disallowedTools still
  // flows through, so deny-wins holds under allow-all.
  const { allowAll: allowAllTools, tools: resolvedAllowedTools } = resolveClaudeAllowedTools(allowedTools, options.nativeSubagents);
  // Assembled incrementally, then handed across the SDK `query` boundary
  // (outputFormat/resume/maxTurns are attached conditionally below).
  /** @type {any} */
  const queryOptions = {
    systemPrompt,
    model: modelWithContextWindow(model.model, options.contextWindow),
    cwd,
    permissionMode: effectivePermissionMode,
    ...(effectivePermissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    allowedTools: allowAllTools ? undefined : resolvedAllowedTools,
    disallowedTools,
    mcpServers,
    ...(approvalManager ? { canUseTool: createClaudeCanUseTool(approvalManager, model.model) } : {}),
    ...(nativeAgents ? { agents: nativeAgents } : {}),
    hooks: mergeHookMatchers(hooks, createClaudeRuntimeHooks({
      emitEvent,
      persistArtifact,
      qaOutputDir,
      toolPayloadMaxBytes,
      onToolUse: noteToolUse,
      onToolResult: noteToolResult,
    })),
    ...thinkingOpts,
  };
  if (options.outputSchema) {
    queryOptions.outputFormat = {
      type: "json_schema",
      schema: options.outputSchema,
    };
  }
  if (reusableProviderSessionId) {
    queryOptions.resume = reusableProviderSessionId;
  }
  if (Number.isFinite(Number(maxTurns)) && Number(maxTurns) > 0) {
    queryOptions.maxTurns = Number(maxTurns);
  }

  const prompt = options.liveInput
    ? livePromptMessages({ initialPrompt: promptString, liveInput: options.liveInput, sessionId: reusableProviderSessionId || randomUUID(), prompts: options.prompts })
    : promptString;
  const providerRequestStartedAt = Date.now();
  emitEvent({
    type: "provider_request_started",
    sdk: "claude",
    model: model.model,
    runtime: "sdk",
    timestamp: providerRequestStartedAt,
  });
  const stream = query({ prompt: /** @type {any} */ (prompt), options: queryOptions });

  let text = "";
  let usage = {};
  let durationMs = 0;
  let numTurns = 0;
  let resultText = "";
  let cancelled = false;
  let errorMessage = null;
  let failureKind = null;
  let successfulResultSeen = false;
  let postSuccessErrorSeen = false;
  let structuredResultSource = null;
  let structuredResult = undefined;
  let errorDetails = null;
  let lastStructuredOutputRejection = null;
  const pendingStructuredOutputById = new Map();

  const rawFinalText = () => resultText || text;

  function hasUsableFinalOutput() {
    return structuredResult !== undefined || String(rawFinalText() || "").trim().length > 0;
  }

  function hasPreservableFinalOutput() {
    return successfulResultSeen ? hasUsableFinalOutput() : structuredResult !== undefined;
  }

  function preservePostSuccessError(message) {
    if (postSuccessErrorSeen) return;
    postSuccessErrorSeen = true;
    runtimeWarnings.push(makeRuntimeWarning(message));
  }

  const abortHandler = async () => {
    cancelled = true;
    if (stream.return) await stream.return();
  };
  if (abortSignal) {
    if (abortSignal.aborted) await abortHandler();
    else abortSignal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    for await (const event of stream) {
      const nextSessionId = sessionIdFromEvent(event);
      if (nextSessionId) providerSessionId = nextSessionId;
      emitEvent(event);
      if (event?.type === "tool_progress" && event.tool_name) noteToolUse(event.tool_name);
      for (const toolUse of structuredOutputToolUses(event)) {
        pendingStructuredOutputById.set(toolUse.id, toolUse.input);
      }
      const structuredOutputRejection = structuredOutputRejectionFromEvent(event);
      if (structuredOutputRejection) lastStructuredOutputRejection = structuredOutputRejection;
      for (const acceptedStructuredOutput of acceptedStructuredOutputValues(event, pendingStructuredOutputById)) {
        structuredResult = acceptedStructuredOutput;
        structuredResultSource = "StructuredOutput";
        emitEvent({
          ...structuredOutputEvent(acceptedStructuredOutput),
          source: "StructuredOutput",
        });
      }
      const eventStructuredOutput = extractStructuredOutput(event);
      if (eventStructuredOutput !== undefined) {
        structuredResult = eventStructuredOutput;
        structuredResultSource = "structured_output";
        emitEvent(structuredOutputEvent(eventStructuredOutput));
      }
      if (event.type === "assistant") {
        const delta = extractText(event);
        if (delta) assistantTextFragments.push(delta);
        text += delta;
        for (const toolName of assistantToolNames(event)) noteToolUse(toolName);
      }
      // The SDK's message union does not declare a runtime `error` event, but
      // the runtime can emit one; keep this defensive branch and cast past the
      // narrowed union.
      else if (/** @type {any} */ (event).type === "error") {
        const errorEvent = /** @type {any} */ (event);
        const message = errorEvent.error?.message || errorEvent.error || "sdk stream error";
        if (hasPreservableFinalOutput()) {
          preservePostSuccessError(`Claude SDK emitted an error after final output; preserved final result. ${message}`);
        } else {
          errorMessage = message;
          failureKind = "provider_unavailable";
          errorDetails = buildClaudeErrorDetails({
            event,
            subtype: "error",
            providerSessionId,
            assistantTexts: assistantTextFragments,
            lastToolName,
            toolResultsSeen,
            numTurns,
            lastStructuredOutputRejection,
          });
        }
        break;
      } else if (event.type === "result") {
        const resultError = resultEventError(event);
        if (resultError) {
          if (!successfulResultSeen) {
            usage = event.usage || usage;
            durationMs = event.duration_ms || durationMs;
            numTurns = event.num_turns || numTurns;
          }
          if (hasPreservableFinalOutput()) {
            preservePostSuccessError(`Claude SDK emitted an error after final output; preserved final result. ${resultError.message}`);
            successfulResultSeen = true;
          } else {
            usage = event.usage || usage;
            durationMs = event.duration_ms || durationMs;
            numTurns = event.num_turns || numTurns;
            errorMessage = resultError.message;
            failureKind = resultError.failureKind;
            if (failureKind === "invalid_result") {
              runtimeWarnings.push(makeRuntimeWarning(
                resultError.message,
                `${(options.toolContext?.runtimeBrand ?? readRuntimeBrand()).schemaPrefix}_result_validation`,
              ));
            }
            errorDetails = buildClaudeErrorDetails({
              event,
              subtype: event.subtype || "result_error",
              providerSessionId,
              assistantTexts: assistantTextFragments,
              lastToolName,
              toolResultsSeen,
              numTurns,
              lastStructuredOutputRejection,
            });
          }
        } else {
          usage = event.usage || usage;
          durationMs = event.duration_ms || durationMs;
          numTurns = event.num_turns || numTurns;
          resultText = extractResultText(event) || resultText;
          successfulResultSeen = true;
        }
        if (options.liveInput) break;
      }
      if (cancelled) break;
    }
  } catch (err) {
    if (!cancelled) {
      const message = err?.message || String(err);
      if (successfulResultSeen && hasUsableFinalOutput()) {
        preservePostSuccessError(`Claude SDK stream failed after final output; preserved final result. ${message}`);
      } else {
        errorMessage = message;
        failureKind = "provider_unavailable";
        errorDetails = buildClaudeErrorDetails({
          subtype: "exception",
          providerSessionId,
          assistantTexts: assistantTextFragments,
          lastToolName,
          toolResultsSeen,
          numTurns,
          lastStructuredOutputRejection,
        });
      }
    }
  } finally {
    if (abortSignal) abortSignal.removeEventListener?.("abort", abortHandler);
  }

  const reference = model.reference || `claude:${model.model}`;
  const inputTokens = usage?.input_tokens ?? usage?.inputTokens ?? 0;
  const outputTokens = usage?.output_tokens ?? usage?.outputTokens ?? 0;
  const cachedTokens = usage?.cache_read_input_tokens ?? usage?.cache_read_tokens ?? 0;
  const cacheCreationTokens = usage?.cache_creation_input_tokens ?? usage?.cache_creation_tokens ?? 0;
  const costUsd = estimateCost({
    resolveCustomPricing: options.resolveCustomPricing,
    model: reference,
    inputTokens,
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

  emitEvent({
    type: "provider_request_completed",
    sdk: "claude",
    model: model.model,
    runtime: "sdk",
    timestamp: Date.now(),
    durationMs: Date.now() - providerRequestStartedAt,
    failureKind,
    cancelled,
  });
  if (cachedTokens > 0) {
    emitEvent({ type: "cache_hit", sdk: "claude", model: model.model, tokens: cachedTokens, source: "anthropic_prompt_cache" });
  }
  if (cacheCreationTokens > 0) {
    emitEvent({ type: "cache_miss", sdk: "claude", model: model.model, tokens: cacheCreationTokens, source: "anthropic_prompt_cache" });
  }
  emitEvent({
    type: "cost_accumulated",
    sdk: "claude",
    model: model.model,
    cumulativeUsd: costUsd ?? 0,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cacheReadTokens: cachedTokens,
      cacheCreationTokens,
    },
  });

  const configuredSubagents = Array.isArray(options.nativeSubagents?.teammates)
    ? options.nativeSubagents.teammates.map((entry) => entry?.name).filter(Boolean)
    : [];
  const capabilitiesUsed = buildCapabilitiesUsed({
    promptCacheActive: cachedTokens > 0 || cacheCreationTokens > 0,
    thinkingEnabled: effort !== "low",
    structuredOutputEnforced: !!options.outputSchema,
    // Claude SDK doesn't surface a per-call "subagent was invoked" signal,
    // so we report null when subagents were configured (unknown) and false
    // when none were configured (definitely not).
    subagentInvoked: configuredSubagents.length > 0 ? null : false,
    mcpServersUsed: Object.keys(mcpServers || {}),
    nativeSubagentsUsed: configuredSubagents,
    toolCompactionApplied: toolCompactionAppliedFromWarnings(runtimeWarnings),
    contextCompactionApplied: null, // Claude SDK doesn't use the runtime compaction layer
  });
  emitEvent({ type: "capabilities_resolved", sdk: "claude", model: model.model, capabilitiesUsed });

  return {
    text: rawFinalText(),
    structuredResult,
    structuredResultSource,
    events: capturedEvents,
    usage: enrichedUsage,
    durationMs,
    numTurns,
    model: model.model,
    effort,
    sdk: "claude",
    cancelled,
    error: errorMessage,
    errorDetails,
    failureKind,
    providerSessionId,
    runtimeWarnings,
    capabilitiesUsed,
  };
}

export const claudeSdkBackend = {
  kind: "claude",
  capabilities: runtimeCapabilities("claude"),
  execute: generateClaudeResponse,
};

export const claudeRuntimeBridge = {
  id: "claude",
  kind: "claude",
  capabilities: runtimeCapabilities("claude"),
  supports: (ref) => ref?.sdk === "claude",
  execute: generateClaudeResponse,
};
