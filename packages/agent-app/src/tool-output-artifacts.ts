import { createToolHistoryArtifactSink } from "@mono-agent/agent-harness";

import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";

/** Attach the configured app's artifact sink after every caller-owned extension. */
export function createToolOutputArtifactsRuntimeExtension(
  next: RuntimeOptionsExtension | undefined,
  artifactRoot: string,
): RuntimeOptionsExtension {
  return async (input) => {
    const result = next === undefined
      ? { runtimeOptions: {} }
      : await next(input);
    return {
      ...result,
      runtimeOptions: {
        ...(result.runtimeOptions ?? {}),
        persistArtifact: createToolHistoryArtifactSink({ artifactRoot, runId: input.runId }),
      },
    };
  };
}
