// @ts-check

import { isAbsolute } from "node:path";
import { runtimeCapabilities } from "../runtime/capabilities.js";
import { resolveSandboxPolicy } from "../../agent/tools/shared/tool-context.js";
import {
  AcpClientError,
  connectAcpProfile,
  decodeAcpProviderSessionId,
  encodeAcpProviderSessionId,
} from "./acp-client.js";

/** @param {any} callback @param {any} event */
function emit(callback, event) {
  try { callback?.(event); } catch { /* observers cannot break a provider turn */ }
}

/** @param {any} value */
function jsonSafe(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

/** @param {any} content @returns {string} */
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** @param {any} block @param {any} promptCapabilities */
function normalizePromptBlock(block, promptCapabilities) {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new AcpClientError("invalid_request", "ACP prompt content blocks must be objects.");
  }
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  // Resource links are ACP baseline content and must survive normalization.
  if (block.type === "resource_link"
    && typeof block.uri === "string"
    && typeof block.name === "string") {
    return jsonSafe(block);
  }
  if (block.type === "image" && promptCapabilities?.image === true) return jsonSafe(block);
  if (block.type === "audio" && promptCapabilities?.audio === true) return jsonSafe(block);
  if (block.type === "resource" && promptCapabilities?.embeddedContext === true) return jsonSafe(block);
  throw new AcpClientError("capability_missing", `ACP agent cannot accept prompt content type '${block.type || "unknown"}'.`);
}

/**
 * Convert runtime history to one ACP user prompt. A fresh ACP session has no
 * protocol method for importing arbitrary prior assistant turns, so the
 * client-owned path sends them as a labelled transcript while preserving
 * baseline resource_link blocks as real blocks. A resumed session sends only
 * the latest user content because the agent already owns prior history.
 * @param {string} systemPrompt
 * @param {any[]} messages
 * @param {{includeHistory: boolean, includeSystem: boolean, promptCapabilities: any}} options
 */
function runtimePrompt(systemPrompt, messages, options) {
  const source = Array.isArray(messages) ? messages : [];
  const selected = options.includeHistory
    ? source
    : (() => {
        for (let index = source.length - 1; index >= 0; index -= 1) {
          if (source[index]?.role === "user") return [source[index]];
        }
        return source.length > 0 ? [source[source.length - 1]] : [];
      })();
  /** @type {any[]} */
  const blocks = [];
  if (options.includeSystem && systemPrompt.trim()) {
    blocks.push({ type: "text", text: `[System]\n${systemPrompt}` });
  }

  selected.forEach((message, messageIndex) => {
    const role = typeof message?.role === "string" ? message.role : "user";
    const content = message?.content;
    if (Array.isArray(content)) {
      let labelled = false;
      for (const block of content) {
        const normalized = normalizePromptBlock(block, options.promptCapabilities);
        if (normalized.type === "text") {
          blocks.push({
            ...normalized,
            text: `${labelled ? "" : `[${role}]\n`}${normalized.text}`,
          });
          labelled = true;
        } else {
          blocks.push(normalized);
        }
      }
      if (content.length === 0) blocks.push({ type: "text", text: `[${role}]\n` });
      return;
    }
    const text = textFromContent(content);
    if (text || messageIndex === selected.length - 1) {
      blocks.push({ type: "text", text: `[${role}]\n${text}` });
    }
  });
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return blocks;
}

