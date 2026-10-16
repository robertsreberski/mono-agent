
import type { MonoAgentConfigJson } from "../json-types.js";

import type { ConfigViewSection } from "./types.js";

/**
 * Find advisory warnings for secret-marked fields whose resolved source is the
 * committed JSON config. Core secrets use JSON apiKeyEnv references; adapter
 * secrets retain their independently supported env names. No value is emitted.
 */
export function findJsonSecretConfigWarnings(
  sections: readonly ConfigViewSection[],
): readonly string[] {
  const warnings: string[] = [];
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.redacted !== true || field.source !== "json") {
        continue;
      }
      if (field.id === "memory.embeddings.apiKey") {
        warnings.push("[WARN] memory.embeddings.apiKey is a secret read from mono-agent.config.json — put it in an environment variable of your choice and set memory.embeddings.apiKeyEnv in JSON to that variable's name.");
      } else if (field.envKey !== undefined) {
        warnings.push(`[WARN] ${field.id} is a secret read from mono-agent.config.json — move it to .env (${field.envKey}).`);
      }
    }
  }
  return warnings;
}

interface RemovedConfigWarningsInput {
  readonly json: MonoAgentConfigJson;
}

/** Find migration warnings only for retired JSON keys. Stale core env is ignored. */
export function findRemovedConfigWarnings(input: RemovedConfigWarningsInput): readonly string[] {
  const warnings: string[] = [];
  if (input.json.memory?.reflection !== undefined) {
    warnings.push("[WARN] memory.reflection is removed and ignored; use memory.consolidation instead.");
  }
  if (input.json.memory?.migration !== undefined) {
    warnings.push("[WARN] memory.migration is removed and ignored; use memory.consolidation instead.");
  }
  return warnings;
}
