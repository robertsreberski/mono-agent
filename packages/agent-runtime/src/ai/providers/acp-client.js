// @ts-check

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createStderrTail } from "../failure.js";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import {
  ACP_DEFAULT_MAX_LINE_BYTES,
  AcpTransportError,
  createBoundedAcpStdioStream,
  normalizeAcpMaxLineBytes,
} from "./acp-transport.js";
import { sanitizeAcpHostValue } from "./acp-privacy.js";
import {
  AcpClientError,
  decodeAcpProviderSessionId,
  decodeAcpSessionCursor,
  encodeAcpProviderSessionId,
  encodeAcpSessionCursor,
  validateAcpProfileId,
  validateAcpProviderSessionId,
} from "./acp-session-tokens.js";

const OWNERS = new Set(["client", "agent"]);
const RESUME_STRATEGIES = new Set(["auto", "load", "resume"]);
const DEFAULT_PROCESS_POLICY = Object.freeze({
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 60_000,
  shutdownGraceMs: 500,
  killGraceMs: 500,
  stderrTailBytes: 8 * 1024,
  maxLineBytes: ACP_DEFAULT_MAX_LINE_BYTES,
});

/**
 * Product-neutral description of one ACP stdio agent profile. The environment
 * is exact/minimal: agent-runtime never spreads process.env into the child.
 *
 * @typedef {Object} AcpProfileDescriptor
 * @property {string} command
 * @property {ReadonlyArray<string>} [args]
 * @property {string} [cwd]
 * @property {Record<string, string>} [env]
 * @property {"client"|"agent"} [configurationOwner]
 * @property {"client"|"agent"} [workspaceOwner]
 * @property {"client"|"agent"} [mcpOwner]
 * @property {string} [workspacePath] Absolute canonical workspace path; required for agent-owned workspaces.
 * @property {Object} [capabilityPolicy]
 * @property {{readTextFile?: boolean, writeTextFile?: boolean}} [capabilityPolicy.filesystem]
 * @property {boolean} [capabilityPolicy.terminal]
 * @property {{terminal?: boolean}} [capabilityPolicy.auth]
 * @property {{form?: boolean, url?: boolean}} [capabilityPolicy.elicitation]
 * @property {{boolean?: boolean}} [capabilityPolicy.sessionConfig]
 * @property {{stdio?: boolean, http?: boolean, sse?: boolean}} [capabilityPolicy.mcp]
 * @property {Object} [sessionConfig]
 * @property {ReadonlyArray<string>} [sessionConfig.additionalDirectories]
 * @property {ReadonlyArray<Record<string, unknown>>} [sessionConfig.mcpServers]
 * @property {"auto"|"load"|"resume"} [sessionConfig.resumeStrategy]
 * @property {string} [sessionConfig.modeId]
 * @property {Record<string, string|boolean>} [sessionConfig.configOptions]
 * @property {Object} [clientCallbacks]
 * @property {(request: AcpHostSessionPayload<import("@agentclientprotocol/sdk").RequestPermissionRequest>, context: AcpCallbackContext) => Promise<import("@agentclientprotocol/sdk").RequestPermissionResponse>|import("@agentclientprotocol/sdk").RequestPermissionResponse} [clientCallbacks.requestPermission]
 * @property {(request: AcpHostElicitationPayload, context: AcpCallbackContext) => Promise<import("@agentclientprotocol/sdk").CreateElicitationResponse>|import("@agentclientprotocol/sdk").CreateElicitationResponse} [clientCallbacks.createElicitation]
 * @property {(request: AcpHostSessionPayload<import("@agentclientprotocol/sdk").ReadTextFileRequest>, context: AcpCallbackContext) => Promise<import("@agentclientprotocol/sdk").ReadTextFileResponse>|import("@agentclientprotocol/sdk").ReadTextFileResponse} [clientCallbacks.readTextFile]
 * @property {(request: AcpHostSessionPayload<import("@agentclientprotocol/sdk").WriteTextFileRequest>, context: AcpCallbackContext) => Promise<import("@agentclientprotocol/sdk").WriteTextFileResponse>|import("@agentclientprotocol/sdk").WriteTextFileResponse} [clientCallbacks.writeTextFile]
 * @property {(request: AcpHostSessionPayload<import("@agentclientprotocol/sdk").CreateTerminalRequest>, context: AcpCallbackContext) => Promise<import("@agentclientprotocol/sdk").CreateTerminalResponse>|import("@agentclientprotocol/sdk").CreateTerminalResponse} [clientCallbacks.createTerminal]
 * @property {(request: AcpHostSessionPayload<import("@agentclientprotocol/sdk").TerminalOutputRequest>, context: AcpCallbackContext) => Promise<import("@agentclientprotocol/sdk").TerminalOutputResponse>|import("@agentclientprotocol/sdk").TerminalOutputResponse} [clientCallbacks.terminalOutput]
 * @property {(request: AcpHostSessionPayload<import("@agentclientprotocol/sdk").WaitForTerminalExitRequest>, context: AcpCallbackContext) => Promise<import("@agentclientprotocol/sdk").WaitForTerminalExitResponse>|import("@agentclientprotocol/sdk").WaitForTerminalExitResponse} [clientCallbacks.waitForTerminalExit]
 * @property {(request: AcpHostSessionPayload<import("@agentclientprotocol/sdk").KillTerminalRequest>, context: AcpCallbackContext) => Promise<import("@agentclientprotocol/sdk").KillTerminalResponse>|import("@agentclientprotocol/sdk").KillTerminalResponse} [clientCallbacks.killTerminal]
 * @property {(request: AcpHostSessionPayload<import("@agentclientprotocol/sdk").ReleaseTerminalRequest>, context: AcpCallbackContext) => Promise<import("@agentclientprotocol/sdk").ReleaseTerminalResponse>|import("@agentclientprotocol/sdk").ReleaseTerminalResponse} [clientCallbacks.releaseTerminal]
 * @property {(notification: AcpHostSessionPayload<import("@agentclientprotocol/sdk").SessionNotification>, context: AcpCallbackContext) => Promise<void>|void} [clientCallbacks.sessionUpdate]
 * @property {(notification: Omit<import("@agentclientprotocol/sdk").CompleteElicitationNotification, "_meta">, context: AcpCallbackContext) => Promise<void>|void} [clientCallbacks.elicitationComplete]
 * @property {Object} [process]
 * @property {number} [process.startupTimeoutMs]
 * @property {number} [process.requestTimeoutMs]
 * @property {number} [process.shutdownGraceMs]
 * @property {number} [process.killGraceMs]
 * @property {number} [process.stderrTailBytes]
 * @property {number} [process.maxLineBytes]
 * @property {Record<string, unknown>} [metadata] Opaque host metadata; never returned in diagnostics.
 */

