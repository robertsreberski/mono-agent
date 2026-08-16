import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  failClosedSandboxPolicy,
  mergeSandboxPolicies,
  protectSandboxRoots,
  type RuntimeModelReference,
  type SandboxEngine,
  type SandboxPolicy,
} from "@mono-agent/runtime-adapter";

import type { ChannelId } from "./channels.js";
import type { AgentRootOwnership, AgentRootRequestLease } from "./agent-root-coordinator.js";
import {
  attestProcessJobsRootRegistrySnapshot,
  processJobsProtectionPolicyRoots,
  type ProcessJobsRootRegistrySnapshot,
} from "./process-jobs-root-registry.js";
import {
  processJobWakeContextForRequest,
  registerProcessJobSteeringTarget,
  type ProcessJobSteeringTargetLease,
} from "./process-jobs-context.js";
import type { ProcessJobsServiceHandle } from "./process-jobs-service.js";
import type { ProcessJobsProtectionPosture } from "./process-jobs-protection.js";
import {
  isProcessJobOriginRecord,
  type ProcessJobOriginRecord,
} from "./process-jobs-store.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";

export interface ProcessJobsRuntimeExtensionOptions {
  readonly next?: RuntimeOptionsExtension;
  readonly ownership: AgentRootOwnership;
  readonly registry: ProcessJobsRootRegistrySnapshot;
  /** Optional because configured private state remains protected when the store cannot open. */
  readonly service: ProcessJobsServiceHandle | undefined;
  readonly coreConfig: MonoAgentConfig;
  readonly baseModel: RuntimeModelReference;
  readonly channelId: ChannelId | undefined;
  /** Explicit opted-in conversation scheme; legacy built-ins derive it from channelId. */
  readonly conversationScheme?: string | undefined;
  readonly sandboxEngine: SandboxEngine | undefined;
  /** App-private; omission preserves the fail-closed public/default behavior. */
  readonly protectionPosture?: ProcessJobsProtectionPosture;
  /** Agent-root-aware preflight for every route reachable by this request. */
  readonly routesOnlyPiNative?: (metadata: Record<string, unknown> | undefined) => boolean;
  /** Deterministic unit-test seam; official composition always uses durable re-attestation. */
  readonly attestRegistry?: typeof attestProcessJobsRootRegistrySnapshot;
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
    let result: Awaited<ReturnType<RuntimeOptionsExtension>> | undefined;
    let lease: AgentRootRequestLease | undefined;
    let steeringTarget: ProcessJobSteeringTargetLease | undefined;
    const attestRegistry = options.attestRegistry ?? attestProcessJobsRootRegistrySnapshot;
    try {
      const boundary = await attestRegistry(
        options.registry,
        options.coreConfig.runtime.workspace,
      );
      lease = options.ownership.coordinator.acquireRequestLease(boundary.generation);
      const attested = await attestRegistry(
        boundary,
        options.coreConfig.runtime.workspace,
      );
      const protectedRoots = processJobsProtectionPolicyRoots(attested);
      const retainedRoots = attested.kind === "ready";
      if (retainedRoots
        && options.routesOnlyPiNative !== undefined
        && !options.routesOnlyPiNative(input.request.metadata)) {
        throw new Error(PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR);
      }
      result = options.next === undefined
        ? { runtimeOptions: {}, cleanup: async () => {} }
        : await options.next(input);
      const effectiveModel = runtimeModel(result.runtimeOptions?.model) ?? options.baseModel;
      if (retainedRoots && effectiveModel.sdk !== "pi") {
        throw new Error(PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR);
      }
      let runtimeOptions = result.runtimeOptions ?? {};
      if (protectedRoots.length > 0 && options.protectionPosture?.suppressSyntheticSandbox !== true) {
        if (!await sandboxEngineAvailable(options.sandboxEngine)) {
          throw new Error(PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR);
        }
        runtimeOptions = {
          ...runtimeOptions,
          sandboxPolicy: mergeSandboxPolicies(
            runtimeOptions.sandboxPolicy as SandboxPolicy | undefined,
            processJobsSandboxPolicy({ coreConfig: options.coreConfig, protectedRoots }),
          ),
          sandboxEngine: options.sandboxEngine,
        };
      }
      if (options.service !== undefined) {
        const origin = processJobOriginForRequest(input, options.channelId, options.conversationScheme);
        const wake = processJobWakeContextForRequest(input.request);
        const chainDepth = wake.kind === "resolved" ? wake.context.chainDepth : 0;
        if (origin !== undefined && wake.kind !== "missed") {
          steeringTarget = registerProcessJobSteeringTarget({
            conversationId: origin.baseConversationId,
            runId: input.runId,
            chainDepth,
          });
        }
        if (origin !== undefined
          && wake.kind !== "missed"
          && chainDepth < options.service.settings.maxChainDepth
          && hasAllowedProcessTool(options.coreConfig)) {
          runtimeOptions = {
            ...runtimeOptions,
            processJobs: options.service.controller(
              origin,
              steeringTarget?.chainDepth ?? chainDepth,
            ),
          };
        }
      }
      const heldLease = lease;
      return {
        ...result,
        runtimeOptions,
        // Abort cleanup deliberately does not release the generation lease.
        ...(result.cleanup === undefined ? {} : { cleanup: result.cleanup }),
        settleCleanup: async () => {
          try {
            await result?.settleCleanup?.();
          } finally {
            try {
              steeringTarget?.release();
            } finally {
              heldLease.releaseAfterSettlement();
            }
          }
        },
      };
    } catch (error) {
      // Extension construction failed before the harness could own its cleanup.
      try {
        await result?.cleanup?.();
      } finally {
        try {
          await result?.settleCleanup?.();
        } finally {
          try {
            steeringTarget?.release();
          } finally {
            lease?.releaseAfterSettlement();
          }
        }
      }
      throw error;
    }
  };
}

