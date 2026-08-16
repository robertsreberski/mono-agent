import type {
  AgentHarnessRuntimeOptionsExtension,
  AgentHarnessRuntimeOptionsInput,
} from "@mono-agent/agent-harness";
import {
  failClosedSandboxPolicy,
  mergeSandboxPolicies,
  protectSandboxRoots,
  type RuntimeModelReference,
  type SandboxPolicy,
} from "@mono-agent/runtime-adapter";

import {
  assertClearSessionsRecoveryResolved,
  clearSessionsRegistryRoot,
} from "./sessions.js";

export type RuntimeOptionsExtension = (
  input: AgentHarnessRuntimeOptionsInput,
) => AgentHarnessRuntimeOptionsExtension | Promise<AgentHarnessRuntimeOptionsExtension>;

export interface RuntimeOptionsCompositionOptions {
  /**
   * Internal extensions whose request-scoped MCP servers remain available
   * inside a later authoritative tool-policy override. This is deliberately
   * extension-identity based: an arbitrary caller cannot preserve a server by
   * merely reusing a trusted server name.
   */
  readonly preserveMcpServersUnderOverride?: readonly RuntimeOptionsExtension[];
}

export interface ClearSessionsRuntimeBoundaryOptions {
  readonly cwd: string;
  readonly workspace: string;
  readonly baseModel: RuntimeModelReference;
  readonly fallbackModels?: readonly RuntimeModelReference[];
  readonly sandboxPolicy?: SandboxPolicy;
  /** @internal App-validated trusted-host posture; recovery attestation remains mandatory. */
  readonly suppressSyntheticSandbox?: boolean;
  /** Test seam; production always uses the sessions-owned attestation. */
  readonly assertRecoveryResolved?: (cwd: string) => Promise<void>;
  /** Test seam; production always uses the stable sessions-owned registry root. */
  readonly registryRoot?: (cwd: string) => string;
}

/**
 * Run the recovery attestation before any sibling extension/provider work,
 * then protect the stable registry whenever a reachable attempt can execute
 * Pi-native host tools. Per-route-native routing removes this policy from
 * non-Pi attempts; a genuinely non-Pi-only route stays policy-free here.
 */
export function createClearSessionsRuntimeExtension(
  next: RuntimeOptionsExtension | undefined,
  options: ClearSessionsRuntimeBoundaryOptions,
): RuntimeOptionsExtension {
  return async (input) => {
    await (options.assertRecoveryResolved ?? assertClearSessionsRecoveryResolved)(options.cwd);
    const result = next === undefined
      ? { runtimeOptions: {}, cleanup: async () => {} }
      : await next(input);
    const effectiveModel = runtimeModel(result.runtimeOptions?.model) ?? options.baseModel;
    const registryPolicy = clearSessionsSandboxPolicy(options, effectiveModel);
    if (registryPolicy === undefined) return result;
    const runtimeOptions: Record<string, unknown> = {};
    mergeRuntimeOptions(runtimeOptions, result.runtimeOptions);
    mergeRuntimeOptions(runtimeOptions, { sandboxPolicy: registryPolicy });
    return { ...result, runtimeOptions };
  };
}

/** Build the stable tool-context half of the clear-sessions boundary. */
export function clearSessionsSandboxPolicy(
  options: ClearSessionsRuntimeBoundaryOptions,
  effectiveModel: RuntimeModelReference = options.baseModel,
): SandboxPolicy | undefined {
  if (options.suppressSyntheticSandbox === true) return undefined;
  if (![effectiveModel, ...(options.fallbackModels ?? [])].some((model) => model.sdk === "pi")) {
    return undefined;
  }
  const base = options.sandboxPolicy?.mode === "native"
    ? { ...options.sandboxPolicy, fallback: "fail-closed" as const, unsafeAllowHostProcess: false }
    : failClosedSandboxPolicy({
        root: options.workspace,
        network: { mode: "all" },
      });
  return protectSandboxRoots(base, [
    (options.registryRoot ?? clearSessionsRegistryRoot)(options.cwd),
  ]);
}