/**
 * @typedef {Object} AcpCallbackContext
 * @property {string} profileId
 * @property {string} operation
 * @property {string} [providerSessionId] Opaque profile-bound session handle when the callback is session-scoped.
 * @property {AbortSignal} [signal]
 * @property {unknown} [requestId]
 * @property {Record<string, unknown>} [hostContext]
 */

/** @template T @typedef {T extends unknown ? Omit<T, "sessionId"> : never} WithoutSessionId */
/** @template T @typedef {T extends unknown ? Omit<T, "sessionId"|"_meta"> : never} AcpHostSessionPayload */
/**
 * @typedef {WithoutSessionId<import("@agentclientprotocol/sdk").CreateElicitationRequest>
 *   & Pick<import("@agentclientprotocol/sdk").CreateElicitationRequest, "message" | "mode">
 *   } AcpHostElicitationPayload
 */
/**
 * @typedef {Object} AcpListedSession
 * @property {string} providerSessionId Opaque runtime handle for resume/delete.
 * @property {string} cwd
 * @property {ReadonlyArray<string>} [additionalDirectories]
 * @property {string|null} [title]
 * @property {string|null} [updatedAt]
 */
/**
 * @typedef {Object} AcpSessionListResult
 * @property {string} profileId
 * @property {AcpListedSession[]} sessions
 * @property {string|null} nextCursor Opaque runtime cursor; pass it back unchanged.
 */
/** @typedef {WithoutSessionId<import("@agentclientprotocol/sdk").RequestPermissionRequest>} AcpPermissionInteractionPayload */
/**
 * `CreateElicitationRequest` includes a future-mode string index signature.
 * Plain `Omit` preserves that openness but widens its named common fields to
 * unknown, so restore the protocol's concrete common-field types explicitly.
 * @typedef {WithoutSessionId<import("@agentclientprotocol/sdk").CreateElicitationRequest>
 *   & Pick<import("@agentclientprotocol/sdk").CreateElicitationRequest, "message" | "mode" | "_meta">} AcpElicitationInteractionPayload
 */
/**
 * @typedef {{kind: "permission", profileId: string, payload: AcpPermissionInteractionPayload}
 *   | {kind: "elicitation", profileId: string, payload: AcpElicitationInteractionPayload}} AcpInteractionRequest
 */

/**
 * @typedef {Object} AcpClientHostOptions
 * @property {(profileId: string, context?: Record<string, unknown>) => Promise<AcpProfileDescriptor|null|undefined>|AcpProfileDescriptor|null|undefined} resolveAcpProfile
 * @property {(request: AcpInteractionRequest, context?: AcpCallbackContext) => Promise<unknown>|unknown} [onAcpInteractionRequest]
 * @property {import('../../agent/sandbox-seam.js').RuntimeSandbox} [sandbox]
 * @property {import('../../agent/sandbox-seam.js').SandboxPolicy} [sandboxPolicy]
 * @property {import('../../agent/sandbox-seam.js').RuntimeSandboxEngine} [sandboxEngine]
 * @property {string} [cwd]
 * @property {AbortSignal} [signal]
 * @property {Record<string, unknown>} [context]
 */

export {
  AcpClientError,
  encodeAcpProviderSessionId,
  validateAcpProfileId,
  validateAcpProviderSessionId,
};