/** @param {any} update @param {any} state */
function normalizeUpdate(update, state) {
  const raw = {
    type: "acp_session_update",
    update: jsonSafe(update.update),
  };
  const body = update.update || {};
  /** @type {any[]} */
  const events = [raw];
  switch (body.sessionUpdate) {
    case "agent_message_chunk": {
      const content = body.content;
      if (content?.type === "text" && typeof content.text === "string") state.text.push(content.text);
      events.push({ type: "assistant", message: { content: [jsonSafe(content)] } });
      break;
    }
    case "agent_thought_chunk": {
      const content = body.content;
      if (content?.type === "text" && typeof content.text === "string") state.thinking.push(content.text);
      events.push({
        type: "assistant",
        message: { content: [{ type: "thinking", text: content?.type === "text" ? content.text : "" }] },
      });
      break;
    }
    case "tool_call":
      events.push({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: body.toolCallId,
            name: body.name || body.title || "acp_tool",
            input: jsonSafe(body.rawInput ?? {}),
          }],
        },
      });
      break;
    case "tool_call_update":
      if (["completed", "failed"].includes(body.status)) {
        events.push({
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: body.toolCallId,
              content: typeof body.rawOutput === "string"
                ? body.rawOutput
                : JSON.stringify(jsonSafe(body.rawOutput ?? body.content ?? "")),
              is_error: body.status === "failed",
            }],
          },
        });
      }
      break;
    case "usage_update":
      state.usage = {
        totalTokens: Number(body.used) || 0,
        contextWindow: Number(body.size) || 0,
        cost: body.cost || null,
      };
      events.push({
        type: "context_usage",
        model: state.model,
        source: "acp",
        context: { used: Number(body.used) || 0, window: Number(body.size) || 0 },
        cost: body.cost || null,
      });
      break;
    case "plan":
    case "plan_update":
    case "plan_removed":
      events.push({ type: "plan", source: "acp", update: jsonSafe(body) });
      break;
    default:
      break;
  }
  return events;
}

/** @param {any} descriptor @param {any} req */
function workspaceFor(descriptor, req) {
  if (descriptor.workspaceOwner === "agent") return descriptor.workspacePath;
  const cwd = req.cwd || descriptor.workspacePath || descriptor.cwd || process.cwd();
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new AcpClientError("invalid_request", "ACP runtime cwd must be absolute.");
  }
  return cwd;
}

/** @param {any} descriptor */
function sessionConfig(descriptor) {
  const config = descriptor.sessionConfig || {};
  return {
    additionalDirectories: [...(config.additionalDirectories || [])],
    mcpServers: descriptor.mcpOwner === "agent" ? [] : [...(config.mcpServers || [])],
  };
}

/** @param {any} connection @param {string} sessionId @param {any} setupResponse @param {any} descriptor */
async function applyClientConfiguration(connection, sessionId, setupResponse, descriptor) {
  if (descriptor.configurationOwner === "agent") return { modeApplied: false, configOptionsApplied: [] };
  const config = descriptor.sessionConfig || {};
  let modes = setupResponse?.modes || null;
  let configOptions = Array.isArray(setupResponse?.configOptions) ? setupResponse.configOptions : [];
  let modeApplied = false;
  const applied = [];
  if (config.modeId !== undefined) {
    const available = modes?.availableModes?.some((mode) => mode?.id === config.modeId) === true;
    if (!available) throw new AcpClientError("capability_missing", "Configured ACP session mode was not advertised.");
    await connection.setSessionMode(sessionId, config.modeId);
    modeApplied = true;
  }
  for (const [configId, value] of Object.entries(config.configOptions || {})) {
    const option = configOptions.find((candidate) => candidate?.id === configId);
    if (!option) throw new AcpClientError("capability_missing", "Configured ACP session option was not advertised.");
    if (option.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new AcpClientError("invalid_profile", "ACP boolean config option requires a boolean value.");
      }
    } else {
      if (typeof value !== "string" || !selectValues(option.options).includes(value)) {
        throw new AcpClientError("invalid_profile", "ACP select config option value was not advertised.");
      }
    }
    const response = await connection.setSessionConfigOption(sessionId, configId, value);
    configOptions = Array.isArray(response?.configOptions) ? response.configOptions : configOptions;
    applied.push(configId);
  }
  return { modeApplied, configOptionsApplied: applied };
}

/** @param {any[]} options */
function selectValues(options) {
  if (!Array.isArray(options)) return [];
  const values = [];
  for (const item of options) {
    if (typeof item?.value === "string") values.push(item.value);
    if (Array.isArray(item?.options)) values.push(...selectValues(item.options));
  }
  return values;
}

