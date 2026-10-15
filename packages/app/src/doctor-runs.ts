import type { MonoAgentConfig } from "@mono-agent/config";
import { listRecordedRuns } from "@mono-agent/observability";

import { resolveAppArtifactDir } from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import type { ValidationSection } from "./doctor-types.js";
import { buildRunsHealthDisplay, RUNS_HEALTH_MAX_RUNS } from "./runs-health.js";

export async function runsSection(
  input: MonoAgentAppConfigInput,
  config: MonoAgentConfig | undefined,
): Promise<ValidationSection> {
  const artifactDir = await resolveAppArtifactDir(input);
  const { totalRuns, runs, warnings } = await listRecordedRuns({
    artifactDir,
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    scope: "agent",
  });
  const display = buildRunsHealthDisplay({ artifactDir, totalRuns, runs, warnings });
  const retentionDetails = config === undefined
    ? []
    : [
        `Artifact retention: maxAgeDays=${config.artifacts.retention.maxAgeDays}, maxCount=${config.artifacts.retention.maxCount}, dryRun=${config.artifacts.retention.dryRun ? "true" : "false"}.`,
        `Memory artifact retention: maxAgeDays=${config.artifacts.memoryRetention.maxAgeDays}, maxCount=${config.artifacts.memoryRetention.maxCount}, dryRun=${config.artifacts.memoryRetention.dryRun ? "true" : "false"}.`,
      ];
  return { id: "runs", label: "Runs health", status: display.status, details: [...retentionDetails, ...display.details] };
}