export function processJobsSandboxPolicy(
  options: { readonly coreConfig: MonoAgentConfig; readonly protectedRoots: readonly string[] },
): SandboxPolicy {
  const configured = options.coreConfig.sandbox;
  const base = configured?.mode === "native"
    ? { ...configured, fallback: "fail-closed" as const, unsafeAllowHostProcess: false }
    : failClosedSandboxPolicy({
        root: options.coreConfig.runtime.workspace,
        network: { mode: "all" },
      });
  const workspace = resolve(options.coreConfig.runtime.workspace);
  for (const protectedRoot of options.protectedRoots) {
    const root = resolve(protectedRoot);
    if (protectedRootContainsWorkspace(root, workspace)) {
      throw new Error("Process-job private state cannot contain the model workspace.");
    }
  }
  return protectSandboxRoots(base, options.protectedRoots);
}

function protectedRootContainsWorkspace(protectedRoot: string, workspace: string): boolean {
  const workspaceFromRoot = relative(protectedRoot, workspace);
  return workspaceFromRoot === ""
    || (workspaceFromRoot !== ".."
      && !workspaceFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(workspaceFromRoot));
}

function runtimeModel(value: unknown): RuntimeModelReference | undefined {
  return typeof value === "object" && value !== null
    && typeof (value as { sdk?: unknown }).sdk === "string"
    && typeof (value as { model?: unknown }).model === "string"
    ? value as RuntimeModelReference
    : undefined;
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
  conversationScheme?: string,
): ProcessJobOriginRecord | undefined {
  const request = input.request;
  let channel = conversationScheme;
  if (channel === undefined && channelId === "slack") channel = "slack";
  else if (channel === undefined && channelId === "telegram") channel = "telegram";
  else if (channel === undefined && channelId === "tui"
    && request.metadata?.source === "web"
    && request.conversationId.startsWith("web:")
    && request.conversationId !== "web:new") channel = "web";
  if (channel === undefined) return undefined;
  if (!/^[a-z][a-z0-9-]*$/u.test(channel)) return undefined;

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

function matchesChannel(conversationId: string, channel: string): boolean {
  return conversationId.startsWith(`${channel}:`);
}

function normalizeReplyTarget(conversationId: string): string {
  return (conversationId.split("#", 1)[0] ?? conversationId).trim();
}