/** @param {any} connection @param {any} descriptor @param {any} req @param {string} profileId @param {(notification:any)=>void} onUpdate */
async function openSession(connection, descriptor, req, profileId, onUpdate) {
  const cwd = workspaceFor(descriptor, req);
  const config = sessionConfig(descriptor);
  const baseRequest = { cwd, ...config };
  if (!req.providerSessionId) {
    const response = await connection.newSession(baseRequest);
    return { sessionId: response.sessionId, response, resumed: false, resumeMethod: null };
  }
  const decoded = decodeAcpProviderSessionId(req.providerSessionId);
  if (decoded.profileId !== profileId) {
    throw new AcpClientError("invalid_session_id", "ACP provider session belongs to a different profile.");
  }
  const remove = connection.onSessionUpdate(decoded.sessionId, onUpdate);
  try {
    const strategy = descriptor.sessionConfig?.resumeStrategy || "auto";
    if (strategy === "resume" || (strategy === "auto" && connection.hasCapability("resume"))) {
      if (!connection.hasCapability("resume")) {
        throw new AcpClientError("capability_missing", "ACP agent did not advertise session/resume.");
      }
      const response = await connection.resumeSession({ sessionId: decoded.sessionId, ...baseRequest });
      return { sessionId: decoded.sessionId, response, resumed: true, resumeMethod: "resume" };
    }
    if (strategy === "load" || (strategy === "auto" && connection.hasCapability("load"))) {
      if (!connection.hasCapability("load")) {
        throw new AcpClientError("capability_missing", "ACP agent did not advertise session/load.");
      }
      const response = await connection.loadSession({ sessionId: decoded.sessionId, ...baseRequest });
      return { sessionId: decoded.sessionId, response, resumed: true, resumeMethod: "load" };
    }
    if (strategy === "auto") {
      const response = await connection.newSession(baseRequest);
      return {
        sessionId: response.sessionId,
        response,
        resumed: false,
        resumeMethod: "new_fallback",
      };
    }
    throw new AcpClientError("invalid_profile", "Invalid ACP resume strategy.");
  } finally {
    remove();
  }
}

/** @param {unknown} error @param {boolean} aborted */
function failureFor(error, aborted) {
  const coded = /** @type {any} */ (error);
  if (aborted || coded?.code === "cancelled") return { cancelled: true, failureKind: null, message: null };
  if (coded?.code === "timeout") return { cancelled: false, failureKind: "timeout", message: coded.message };
  if (coded?.code === "spawn") return { cancelled: false, failureKind: "spawn", message: coded.message };
  return {
    cancelled: false,
    failureKind: "provider_protocol",
    message: error instanceof Error ? error.message : "ACP provider protocol failed.",
  };
}

/**
 * Runtime bridge for one ACP v1 profile turn.
 * @param {string} systemPrompt
 * @param {any} req
 */
