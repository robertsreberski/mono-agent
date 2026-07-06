import type { ArtifactRetentionConfig } from "@mono-agent/config";
import { pruneRunArtifacts } from "@mono-agent/observability";
import type { PruneRunArtifactsResult, RunArtifactScope } from "@mono-agent/observability";

export const DEFAULT_ARTIFACT_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface ArtifactRetentionLogger {
  readonly info?: (message: string, meta?: Record<string, unknown>) => void;
  readonly warn?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface RunArtifactRetentionPassInput {
  readonly artifactDir: string;
  readonly retention: ArtifactRetentionConfig;
  readonly scope?: Extract<RunArtifactScope, "agent" | "memory">;
  readonly logger?: ArtifactRetentionLogger;
  readonly clock?: () => number;
  readonly shouldContinue?: () => boolean;
}

export interface StartArtifactRetentionSchedulerInput extends RunArtifactRetentionPassInput {
  readonly memoryRetention?: ArtifactRetentionConfig;
  readonly sweepIntervalMs?: number;
  readonly beforeFirstRun?: () => Promise<void>;
  readonly setInterval?: (callback: () => void, ms: number) => { readonly unref?: () => void };
  readonly clearInterval?: (handle: unknown) => void;
}

export interface RunningArtifactRetentionScheduler {
  readonly stop: () => void;
  readonly runNow: () => Promise<void>;
}

export async function runArtifactRetentionPass(
  input: RunArtifactRetentionPassInput,
): Promise<PruneRunArtifactsResult> {
  const scope = input.scope ?? "agent";
  const result = await pruneRunArtifacts({
    artifactDir: input.artifactDir,
    scope,
    maxAgeDays: input.retention.maxAgeDays,
    maxCount: input.retention.maxCount,
    dryRun: input.retention.dryRun,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.shouldContinue === undefined ? {} : { shouldContinue: input.shouldContinue }),
  });
  logArtifactRetentionResult(input.logger, result, scope);
  return result;
}

export function startArtifactRetentionScheduler(
  input: StartArtifactRetentionSchedulerInput,
): RunningArtifactRetentionScheduler {
  const setIntervalFn = input.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn = input.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const sweepIntervalMs = input.sweepIntervalMs ?? DEFAULT_ARTIFACT_RETENTION_SWEEP_INTERVAL_MS;
  let stopped = false;
  let firstRunPending = true;
  let inFlight: Promise<void> | undefined;

  async function run(): Promise<void> {
    if (stopped) {
      return;
    }
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    inFlight = (async () => {
      if (firstRunPending) {
        firstRunPending = false;
        await input.beforeFirstRun?.();
      }
      if (stopped) {
        return;
      }
      await runArtifactRetentionPass({
        ...input,
        scope: "agent",
        shouldContinue: () => !stopped && (input.shouldContinue?.() ?? true),
      });
      if (stopped) {
        return;
      }
      if (input.memoryRetention !== undefined) {
        await runArtifactRetentionPass({
          ...input,
          scope: "memory",
          retention: input.memoryRetention,
          shouldContinue: () => !stopped && (input.shouldContinue?.() ?? true),
        });
      }
    })().catch((error: unknown) => {
      input.logger?.warn?.("Artifact retention sweep failed.", { reason: reasonOf(error) });
    }).finally(() => {
      inFlight = undefined;
    });
    await inFlight;
  }

  void run();
  const handle = setIntervalFn(() => {
    void run();
  }, sweepIntervalMs);
  handle.unref?.();

  return {
    stop() {
      stopped = true;
      clearIntervalFn(handle);
    },
    runNow: run,
  };
}

function logArtifactRetentionResult(
  logger: ArtifactRetentionLogger | undefined,
  result: PruneRunArtifactsResult,
  scope: Extract<RunArtifactScope, "agent" | "memory">,
): void {
  for (const warning of result.warnings) {
    logger?.warn?.(`Artifact retention: ${warning}`);
  }
  if (result.dryRun) {
    logger?.info?.(`${retentionLabel(scope)} dry run completed.`, resultMeta(result, scope, { includeCompletePlan: true }));
    return;
  }
  if (result.prunedRunCount > 0) {
    logger?.info?.(`${retentionLabel(scope)} pruned terminal run artifacts.`, resultMeta(result, scope));
  }
}

function retentionLabel(scope: Extract<RunArtifactScope, "agent" | "memory">): string {
  return scope === "memory" ? "Memory artifact retention" : "Artifact retention";
}

function resultMeta(
  result: PruneRunArtifactsResult,
  scope: Extract<RunArtifactScope, "agent" | "memory">,
  options: { readonly includeCompletePlan?: boolean } = {},
): Record<string, unknown> {
  const prunedRunIds = options.includeCompletePlan === true
    ? result.prunedRunIds
    : result.prunedRunIds.slice(0, 20);
  const removedFilePaths = options.includeCompletePlan === true
    ? result.removedFilePaths
    : result.removedFilePaths.slice(0, 20);
  return {
    artifactDir: result.artifactDir,
    scope,
    prunedRunCount: result.prunedRunCount,
    removedFileCount: result.removedFileCount,
    skippedRunningCount: result.skippedRunningCount,
    prunedRunIds,
    removedFilePaths,
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