/** Compose request-scoped runtime extensions without dropping tools or cleanup hooks. */
export function composeRuntimeOptionExtensions(
  extensions: ReadonlyArray<RuntimeOptionsExtension | undefined>,
  options: RuntimeOptionsCompositionOptions = {},
): RuntimeOptionsExtension | undefined {
  const active = extensions.filter((extension): extension is RuntimeOptionsExtension => extension !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  return async (input) => {
    const settled = await Promise.allSettled(active.map((extension) => extension(input)));
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      await Promise.all(settled.map(async (result) => {
        if (result.status === "fulfilled") {
          await Promise.resolve(result.value.cleanup?.()).catch(() => undefined);
          await Promise.resolve(result.value.settleCleanup?.()).catch(() => undefined);
        }
      }));
      throw failures[0]!.reason;
    }

    const results = settled.map((result) => (result as PromiseFulfilledResult<AgentHarnessRuntimeOptionsExtension>).value);
    const runtimeOptions: Record<string, unknown> = {};
    for (const result of results) mergeRuntimeOptions(runtimeOptions, result.runtimeOptions);
    let toolPolicyOverride: AgentHarnessRuntimeOptionsExtension["toolPolicyOverride"];
    for (const result of results) {
      if (result.toolPolicyOverride !== undefined) toolPolicyOverride = result.toolPolicyOverride;
    }
    if (toolPolicyOverride !== undefined) {
      const preservedServers: Record<string, unknown> = {};
      const preservedExtensions = new Set(options.preserveMcpServersUnderOverride ?? []);
      for (const [index, extension] of active.entries()) {
        if (!preservedExtensions.has(extension)) continue;
        const servers = results[index]?.runtimeOptions?.mcpServers;
        if (isRecord(servers)) Object.assign(preservedServers, servers);
      }
      toolPolicyOverride = {
        ...toolPolicyOverride,
        ...(toolPolicyOverride.mcpServers === undefined && Object.keys(preservedServers).length === 0
          ? {}
          : {
              mcpServers: {
                ...(toolPolicyOverride.mcpServers ?? {}),
                ...preservedServers,
              },
            }),
      };
    }
    return {
      runtimeOptions,
      ...(toolPolicyOverride === undefined ? {} : { toolPolicyOverride }),
      cleanup: async () => {
        await Promise.all(results.map(async (result) => result.cleanup?.()));
      },
      settleCleanup: async () => {
        await Promise.all(results.map(async (result) => result.settleCleanup?.()));
      },
    };
  };
}

function mergeRuntimeOptions(
  target: Record<string, unknown>,
  next: AgentHarnessRuntimeOptionsExtension["runtimeOptions"],
): void {
  if (next === undefined) return;
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    if (key === "allowedTools" || key === "disallowedTools") {
      target[key] = mergeStringLists(target[key], value);
      continue;
    }
    if (key === "mcpServers") {
      target[key] = {
        ...(isRecord(target[key]) ? target[key] : {}),
        ...(isRecord(value) ? value : {}),
      };
      continue;
    }
    if (key === "sandboxPolicy") {
      target[key] = mergeSandboxPolicies(asSandboxPolicy(target[key]), asSandboxPolicy(value));
      continue;
    }
    target[key] = value;
  }
}

function mergeStringLists(current: unknown, next: unknown): readonly string[] {
  const out: string[] = [];
  for (const list of [current, next]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string" && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSandboxPolicy(value: unknown): SandboxPolicy | undefined {
  return isRecord(value) ? value as unknown as SandboxPolicy : undefined;
}

function runtimeModel(value: unknown): RuntimeModelReference | undefined {
  return isRecord(value)
    && typeof value.sdk === "string"
    && typeof value.model === "string"
    ? value as unknown as RuntimeModelReference
    : undefined;
}