export async function generateAcpResponse(systemPrompt, req) {
  const start = Date.now();
  const profileId = req?.model?.model;
  const reference = req?.model?.reference || `acp:${profileId || "unknown"}`;
  const events = [];
  const state = { text: [], thinking: [], model: reference, usage: null };
  const onEvent = req?.onEvent;
  const capture = (event) => {
    events.push(event);
    emit(onEvent, event);
  };
  capture({ type: "provider_request_started", sdk: "acp", model: reference, runtime: "acp-stdio", timestamp: start });
  let connection;
  let sessionId = null;
  let providerSessionId = req?.providerSessionId || null;
  let setup = null;
  let configuration = { modeApplied: false, configOptionsApplied: [] };
  try {
    connection = await connectAcpProfile(profileId, {
      resolveAcpProfile: req.resolveAcpProfile,
      onAcpInteractionRequest: req.onAcpInteractionRequest,
      sandbox: req.toolContext?.sandbox || req.sandbox,
      sandboxPolicy: resolveSandboxPolicy(req.toolContext, req.sandboxPolicy),
      sandboxEngine: req.sandboxEngine || req.toolContext?.sandboxEngine,
      cwd: req.cwd,
      signal: req.abortSignal,
      context: { operation: "run", model: reference },
      operation: "run",
    });
    capture({
      type: "capabilities_resolved",
      sdk: "acp",
      model: reference,
      capabilitiesUsed: {
        protocol_version: connection.initializeResult.protocolVersion,
        agent_capabilities: jsonSafe(connection.initializeResult.agentCapabilities || {}),
      },
    });
    const onUpdate = (notification) => {
      for (const event of normalizeUpdate(notification, state)) capture(event);
    };
    setup = await openSession(connection, connection.descriptor, req, profileId, onUpdate);
    sessionId = setup.sessionId;
    providerSessionId = encodeAcpProviderSessionId(profileId, sessionId);
    configuration = await applyClientConfiguration(
      connection,
      sessionId,
      setup.response,
      connection.descriptor,
    );
    const remove = connection.onSessionUpdate(sessionId, onUpdate);
    let promptResponse;
    try {
      promptResponse = await connection.prompt(
        sessionId,
        runtimePrompt(systemPrompt, req.messages || [], {
          includeHistory: !setup.resumed,
          includeSystem: !setup.resumed && connection.descriptor.configurationOwner === "client",
          promptCapabilities: connection.initializeResult.agentCapabilities?.promptCapabilities || {},
        }),
        { signal: req.abortSignal },
      );
    } finally {
      remove();
    }
    // PromptResponse.usage is explicitly unstable in ACP 1.3.0. The stable
    // cumulative source is the latest top-level usage_update notification.
    const usage = state.usage;
    capture({
      type: "provider_request_completed",
      sdk: "acp",
      model: reference,
      runtime: "acp-stdio",
      timestamp: Date.now(),
      durationMs: Date.now() - start,
      cancelled: promptResponse.stopReason === "cancelled",
    });
    const limited = promptResponse.stopReason === "max_tokens" || promptResponse.stopReason === "max_turn_requests";
    return {
      text: state.text.join("") || null,
      thinking: state.thinking.join(""),
      events,
      usage: usage ? {
        total_tokens: usage.totalTokens || null,
        context_window: usage.contextWindow || null,
        cost: usage.cost,
      } : {},
      durationMs: Date.now() - start,
      numTurns: 1,
      model: reference,
      effort: req.effort || null,
      sdk: "acp",
      cancelled: promptResponse.stopReason === "cancelled",
      error: limited ? `ACP agent stopped with ${promptResponse.stopReason}.` : null,
      failureKind: limited ? "usage_limit" : null,
      providerSessionId,
      runtimeWarnings: [],
      diagnostics: {
        acp_protocol_version: connection.initializeResult.protocolVersion,
        acp_profile_id: profileId,
        acp_session_id_encoded: true,
        acp_stop_reason: promptResponse.stopReason,
        acp_resume_method: setup.resumeMethod,
        acp_mode_applied: configuration.modeApplied,
        acp_config_options_applied: configuration.configOptionsApplied,
      },
      capabilitiesUsed: {
        session_resume: setup.resumed,
        session_load: setup.resumeMethod === "load",
        session_config: configuration.modeApplied || configuration.configOptionsApplied.length > 0,
        mcp: connection.descriptor.mcpOwner === "client"
          && (connection.descriptor.sessionConfig?.mcpServers || []).length > 0,
      },
      structuredResult: undefined,
      structuredResultSource: null,
    };
  } catch (error) {
    const failure = failureFor(error, req?.abortSignal?.aborted === true);
    capture({
      type: "provider_request_completed",
      sdk: "acp",
      model: reference,
      runtime: "acp-stdio",
      timestamp: Date.now(),
      durationMs: Date.now() - start,
      cancelled: failure.cancelled,
    });
    return {
      text: state.text.join("") || null,
      thinking: state.thinking.join(""),
      events,
      usage: {},
      durationMs: Date.now() - start,
      numTurns: 0,
      model: reference,
      effort: req?.effort || null,
      sdk: "acp",
      cancelled: failure.cancelled,
      error: failure.message,
      errorDetails: failure.message ? {
        acp_error_code: typeof error?.code === "string" ? error.code : "protocol",
      } : null,
      failureKind: failure.failureKind,
      providerSessionId,
      runtimeWarnings: [],
      diagnostics: {
        acp_profile_id: typeof profileId === "string" ? profileId : null,
        acp_session_id_encoded: providerSessionId != null,
        acp_stop_reason: failure.cancelled ? "cancelled" : "error",
      },
      capabilitiesUsed: {},
      structuredResult: undefined,
      structuredResultSource: null,
    };
  } finally {
    await connection?.close().catch(() => {});
  }
}

export const acpRuntimeBridge = {
  id: "acp-stdio",
  kind: "acp",
  capabilities: runtimeCapabilities("acp"),
  supports: (ref, options) => ref?.sdk === "acp" && options?.executionMode === "acp",
  execute: generateAcpResponse,
};
