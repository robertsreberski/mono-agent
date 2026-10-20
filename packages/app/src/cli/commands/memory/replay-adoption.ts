import { effectiveEmbeddingIdentity } from "@mono-agent/memory/search";
import type { LegacyReplayAdoptionResult } from "@mono-agent/memory/bujo";

import { hasLiveConfiguredAgent, memoryRegistryDirs } from "./context.js";
import { renderReplayAdoption, write } from "./render.js";
import { writeReplayAdoptionCliFailure } from "./replay-failure.js";
import { loadBujoModule } from "./store-access.js";
import type { MemoryCommandContext } from "./types.js";

export async function runReplayAdoption(
  context: MemoryCommandContext,
  json: boolean,
): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined || memory.mode !== "bujo" || memory.embeddings === undefined) {
    writeReplayAdoptionCliFailure(json, "replay_adoption_requires_bujo");
    return 1;
  }

  try {
    const registryDirs = await memoryRegistryDirs(context);
    if (await hasLiveConfiguredAgent(context.configPath, registryDirs)) {
      writeReplayAdoptionCliFailure(json, "replay_adoption_agent_running");
      return 1;
    }
    const { adoptLegacyReplayProjection, readManagedIndexManifest } = await loadBujoModule();
    // Re-check after the lazy module load so a configured process cannot race
    // the SSH-only stopped-store precondition during setup. The package also
    // takes the memory-root writer lease and SQLite writer fence.
    if (await hasLiveConfiguredAgent(context.configPath, registryDirs)) {
      writeReplayAdoptionCliFailure(json, "replay_adoption_agent_running");
      return 1;
    }
    const adopted = await adoptLegacyReplayProjection({
      root: memory.path,
      mode: "bujo",
      // A stopped legacy store predates instruction presets unless its
      // managed generation was rebuilt with one.
      embeddingModel: effectiveEmbeddingIdentity(
        memory.embeddings,
        readManagedIndexManifest(memory.path)?.active.embeddingModel
          ?? `${memory.embeddings.provider}:${memory.embeddings.model}`,
      ),
      dimension: memory.embeddings.dim ?? 768,
    });
    const result = publicReplayAdoptionResult(adopted);
    write(json, result, () => renderReplayAdoption(result));
    return 0;
  } catch {
    // Adoption is a privacy boundary. Do not classify or interpolate the
    // package/native error: it may contain paths, record ids, marker bytes, or
    // model-owned text. Operators get a stable remediation contract instead.
    writeReplayAdoptionCliFailure(json, "replay_adoption_failed");
    return 1;
  }
}

function publicReplayAdoptionResult(result: LegacyReplayAdoptionResult): LegacyReplayAdoptionResult {
  const counts = result.counts;
  if (result.backend !== "bujo" || result.mode !== "bujo" || result.status !== "adopted"
    || result.rebuildRequired !== true || !/^[a-f0-9]{64}$/u.test(result.authorityDigest)
    || !isSafeAggregateCount(counts.terminals)
    || !isSafeAggregateCount(counts.supersedes)
    || !isSafeAggregateCount(counts.threads)) {
    throw new Error("invalid private adoption result");
  }
  return {
    backend: "bujo",
    mode: "bujo",
    status: "adopted",
    counts: {
      terminals: counts.terminals,
      supersedes: counts.supersedes,
      threads: counts.threads,
    },
    authorityDigest: result.authorityDigest,
    rebuildRequired: true,
  };
}

function isSafeAggregateCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