/** @param {unknown} value @param {string} label @returns {string} */
function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.includes("\0")) {
    throw new AcpClientError("invalid_profile", `${label} must be a non-empty trimmed string without NUL bytes.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {number} fallback @returns {number} */
function boundedInteger(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 300_000) {
    throw new AcpClientError("invalid_profile", `${label} must be an integer between 0 and 300000.`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label @returns {string[]} */
function stringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AcpClientError("invalid_profile", `${label} must be an array.`);
  return value.map((item) => requiredString(item, `${label} entry`));
}

/** @param {unknown} value @param {string} label @returns {Record<string, string>} */
function stringRecord(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AcpClientError("invalid_profile", `${label} must be an object of strings.`);
  }
  /** @type {Record<string, string>} */
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    requiredString(key, `${label} key`);
    result[key] = requiredString(item, `${label}.${key}`);
  }
  return result;
}

/** @param {unknown} value @param {string} field @param {"client"|"agent"} fallback */
function ownership(value, field, fallback) {
  if (value === undefined) return fallback;
  if (!OWNERS.has(/** @type {any} */ (value))) {
    throw new AcpClientError("invalid_profile", `${field} must be client or agent.`);
  }
  return /** @type {"client"|"agent"} */ (value);
}

/**
 * @param {AcpProfileDescriptor} descriptor
 * @returns {AcpProfileDescriptor & {args: string[], env: Record<string,string>, configurationOwner: "client"|"agent", workspaceOwner: "client"|"agent", mcpOwner: "client"|"agent", process: {startupTimeoutMs: number, requestTimeoutMs: number, shutdownGraceMs: number, killGraceMs: number, stderrTailBytes: number, maxLineBytes: number}}}
 */
function normalizeProfile(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new AcpClientError("invalid_profile", "ACP profile resolver must return an object.");
  }
  const command = requiredString(descriptor.command, "ACP profile command");
  if (!isAbsolute(command)) {
    throw new AcpClientError("invalid_profile", "ACP profile command must be absolute.");
  }
  const args = stringArray(descriptor.args, "ACP profile args");
  const env = stringRecord(descriptor.env, "ACP profile env");
  const configurationOwner = ownership(descriptor.configurationOwner, "configurationOwner", "client");
  const workspaceOwner = ownership(descriptor.workspaceOwner, "workspaceOwner", "client");
  const mcpOwner = ownership(descriptor.mcpOwner, "mcpOwner", "client");
  const cwd = descriptor.cwd === undefined ? undefined : requiredString(descriptor.cwd, "ACP profile cwd");
  if (cwd !== undefined && !isAbsolute(cwd)) {
    throw new AcpClientError("invalid_profile", "ACP profile cwd must be absolute.");
  }
  const workspacePath = descriptor.workspacePath === undefined
    ? undefined
    : requiredString(descriptor.workspacePath, "ACP profile workspacePath");
  if (workspacePath !== undefined && !isAbsolute(workspacePath)) {
    throw new AcpClientError("invalid_profile", "ACP profile workspacePath must be absolute.");
  }
  if (workspaceOwner === "agent" && workspacePath === undefined) {
    throw new AcpClientError("invalid_profile", "Agent-owned ACP workspaces require an absolute workspacePath.");
  }
  const sessionConfig = descriptor.sessionConfig === undefined ? {} : descriptor.sessionConfig;
  if (!sessionConfig || typeof sessionConfig !== "object" || Array.isArray(sessionConfig)) {
    throw new AcpClientError("invalid_profile", "ACP sessionConfig must be an object.");
  }
  if (sessionConfig.resumeStrategy !== undefined && !RESUME_STRATEGIES.has(sessionConfig.resumeStrategy)) {
    throw new AcpClientError("invalid_profile", "ACP resumeStrategy must be auto, load, or resume.");
  }
  const processPolicy = descriptor.process || {};
  if (!processPolicy || typeof processPolicy !== "object" || Array.isArray(processPolicy)) {
    throw new AcpClientError("invalid_profile", "ACP process policy must be an object.");
  }
  const stderrTailBytes = boundedInteger(
    processPolicy.stderrTailBytes,
    "process.stderrTailBytes",
    DEFAULT_PROCESS_POLICY.stderrTailBytes,
  );
  if (stderrTailBytes < 1024 || stderrTailBytes > 1024 * 1024) {
    throw new AcpClientError("invalid_profile", "process.stderrTailBytes must be between 1024 and 1048576.");
  }
  let maxLineBytes;
  try {
    maxLineBytes = normalizeAcpMaxLineBytes(processPolicy.maxLineBytes);
  } catch (error) {
    throw asClientError(error);
  }
  return {
    ...descriptor,
    command,
    args,
    env,
    cwd,
    workspacePath,
    configurationOwner,
    workspaceOwner,
    mcpOwner,
    sessionConfig,
    process: {
      startupTimeoutMs: boundedInteger(
        processPolicy.startupTimeoutMs,
        "process.startupTimeoutMs",
        DEFAULT_PROCESS_POLICY.startupTimeoutMs,
      ),
      requestTimeoutMs: boundedInteger(
        processPolicy.requestTimeoutMs,
        "process.requestTimeoutMs",
        DEFAULT_PROCESS_POLICY.requestTimeoutMs,
      ),
      shutdownGraceMs: boundedInteger(
        processPolicy.shutdownGraceMs,
        "process.shutdownGraceMs",
        DEFAULT_PROCESS_POLICY.shutdownGraceMs,
      ),
      killGraceMs: boundedInteger(
        processPolicy.killGraceMs,
        "process.killGraceMs",
        DEFAULT_PROCESS_POLICY.killGraceMs,
      ),
      stderrTailBytes,
      maxLineBytes,
    },
  };
}

/** @param {unknown} error @returns {AcpClientError} */
function asClientError(error) {
  if (error instanceof AcpClientError) return error;
  if (error instanceof AcpTransportError) {
    return new AcpClientError("protocol", error.message, { transportCode: error.code });
  }
  const code = typeof /** @type {any} */ (error)?.code === "string"
    ? /** @type {any} */ (error).code
    : undefined;
  return new AcpClientError(
    code === "ENOENT" || code === "EACCES" ? "spawn" : "protocol",
    code === "ENOENT"
      ? "ACP profile command was not found."
      : code === "EACCES"
        ? "ACP profile command is not executable."
        : "ACP operation failed.",
    code ? { causeCode: code } : {},
  );
}

/** @param {AbortSignal|undefined} signal */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw new AcpClientError("cancelled", "ACP operation was cancelled.");
}

/** @param {Promise<any>} promise @param {number} timeoutMs @param {string} operation @param {() => void} [onTimeout] */
async function withTimeout(promise, timeoutMs, operation, onTimeout) {
  if (timeoutMs === 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new AcpClientError("timeout", `ACP ${operation} timed out.`, { operation, timeoutMs }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {import('node:child_process').ChildProcess} child */
function childTermination(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => finish({ error }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });
}

/** @param {Promise<any>} exitPromise @param {number} timeoutMs */
async function waitForExit(exitPromise, timeoutMs) {
  if (timeoutMs === 0) return null;
  let timer;
  try {
    return await Promise.race([
      exitPromise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Promise<any>} promise @param {number} timeoutMs */
async function drainCancelledPrompt(promise, timeoutMs) {
  if (timeoutMs === 0) {
    throw new AcpClientError("cancelled", "ACP prompt was cancelled.");
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new AcpClientError("cancelled", "ACP prompt was cancelled."));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {unknown} value @returns {Record<string, unknown>|undefined} */
function hostContext(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}

/**
 * @param {string} profileId
 * @param {AcpClientHostOptions & {operation?: string}} options
 */
async function resolveProfile(profileId, options) {
  if (typeof options?.resolveAcpProfile !== "function") {
    throw new AcpClientError("profile_resolver_missing", "resolveAcpProfile is required.");
  }
  const descriptor = await options.resolveAcpProfile(profileId, {
    ...hostContext(options.context),
    operation: options.operation || "connect",
    profileId,
    cwd: options.cwd,
  });
  if (descriptor == null) {
    throw new AcpClientError("profile_not_found", `ACP profile '${profileId}' was not found.`, { profileId });
  }
  return normalizeProfile(descriptor);
}

/** @param {any} descriptor */
function clientCapabilities(descriptor) {
  const policy = descriptor.capabilityPolicy || {};
  const fs = policy.filesystem || {};
  const terminalCallbacks = [
    "createTerminal",
    "terminalOutput",
    "waitForTerminalExit",
    "killTerminal",
    "releaseTerminal",
  ];
  if (policy.terminal === true) {
    for (const name of terminalCallbacks) {
      if (typeof descriptor.clientCallbacks?.[name] !== "function") {
        throw new AcpClientError("invalid_profile", `ACP terminal capability requires clientCallbacks.${name}.`);
      }
    }
  }
  if (fs.readTextFile === true && typeof descriptor.clientCallbacks?.readTextFile !== "function") {
    throw new AcpClientError("invalid_profile", "ACP readTextFile capability requires a callback.");
  }
  if (fs.writeTextFile === true && typeof descriptor.clientCallbacks?.writeTextFile !== "function") {
    throw new AcpClientError("invalid_profile", "ACP writeTextFile capability requires a callback.");
  }
  const capabilities = {
    fs: {
      readTextFile: fs.readTextFile === true,
      writeTextFile: fs.writeTextFile === true,
    },
    terminal: policy.terminal === true,
  };
  if (policy.sessionConfig?.boolean === true) {
    capabilities.session = { configOptions: { boolean: {} } };
  }
  if (policy.auth?.terminal === true) capabilities.auth = { terminal: true };
  if (policy.elicitation?.form === true || policy.elicitation?.url === true) {
    capabilities.elicitation = {
      ...(policy.elicitation.form === true ? { form: {} } : {}),
      ...(policy.elicitation.url === true ? { url: {} } : {}),
    };
  }
  return capabilities;
}

/** @param {any} value @param {any[]} options @returns {any} */
function permissionResponse(value, options) {
  const outcome = value?.outcome;
  if (outcome?.outcome === "selected") {
    const offered = options.some((option) => option?.optionId === outcome.optionId);
    if (offered) return { outcome: { outcome: "selected", optionId: outcome.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

/** @param {any} value */
function elicitationResponse(value) {
  if (value?.action === "accept") {
    return value.content === undefined
      ? { action: "accept" }
      : { action: "accept", content: value.content };
  }
  if (value?.action === "decline") return { action: "decline" };
  return { action: "cancel" };
}

/**
 * The protocol session id is private connection state. Hosts answer through
 * the pending callback, so exposing the raw id in UI-facing interaction
 * payloads adds persistence risk without enabling any supported response.
 * Low-level descriptor callbacks still receive the native SDK request.
 * @template {object} T
 * @param {T} value
 * @returns {WithoutSessionId<T>}
 */
function hostInteractionPayload(value) {
  return /** @type {WithoutSessionId<T>} */ (
    sanitizeAcpHostValue(value, [/** @type {T & {sessionId?: unknown}} */ (value).sessionId])
  );
}

/**
 * Preserve the named common fields that TypeScript widens through ACP's open
 * future-mode index signature.
 * @param {import("@agentclientprotocol/sdk").CreateElicitationRequest} value
 * @returns {AcpElicitationInteractionPayload}
 */
function hostElicitationPayload(value) {
  return /** @type {AcpElicitationInteractionPayload} */ (hostInteractionPayload(value));
}

/** @template {object} T @param {T & {sessionId: string}} value */
function descriptorSessionPayload(value) {
  return /** @type {AcpHostSessionPayload<T>} */ (sanitizeAcpHostValue(value, [value.sessionId]));
}

/** @param {unknown} value */
function callbackSessionId(value) {
  const candidate = /** @type {{sessionId?: unknown}} */ (value);
  return typeof candidate?.sessionId === "string" ? candidate.sessionId : undefined;
}

/** @param {import("@agentclientprotocol/sdk").CreateElicitationRequest} value */
function descriptorElicitationPayload(value) {
  const rawSessionId = callbackSessionId(value);
  return /** @type {AcpHostElicitationPayload} */ (sanitizeAcpHostValue(value, [rawSessionId]));
}

/** @param {any} descriptor @param {AcpClientHostOptions} options @param {string} profileId @param {string} operation */
function callbackContext(descriptor, options, profileId, operation, extra = {}) {
  return {
    profileId,
    operation,
    hostContext: hostContext(options.context),
    ...extra,
  };
}

/**
 * Open and initialize one owned ACP v1 stdio bridge process.
 * @param {string} profileId
 * @param {AcpClientHostOptions & {operation?: string}} options
 */
export async function connectAcpProfile(profileId, options) {
  validateAcpProfileId(profileId);
  throwIfAborted(options?.signal);
  const operation = options?.operation || "connect";
  const descriptor = await resolveProfile(profileId, { ...options, operation });
  throwIfAborted(options?.signal);
  const capabilities = clientCapabilities(descriptor);
  const sandbox = options.sandbox || passthroughSandbox;
  const commandCwd = descriptor.cwd || descriptor.workspacePath || options.cwd || process.cwd();
  if (typeof commandCwd !== "string" || !isAbsolute(commandCwd)) {
    throw new AcpClientError("invalid_profile", "ACP child cwd must be absolute.");
  }
  let prepared;
  try {
    prepared = await sandbox.prepareCommand({
      policy: options.sandboxPolicy,
      engine: options.sandboxEngine,
      command: {
        command: descriptor.command,
        args: descriptor.args,
        cwd: commandCwd,
        env: descriptor.env,
      },
    });
  } catch (error) {
    throw asClientError(error);
  }
  if (options?.signal?.aborted) {
    try {
      await prepared.cleanup?.();
    } finally {
      throwIfAborted(options.signal);
    }
  }

  const child = spawn(prepared.command, [...(prepared.args || [])], {
    cwd: prepared.cwd || commandCwd,
    env: { ...(prepared.env || {}) },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderrTail = createStderrTail({ limit: descriptor.process.stderrTailBytes });
  child.stderr?.on("data", (chunk) => stderrTail.push(chunk));
  const exitPromise = childTermination(child);
  const updates = new Map();
  const activePromptSessions = new Set();
  let hostRequestSequence = 0;
  /** @param {AcpCallbackContext} context @param {unknown} [rawSessionId] */
  const safeCallbackContext = (context, rawSessionId) => ({
    ...context,
    ...(typeof rawSessionId === "string"
      ? { providerSessionId: encodeAcpProviderSessionId(profileId, rawSessionId) }
      : {}),
    ...(context.requestId === undefined
      ? {}
      : { requestId: `acp-request:${profileId}:${++hostRequestSequence}` }),
  });
  let closed = false;

  const app = client({ name: "mono-agent-agent-runtime-acp" });
  app.onRequest(methods.client.session.requestPermission, async (ctx) => {
    let result;
    try {
      const context = callbackContext(descriptor, options, profileId, "permission", {
        signal: ctx.signal,
        requestId: ctx.requestId,
      });
      if (typeof descriptor.clientCallbacks?.requestPermission === "function") {
        result = await descriptor.clientCallbacks.requestPermission(
          descriptorSessionPayload(ctx.params),
          safeCallbackContext(context, ctx.params.sessionId),
        );
      } else if (typeof options.onAcpInteractionRequest === "function") {
        result = await options.onAcpInteractionRequest(
          { kind: "permission", profileId, payload: hostInteractionPayload(ctx.params) },
          safeCallbackContext(context, ctx.params.sessionId),
        );
      }
    } catch {
      result = null;
    }
    return permissionResponse(result, ctx.params.options || []);
  });
  app.onNotification(methods.client.session.update, async (ctx) => {
    const listeners = updates.get(ctx.params.sessionId);
    if (listeners) {
      for (const listener of [...listeners]) {
        try { await listener(ctx.params); } catch { /* observer callbacks do not break the protocol */ }
      }
    }
    try {
      await descriptor.clientCallbacks?.sessionUpdate?.(
        descriptorSessionPayload(ctx.params),
        safeCallbackContext(
          callbackContext(descriptor, options, profileId, "session_update", { signal: ctx.signal }),
          ctx.params.sessionId,
        ),
      );
    } catch { /* profile notification callbacks are observational */ }
  });
  if (descriptor.capabilityPolicy?.filesystem?.readTextFile === true) {
    app.onRequest(methods.client.fs.readTextFile, (ctx) => descriptor.clientCallbacks.readTextFile(
      descriptorSessionPayload(ctx.params),
      safeCallbackContext(
        callbackContext(descriptor, options, profileId, "read_text_file", { signal: ctx.signal, requestId: ctx.requestId }),
        ctx.params.sessionId,
      ),
    ));
  }
  if (descriptor.capabilityPolicy?.filesystem?.writeTextFile === true) {
    app.onRequest(methods.client.fs.writeTextFile, (ctx) => descriptor.clientCallbacks.writeTextFile(
      descriptorSessionPayload(ctx.params),
      safeCallbackContext(
        callbackContext(descriptor, options, profileId, "write_text_file", { signal: ctx.signal, requestId: ctx.requestId }),
        ctx.params.sessionId,
      ),
    ));
  }
  if (descriptor.capabilityPolicy?.terminal === true) {
    const terminalHandlers = [
      [methods.client.terminal.create, "createTerminal", "terminal_create"],
      [methods.client.terminal.output, "terminalOutput", "terminal_output"],
      [methods.client.terminal.waitForExit, "waitForTerminalExit", "terminal_wait_for_exit"],
      [methods.client.terminal.kill, "killTerminal", "terminal_kill"],
      [methods.client.terminal.release, "releaseTerminal", "terminal_release"],
    ];
    for (const [method, callback, callbackOperation] of terminalHandlers) {
      app.onRequest(/** @type {any} */ (method), (ctx) => descriptor.clientCallbacks[callback](
        descriptorSessionPayload(ctx.params),
        safeCallbackContext(
          callbackContext(descriptor, options, profileId, callbackOperation, { signal: ctx.signal, requestId: ctx.requestId }),
          ctx.params.sessionId,
        ),
      ));
    }
  }
  if (descriptor.capabilityPolicy?.elicitation?.form === true || descriptor.capabilityPolicy?.elicitation?.url === true) {
    app.onRequest(methods.client.elicitation.create, async (ctx) => {
      let result;
      try {
        const context = callbackContext(descriptor, options, profileId, "elicitation", {
          signal: ctx.signal,
          requestId: ctx.requestId,
        });
        if (typeof descriptor.clientCallbacks?.createElicitation === "function") {
          result = await descriptor.clientCallbacks.createElicitation(
            descriptorElicitationPayload(ctx.params),
            safeCallbackContext(context, callbackSessionId(ctx.params)),
          );
        } else if (typeof options.onAcpInteractionRequest === "function") {
          result = await options.onAcpInteractionRequest(
            { kind: "elicitation", profileId, payload: hostElicitationPayload(ctx.params) },
            safeCallbackContext(context, callbackSessionId(ctx.params)),
          );
        }
      } catch {
        result = null;
      }
      return elicitationResponse(result);
    });
    app.onNotification(methods.client.elicitation.complete, async (ctx) => {
      try {
        await descriptor.clientCallbacks?.elicitationComplete?.(
          sanitizeAcpHostValue(ctx.params),
          safeCallbackContext(callbackContext(descriptor, options, profileId, "elicitation_complete", { signal: ctx.signal })),
        );
      } catch { /* observational */ }
    });
  }

  let connection;
  try {
    connection = app.connect(createBoundedAcpStdioStream(child, {
      maxLineBytes: descriptor.process.maxLineBytes,
    }));
  } catch (error) {
    child.kill("SIGTERM");
    const exited = await waitForExit(exitPromise, descriptor.process.killGraceMs);
    if (!exited) {
      child.kill("SIGKILL");
      await waitForExit(exitPromise, descriptor.process.killGraceMs);
    }
    await prepared.cleanup?.();
    throw asClientError(error);
  }
  connection.closed.catch(() => {});
  const context = connection.agent;

  const processEnded = () => exitPromise.then((termination) => {
    const error = termination?.error;
    if (error) throw asClientError(error);
    throw new AcpClientError("process_exited", "ACP bridge process exited unexpectedly.", {
      exitCode: termination?.code ?? null,
      signal: termination?.signal ?? null,
      stderrBytes: Buffer.byteLength(stderrTail.toString(), "utf8"),
      stderrTruncated: stderrTail.bytesDropped > 0,
    });
  });

  /** @param {string} method @param {any} params @param {{timeoutMs?: number, signal?: AbortSignal, label?: string}} [requestOptions] */
  const request = async (method, params, requestOptions = {}) => {
    if (closed) throw new AcpClientError("closed", "ACP client is closed.");
    const controller = new AbortController();
    const externalSignal = requestOptions.signal || options.signal;
    const abort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();
    try {
      const pending = context.request(/** @type {any} */ (method), params, {
        cancellationSignal: controller.signal,
      });
      return await withTimeout(
        Promise.race([pending, processEnded()]),
        requestOptions.timeoutMs ?? descriptor.process.requestTimeoutMs,
        requestOptions.label || method,
        () => controller.abort(new Error("timeout")),
      );
    } catch (error) {
      throw asClientError(error);
    } finally {
      externalSignal?.removeEventListener("abort", abort);
    }
  };

  let initializeResult;
  try {
    initializeResult = await request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: capabilities,
      clientInfo: {
        name: "mono-agent-agent-runtime-acp",
        title: "mono-agent ACP runtime client",
        version: "1.0.0",
      },
    }, { timeoutMs: descriptor.process.startupTimeoutMs, label: "initialize" });
    if (initializeResult.protocolVersion !== PROTOCOL_VERSION) {
      throw new AcpClientError(
        "protocol_version",
        "ACP agent selected an unsupported protocol version.",
        { expected: PROTOCOL_VERSION, received: initializeResult.protocolVersion },
      );
    }
  } catch (error) {
    connection.close(error);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const exited = await waitForExit(exitPromise, descriptor.process.killGraceMs);
    if (!exited) {
      child.kill("SIGKILL");
      await waitForExit(exitPromise, descriptor.process.killGraceMs);
    }
    await prepared.cleanup?.();
    throw asClientError(error);
  }

  const agentCaps = initializeResult.agentCapabilities || {};
  const sessionCaps = agentCaps.sessionCapabilities || {};
  const hasCapability = (name) => {
    if (name === "load") return agentCaps.loadSession === true;
    if (name === "logout") return agentCaps.auth?.logout != null;
    return sessionCaps[name] != null;
  };
  const requireCapability = (name, method) => {
    if (!hasCapability(name)) {
      throw new AcpClientError("capability_missing", `ACP agent did not advertise ${method}.`, {
        capability: name,
      });
    }
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const sessionId of [...activePromptSessions]) {
      try { await context.notify(methods.agent.session.cancel, { sessionId }); } catch { /* closing */ }
    }
    connection.close();
    if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    let exited = child.exitCode !== null || child.signalCode !== null
      ? true
      : Boolean(await waitForExit(exitPromise, descriptor.process.shutdownGraceMs));
    if (!exited) {
      child.kill("SIGTERM");
      exited = Boolean(await waitForExit(exitPromise, descriptor.process.killGraceMs));
    }
    if (!exited) {
      child.kill("SIGKILL");
      await waitForExit(exitPromise, descriptor.process.killGraceMs);
    }
    await prepared.cleanup?.();
  };

  const addUpdateListener = (sessionId, listener) => {
    const listeners = updates.get(sessionId) || new Set();
    listeners.add(listener);
    updates.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) updates.delete(sessionId);
    };
  };

  return {
    profileId,
    descriptor,
    initializeResult,
    clientCapabilities: capabilities,
    hasCapability,
    onSessionUpdate: addUpdateListener,
    request,
    async authenticate(methodId) {
      const advertised = (initializeResult.authMethods || []).some((method) => method?.id === methodId);
      if (!advertised) {
        throw new AcpClientError("capability_missing", "ACP authentication method was not advertised.", { methodId });
      }
      return request(methods.agent.authenticate, { methodId });
    },
    async logout() {
      requireCapability("logout", "logout");
      return request(methods.agent.logout, {});
    },
    async newSession(params) {
      return request(methods.agent.session.new, validateSessionRequest(params, descriptor, initializeResult));
    },
    async loadSession(params) {
      const requestParams = validateSessionRequest(params, descriptor, initializeResult);
      requireCapability("load", "session/load");
      return request(methods.agent.session.load, requestParams);
    },
    async resumeSession(params) {
      const requestParams = validateSessionRequest(params, descriptor, initializeResult);
      requireCapability("resume", "session/resume");
      return request(methods.agent.session.resume, requestParams);
    },
    async closeSession(sessionId) {
      requireCapability("close", "session/close");
      return request(methods.agent.session.close, { sessionId });
    },
    async listSessions(params = {}) {
      const requestParams = validateSessionListRequest(params);
      requireCapability("list", "session/list");
      return request(methods.agent.session.list, requestParams);
    },
    async deleteSession(sessionId) {
      requireCapability("delete", "session/delete");
      return request(methods.agent.session.delete, { sessionId });
    },
    async setSessionMode(sessionId, modeId) {
      return request(methods.agent.session.setMode, { sessionId, modeId });
    },
    async setSessionConfigOption(sessionId, configId, value) {
      return request(methods.agent.session.setConfigOption, {
        sessionId,
        configId,
        value,
        ...(typeof value === "boolean" ? { type: "boolean" } : {}),
      });
    },
    async cancel(sessionId) {
      await context.notify(methods.agent.session.cancel, { sessionId });
    },
    async prompt(sessionId, prompt, promptOptions = {}) {
      const signal = promptOptions.signal;
      if (signal?.aborted) {
        await context.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
        throw new AcpClientError("cancelled", "ACP prompt was cancelled.");
      }
      const remove = typeof promptOptions.onUpdate === "function"
        ? addUpdateListener(sessionId, promptOptions.onUpdate)
        : () => {};
      activePromptSessions.add(sessionId);
      const abortedMarker = Symbol("ACP prompt aborted");
      let resolveAborted;
      const aborted = new Promise((resolve) => { resolveAborted = resolve; });
      const onAbort = () => {
        context.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
        resolveAborted(abortedMarker);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const pending = request(methods.agent.session.prompt, { sessionId, prompt }, {
          signal,
          timeoutMs: promptOptions.timeoutMs,
          label: "session/prompt",
        });
        const outcome = await Promise.race([pending, aborted]);
        if (outcome !== abortedMarker) return outcome;

        // The SDK cancellation signal emits $/cancel_request but intentionally
        // leaves the request pending. Keep the connection and update listener
        // alive for a bounded grace period so the peer can acknowledge
        // session/cancel, emit final updates, and return its PromptResponse.
        try {
          return await drainCancelledPrompt(pending, descriptor.process.shutdownGraceMs);
        } catch {
          throw new AcpClientError("cancelled", "ACP prompt was cancelled.");
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        activePromptSessions.delete(sessionId);
        remove();
      }
    },
    close,
  };
}

/** @param {any} params @param {any} descriptor @param {any} initializeResult */
function validateSessionRequest(params, descriptor, initializeResult) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new AcpClientError("invalid_request", "ACP session request must be an object.");
  }
  if (typeof params.cwd !== "string" || !isAbsolute(params.cwd)) {
    throw new AcpClientError("invalid_request", "ACP session cwd must be absolute.");
  }
  const additionalDirectories = params.additionalDirectories === undefined
    ? []
    : params.additionalDirectories;
  if (!Array.isArray(additionalDirectories)
    || additionalDirectories.some((value) => typeof value !== "string" || !isAbsolute(value))) {
    throw new AcpClientError("invalid_request", "ACP additionalDirectories must contain absolute paths.");
  }
  if (additionalDirectories.length > 0
    && initializeResult.agentCapabilities?.sessionCapabilities?.additionalDirectories == null) {
    throw new AcpClientError("capability_missing", "ACP agent did not advertise additionalDirectories.");
  }
  const mcpServers = validateMcpServers(
    params.mcpServers === undefined ? [] : params.mcpServers,
    descriptor,
    initializeResult,
  );
  return { ...params, additionalDirectories, mcpServers };
}

/** @param {any} params */
function validateSessionListRequest(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new AcpClientError("invalid_request", "ACP session/list request must be an object.");
  }
  if (params.cwd != null
    && (typeof params.cwd !== "string" || !isAbsolute(params.cwd))) {
    throw new AcpClientError("invalid_request", "ACP session/list cwd must be absolute.");
  }
  return params;
}

/** @param {any[]} servers @param {any} descriptor @param {any} initializeResult */
function validateMcpServers(servers, descriptor, initializeResult) {
  if (!Array.isArray(servers)) throw new AcpClientError("invalid_request", "ACP mcpServers must be an array.");
  if (descriptor.mcpOwner === "agent") {
    if (servers.length > 0) {
      throw new AcpClientError("ownership_conflict", "Agent-owned MCP configuration cannot receive client MCP servers.");
    }
    return [];
  }
  const policy = descriptor.capabilityPolicy?.mcp || {};
  const agentMcp = initializeResult.agentCapabilities?.mcpCapabilities || {};
  return servers.map((server) => {
    if (!server || typeof server !== "object" || Array.isArray(server)) {
      throw new AcpClientError("invalid_request", "ACP MCP server entry must be an object.");
    }
    const type = server.type || "stdio";
    if (type === "stdio") {
      if (policy.stdio !== true) throw new AcpClientError("capability_missing", "ACP stdio MCP is disabled by profile policy.");
      if (typeof server.command !== "string" || !isAbsolute(server.command)) {
        throw new AcpClientError("invalid_request", "ACP stdio MCP command must be absolute.");
      }
      stringArray(server.args, "ACP MCP args");
      if (!Array.isArray(server.env)) throw new AcpClientError("invalid_request", "ACP MCP env must be an array.");
      return server;
    }
    if (type === "http") {
      if (policy.http !== true || agentMcp.http !== true) {
        throw new AcpClientError("capability_missing", "ACP HTTP MCP was not mutually enabled.");
      }
      return server;
    }
    if (type === "sse") {
      if (policy.sse !== true || agentMcp.sse !== true) {
        throw new AcpClientError("capability_missing", "ACP SSE MCP was not mutually enabled.");
      }
      return server;
    }
    throw new AcpClientError("capability_missing", "Unsupported ACP MCP transport.");
  });
}

/** @param {string} profileId @param {any} request */
function protocolSessionListRequest(profileId, request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new AcpClientError("invalid_request", "ACP session/list request must be an object.");
  }
  const { cursor, _meta: _meta, ...rest } = request;
  return {
    ...rest,
    ...(cursor == null ? {} : { cursor: decodeAcpSessionCursor(profileId, cursor) }),
  };
}

/** Remove extension metadata recursively from operation results. @param {any} value */
function withoutMeta(value) {
  if (Array.isArray(value)) return value.map(withoutMeta);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "_meta") result[key] = withoutMeta(item);
  }
  return result;
}

/** @param {any} initializeResult @param {string} profileId */
function probeResult(initializeResult, profileId) {
  return {
    profileId,
    protocolVersion: initializeResult.protocolVersion,
    agentInfo: initializeResult.agentInfo
      ? withoutMeta(initializeResult.agentInfo)
      : null,
    agentCapabilities: withoutMeta(initializeResult.agentCapabilities || {}),
    authMethods: (initializeResult.authMethods || []).map((method) => ({
      id: method.id,
      name: method.name,
      type: method.type || "agent",
    })),
  };
}

/** @param {string} profileId @param {AcpClientHostOptions} options */
export async function probeAcpProfile(profileId, options) {
  const connection = await connectAcpProfile(profileId, { ...options, operation: "probe" });
  try {
    return probeResult(connection.initializeResult, profileId);
  } finally {
    await connection.close();
  }
}

/** @param {string} profileId @param {string} methodId @param {AcpClientHostOptions} options */
export async function authenticateAcpProfile(profileId, methodId, options) {
  requiredString(methodId, "ACP authentication method id");
  const connection = await connectAcpProfile(profileId, { ...options, operation: "authenticate" });
  try {
    await connection.authenticate(methodId);
    return { profileId, methodId, authenticated: true };
  } finally {
    await connection.close();
  }
}

/** @param {string} profileId @param {AcpClientHostOptions} options */
export async function logoutAcpProfile(profileId, options) {
  const connection = await connectAcpProfile(profileId, { ...options, operation: "logout" });
  try {
    await connection.logout();
    return { profileId, loggedOut: true };
  } finally {
    await connection.close();
  }
}

/**
 * @param {string} profileId
 * @param {{cwd?: string|null, cursor?: string|null}} [request]
 * @param {AcpClientHostOptions} [options]
 * @returns {Promise<AcpSessionListResult>}
 */
export async function listAcpSessions(profileId, request = {}, options = /** @type {any} */ ({})) {
  const protocolRequest = protocolSessionListRequest(profileId, request);
  const connection = await connectAcpProfile(profileId, { ...options, operation: "list_sessions" });
  try {
    const result = await connection.listSessions(protocolRequest);
    return {
      profileId,
      sessions: (result.sessions || []).map((session) => ({
        ...sanitizeAcpHostValue(session, [session.sessionId, result.nextCursor]),
        providerSessionId: encodeAcpProviderSessionId(profileId, session.sessionId),
      })),
      nextCursor: typeof result.nextCursor === "string"
        ? encodeAcpSessionCursor(profileId, result.nextCursor)
        : null,
    };
  } finally {
    await connection.close();
  }
}

/** @param {string} providerSessionId @param {AcpClientHostOptions} options */
export async function deleteAcpSession(providerSessionId, options) {
  const { profileId, sessionId } = decodeAcpProviderSessionId(providerSessionId);
  const connection = await connectAcpProfile(profileId, { ...options, operation: "delete_session" });
  try {
    await connection.deleteSession(sessionId);
    return { profileId, providerSessionId, deleted: true };
  } finally {
    await connection.close();
  }
}

export { PROTOCOL_VERSION as ACP_PROTOCOL_VERSION };
