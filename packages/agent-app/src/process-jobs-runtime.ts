import { dirname, resolve } from "node:path";

import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  failClosedSandboxPolicy,
  protectSandboxRoots,
  type SandboxPolicy,
} from "@mono-agent/runtime-adapter";

import type { ChannelId } from "./channels.js";
import { processJobWakeContextForRequest } from "./process-jobs-context.js";
import type { ProcessJobsServiceHandle } from "./process-jobs-service.js";
import {
  isProcessJobOriginRecord,
  type ProcessJobOriginRecord,
} from "./process-jobs-store.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";

export interface ProcessJobsRuntimeExtensionOptions {
  readonly service: ProcessJobsServiceHandle;
  readonly coreConfig: MonoAgentConfig;
  readonly channelId: ChannelId | undefined;
  readonly targetsPiNative: (metadata: Record<string, unknown> | undefined) => boolean;
}

/** Inject the controller only for a Pi-native, wake-capable, normally allowed turn. */
export function createProcessJobsRuntimeExtension(
  options: ProcessJobsRuntimeExtensionOptions,
): RuntimeOptionsExtension {
  return async (input) => {
    const origin = processJobOriginForRequest(input, options.channelId);
    const wake = processJobWakeContextForRequest(input.request);
    const chainDepth = wake.kind === "resolved" ? wake.context.chainDepth : 0;
    if (origin === undefined
      || wake.kind === "missed"
      || chainDepth >= options.service.settings.maxChainDepth
      || !options.targetsPiNative(input.request.metadata)
      || !hasAllowedProcessTool(options.coreConfig)) {
      return { runtimeOptions: {}, cleanup: async () => {} };
    }
    return {
      runtimeOptions: {
        processJobs: options.service.controller(origin, chainDepth),
        sandboxPolicy: processJobsSandboxPolicy(options),
      },
      cleanup: async () => {},
    };
  };
}

function processJobsSandboxPolicy(options: ProcessJobsRuntimeExtensionOptions): SandboxPolicy {
  const configured = options.coreConfig.sandbox;
  const base = configured?.mode === "native"
    ? { ...configured, fallback: "fail-closed" as const, unsafeAllowHostProcess: false }
    : failClosedSandboxPolicy({ root: options.coreConfig.runtime.workspace });
  return protectSandboxRoots(base, [processJobsPrivateRoot(
    options.coreConfig.runtime.workspace,
    options.service.settings.stateDir,
  )]);
}

/**
 * Protect the immediate host-private container so renaming it cannot bypass
 * the state-root deny. A direct workspace child protects only itself; the
 * whole model workspace must remain usable.
 */
function processJobsPrivateRoot(workspace: string, stateDir: string): string {
  const root = resolve(workspace);
  const state = resolve(stateDir);
  const parent = dirname(state);
  return parent === root || parent === state ? state : parent;
}

/** Strict host-origin classifier. Unsupported trigger surfaces never receive a controller. */
export function processJobOriginForRequest(
  input: Pick<AgentHarnessRuntimeOptionsInput, "request" | "runId">,
  channelId: ChannelId | undefined,
): ProcessJobOriginRecord | undefined {
  const request = input.request;
  let channel: ProcessJobOriginRecord["channel"] | undefined;
  if (channelId === "slack") channel = "slack";
  else if (channelId === "telegram") channel = "telegram";
  else if (channelId === "tui"
    && request.metadata?.source === "web"
    && request.conversationId.startsWith("web:")
    && request.conversationId !== "web:new") channel = "web";
  if (channel === undefined) return undefined;

  const conversationId = request.conversationId;
  const hash = conversationId.indexOf("#");
  const baseConversationId = hash < 0 ? conversationId : conversationId.slice(0, hash);
  const bucket = hash < 0 ? null : conversationId.slice(hash + 1) || null;
  const replyToConversationId = normalizeReplyTarget(request.replyTo?.conversationId ?? baseConversationId);
  if (!matchesChannel(replyToConversationId, channel)) return undefined;
  const origin: ProcessJobOriginRecord = {
    conversationId,
    baseConversationId,
    bucket,
    replyToConversationId,
    normalizedReplyTarget: replyToConversationId,
    runId: input.runId,
    historyBoundary: input.runId,
    channel,
  };
  return isProcessJobOriginRecord(origin) ? origin : undefined;
}

function hasAllowedProcessTool(config: MonoAgentConfig): boolean {
  const allowed = config.tools.allowedTools;
  const denied = new Set(config.tools.disallowedTools.map((name) => name.toLowerCase()));
  const allowAll = allowed.some((name) => name === "*");
  return ["Exec", "Bash"].some((name) =>
    !denied.has(name.toLowerCase())
    && (allowAll || allowed.some((allowedName) => allowedName.toLowerCase() === name.toLowerCase())));
}

function matchesChannel(conversationId: string, channel: ProcessJobOriginRecord["channel"]): boolean {
  return conversationId.startsWith(`${channel}:`);
}

function normalizeReplyTarget(conversationId: string): string {
  return (conversationId.split("#", 1)[0] ?? conversationId).trim();
}
