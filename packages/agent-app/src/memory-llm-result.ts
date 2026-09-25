import type { RuntimeResult } from "@mono-agent/runtime-adapter";

export interface MemoryRuntimeResultOptions {
  readonly timedOut?: boolean;
  readonly timeoutMs?: number;
  readonly structuredOutputRequested?: boolean;
  readonly structuredResultKey?: string;
}

/**
 * Convert one settled memory-runtime result into the memory package's text
 * completion contract. Runtime settlement is authoritative; structured payloads
 * are serialized only after success and are never replaced by free-form text.
 */
export function textFromMemoryRuntimeResult(
  result: RuntimeResult,
  opts?: MemoryRuntimeResultOptions,
): string {
  if (result.cancelled === true) {
    if (opts?.timedOut === true) {
      throw new Error(`agent-host memory LLM timed out after ${opts.timeoutMs ?? "?"}ms (provider too slow or unavailable).`);
    }
    throw new Error("agent-host memory LLM run was cancelled.");
  }
  if (typeof result.failureKind === "string" && result.failureKind.length > 0) {
    // Preserve the runtime's typed failure kind for callers that must distinguish
    // an operator-fixable credential failure from a transient model outage.
    throw Object.assign(new Error(`agent-host memory LLM failed (${result.failureKind}): ${result.error ?? "unknown error"}`),
      { code: result.failureKind });
  }
  if (typeof result.error === "string" && result.error.length > 0) {
    throw new Error(`agent-host memory LLM failed: ${result.error}`);
  }
  if (opts?.structuredOutputRequested === true) {
    if (result.structuredResult === undefined) {
      throw new Error("agent-host memory LLM completed without the required structured result.");
    }
    let structuredResult: unknown = result.structuredResult;
    if (opts.structuredResultKey !== undefined) {
      if (typeof structuredResult !== "object" || structuredResult === null || Array.isArray(structuredResult)
        || !Object.prototype.hasOwnProperty.call(structuredResult, opts.structuredResultKey)) {
        throw new Error(`agent-host memory LLM structured result is missing ${opts.structuredResultKey}.`);
      }
      structuredResult = (structuredResult as Readonly<Record<string, unknown>>)[opts.structuredResultKey];
    }
    const serialized = JSON.stringify(structuredResult);
    if (serialized === undefined) {
      throw new Error("agent-host memory LLM returned an unserializable structured result.");
    }
    return serialized;
  }
  return typeof result.text === "string" ? result.text : "";
}
