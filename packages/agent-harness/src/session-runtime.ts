import {
  modelReferenceKey,
  parseMonoRuntimeModelReference,
  type MonoRuntimeLike,
  type RuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import type { AgentHarnessOptions } from "./types.js";

export interface ProviderSessionHandle {
  readonly providerSessionId: string;
  readonly modelKey?: string;
}

export type SessionRuntimeResolver = (modelKey?: string) => MonoRuntimeLike;

/** Normalize accepted input aliases before writing a strict persisted binding. */
export function sessionModelKey(model: RuntimeModelReference): string {
  return modelReferenceKey(parseMonoRuntimeModelReference(modelReferenceKey(model)));
}

/** Persisted keys are canonical references, never aliases or routing guesses. */
export function assertSessionModelKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || modelReferenceKey(parseMonoRuntimeModelReference(value)) !== value) {
    throw new TypeError("Session modelKey must be a canonical model reference.");
  }
}

/** Resolve each session's owner with stable runtime identity for this lifetime. */
export function createSessionRuntimeResolver(
  options: Pick<AgentHarnessOptions, "runtime" | "model" | "runtimeForModel">,
): SessionRuntimeResolver {
  const defaultKey = sessionModelKey(options.model);
  const runtimes = new Map<string, MonoRuntimeLike>([[defaultKey, options.runtime]]);
  return (modelKey) => {
    if (modelKey === undefined) return options.runtime;
    assertSessionModelKey(modelKey);
    const cached = runtimes.get(modelKey);
    if (cached !== undefined) return cached;
    const runtime = options.runtimeForModel?.(parseMonoRuntimeModelReference(modelKey)) ?? options.runtime;
    runtimes.set(modelKey, runtime);
    return runtime;
  };
}

/** Reject contradictory ownership before any destructive operation starts. */
export function uniqueSessionHandles(handles: readonly ProviderSessionHandle[]): readonly ProviderSessionHandle[] {
  const unique = new Map<string, ProviderSessionHandle>();
  for (const handle of handles) {
    if (handle.modelKey !== undefined) assertSessionModelKey(handle.modelKey);
    const prior = unique.get(handle.providerSessionId);
    if (prior?.modelKey !== undefined && handle.modelKey !== undefined && prior.modelKey !== handle.modelKey) {
      throw new Error("Provider session has conflicting model bindings.");
    }
    if (prior === undefined || handle.modelKey !== undefined) unique.set(handle.providerSessionId, handle);
  }
  return [...unique.values()];
}
