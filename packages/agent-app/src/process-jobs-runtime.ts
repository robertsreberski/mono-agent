import { isAbsolute, relative, resolve } from "node:path";

import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  failClosedSandboxPolicy,
  protectSandboxRoots,
  type SandboxEngine,
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
  /** Optional because configured private state remains protected when the store cannot open. */
  readonly service: ProcessJobsServiceHandle | undefined;
  readonly stateDir: string;
  readonly coreConfig: MonoAgentConfig;
  readonly channelId: ChannelId | undefined;
  readonly sandboxEngine: SandboxEngine | undefined;
  /** True only when every reachable effective primary/fallback route is Pi-native. */
  readonly targetsPiNative: (metadata: Record<string, unknown> | undefined) => boolean;
}

export const PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR =
  "Process-job private state requires a Pi-native runtime.";
export const PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR =
  "Process-job private state protection is unavailable.";

/** Inject the controller only for a Pi-native, wake-capable, normally allowed turn. */
export function createProcessJobsRuntimeExtension(
  options: ProcessJobsRuntimeExtensionOptions,
): RuntimeOptionsExtension {
  return async (input) => {
    if (!options.targetsPiNative(input.request.metadata)) {
      throw new Error(PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR);
    }
    const sandboxPolicy = processJobsSandboxPolicy(options);
    if (!await sandboxEngineAvailable(options.sandboxEngine)) {
      throw new Error(PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR);
    }
    const protectedRuntimeOptions = {
      sandboxPolicy,
      sandboxEngine: options.sandboxEngine,
    };
    if (options.service === undefined) {
      return { runtimeOptions: protectedRuntimeOptions, cleanup: async () => {} };
    }
    const origin = processJobOriginForRequest(input, options.channelId);
    const wake = processJobWakeContextForRequest(input.request);
    const chainDepth = wake.kind === "resolved" ? wake.context.chainDepth : 0;
    if (origin === undefined
      || wake.kind === "missed"
      || chainDepth >= options.service.settings.maxChainDepth
      || !hasAllowedProcessTool(options.coreConfig)) {
      return { runtimeOptions: protectedRuntimeOptions, cleanup: async () => {} };
    }
    return {
      runtimeOptions: {
        processJobs: options.service.controller(origin, chainDepth),
        ...protectedRuntimeOptions,
      },
      cleanup: async () => {},
    };
  };
}

export function processJobsSandboxPolicy(
  options: Pick<ProcessJobsRuntimeExtensionOptions, "coreConfig" | "stateDir">,
): SandboxPolicy {
  const configured = options.coreConfig.sandbox;
  const base = configured?.mode === "native"
    ? { ...configured, fallback: "fail-closed" as const, unsafeAllowHostProcess: false }
    : failClosedSandboxPolicy({
        root: options.coreConfig.runtime.workspace,
        network: { mode: "all" },
      });
  const workspace = resolve(options.coreConfig.runtime.workspace);
  const stateDir = resolve(options.stateDir);
  const fromState = relative(stateDir, workspace);
  if (fromState === "" || (!fromState.startsWith("..") && !isAbsolute(fromState))) {
    throw new Error("Process-job private state cannot contain the model workspace.");
  }
  return protectSandboxRoots(base, [stateDir]);
}

async function sandboxEngineAvailable(engine: SandboxEngine | undefined): Promise<boolean> {
  if (engine === undefined) return false;
  try {
    return await engine.isAvailable();
  } catch {
    return false;
  }
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
