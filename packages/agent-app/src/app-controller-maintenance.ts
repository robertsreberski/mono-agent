import type { MonoAgentConfig } from "@mono-agent/config";

import { loadAppCoreConfig, resolveAppArtifactDir } from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import { createConfiguredAgentRuntime } from "./configured-agent.js";
import { routeProactiveNotification } from "./proactive-notify.js";
import type { NotifyDeliveryResult } from "./proactive-notify.js";
import { startMemoryRituals } from "./memory-rituals.js";
import { startArtifactRetentionScheduler } from "./artifact-retention.js";
import { resolveNotifyDestinations } from "./notify-destinations.js";
import type { NotifyDestination } from "./notify-destinations.js";
import { reasonOf } from "./app-controller-utils.js";
import type { MonoAgentAppController } from "./app-controller.js";

export async function startMemoryRitualsIfConfigured(controller: MonoAgentAppController, reason: string): Promise<void> {
  if (controller.stopped) {
    return;
  }
  let coreConfig: MonoAgentConfig;
  try {
    const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
    coreConfig = await loadAppCoreConfig(input);
    controller.rememberSelectedSkills(coreConfig);
  } catch {
    // Config not ready yet — consolidation will start on the next applyConfigChange.
    return;
  }

  if (coreConfig.memory?.mode !== "bujo") {
    return;
  }

  const runtime = controller.runtime ?? createConfiguredAgentRuntime({
    config: coreConfig,
    ...(controller.sandboxEngine === undefined ? {} : { sandboxEngine: controller.sandboxEngine }),
  });
  if (!controller.activeRuntimes.includes(runtime)) {
    controller.activeRuntimes.push(runtime);
  }
  const store = await controller.memoryStore(coreConfig);
  // Duck-type: only bujo-tier BujoMemoryStore has consolidate().
  // Cast through unknown to bypass the MemoryStore contract's type mismatch.
  const storeAsAny = store as unknown as Record<string, unknown>;
  if (
    store === undefined ||
    typeof storeAsAny["consolidate"] !== "function" ||
    typeof storeAsAny["tier"] !== "function"
  ) {
    controller.logger?.info?.("Memory consolidation scheduler skipped — store does not support consolidate().", { reason });
    return;
  }

  const bujoStore = store as unknown as {
    tier(): string;
    consolidate(): Promise<unknown>;
  };

  // `memory.mode` is "bujo", but the store derives the runtime tier from its options: without a
  // `memory.llm` it downgrades to "journal", where startMemoryRituals is a no-op. Don't claim the
  // scheduler started in that case — log an accurate skip instead.
  const tier = bujoStore.tier();
  if (tier !== "bujo") {
    controller.logger?.info?.(
      "Memory consolidation scheduler skipped — configured bujo mode resolved to the journal tier because memory.llm is missing.",
      { reason, tier },
    );
    return;
  }

  controller.memoryRituals = startMemoryRituals({
    store: bujoStore,
    ...(coreConfig.memory.consolidation !== undefined && { consolidation: coreConfig.memory.consolidation }),
    ...(controller.logger !== undefined && {
      logger: {
        info: (m: string) => controller.logger?.info?.(m),
        warn: (m: string) => controller.logger?.warn?.(m),
      },
    }),
  });

  controller.logger?.info?.("Memory consolidation scheduler started.", { reason, mode: "bujo" });
}

export function stopMemoryRituals(controller: MonoAgentAppController): void {
  const rituals = controller.memoryRituals;
  if (rituals === undefined) {
    return;
  }
  controller.memoryRituals = undefined;
  rituals.stop();
  controller.logger?.info?.("Memory consolidation scheduler stopped.");
}

export function restartArtifactRetentionScheduler(controller: MonoAgentAppController, artifactDir: string, reason: string): void {
  controller.stopArtifactRetentionScheduler();
  const generation = ++controller.artifactRetentionGeneration;
  void (async () => {
    let coreConfig: MonoAgentConfig;
    try {
      const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
      coreConfig = await loadAppCoreConfig(input);
      controller.rememberSelectedSkills(coreConfig);
    } catch (error) {
      controller.logger?.warn?.("Artifact retention scheduler skipped until core config loads.", { reason: reasonOf(error) });
      void controller.reconcileStaleRunsOnce(artifactDir);
      return;
    }
    if (controller.stopped || generation !== controller.artifactRetentionGeneration) {
      return;
    }
    controller.artifactRetentionScheduler = startArtifactRetentionScheduler({
      artifactDir,
      retention: coreConfig.artifacts.retention,
      memoryRetention: coreConfig.artifacts.memoryRetention,
      ...(controller.logger === undefined ? {} : { logger: controller.logger }),
      beforeFirstRun: () => controller.reconcileStaleRunsOnce(artifactDir),
    });
    controller.logger?.info?.("Artifact retention scheduler started.", {
      reason,
      artifactDir,
      agent: {
        maxAgeDays: coreConfig.artifacts.retention.maxAgeDays,
        maxCount: coreConfig.artifacts.retention.maxCount,
        dryRun: coreConfig.artifacts.retention.dryRun,
      },
      memory: {
        maxAgeDays: coreConfig.artifacts.memoryRetention.maxAgeDays,
        maxCount: coreConfig.artifacts.memoryRetention.maxCount,
        dryRun: coreConfig.artifacts.memoryRetention.dryRun,
      },
    });
  })();
}

export function stopArtifactRetentionScheduler(controller: MonoAgentAppController): void {
  controller.artifactRetentionGeneration += 1;
  const scheduler = controller.artifactRetentionScheduler;
  if (scheduler === undefined) {
    return;
  }
  controller.artifactRetentionScheduler = undefined;
  scheduler.stop();
  controller.logger?.info?.("Artifact retention scheduler stopped.");
}

export async function notifyDestination(
  controller: MonoAgentAppController,
  conversationId: string,
  text: string,
  options?: { readonly verbatim?: boolean; readonly deliveryKey?: string },
): Promise<NotifyDeliveryResult> {
  const result = await routeProactiveNotification({
    conversationId,
    text,
    running: controller.running,
    ...(options?.verbatim === undefined ? {} : { verbatim: options.verbatim }),
    ...(options?.deliveryKey === undefined ? {} : { deliveryKey: options.deliveryKey }),
    ...(controller.logger === undefined ? {} : { logger: controller.logger }),
  });
  // Make the delivery outcome inspectable (the failure cases already warn inside
  // the router / channel hooks; log the success path too so a notify is auditable).
  if (result.delivered) {
    controller.logger?.info?.("Proactive notification delivered.", { conversationId });
  }
  return result;
}

export async function listNotifyDestinations(controller: MonoAgentAppController): Promise<readonly NotifyDestination[]> {
  const input: MonoAgentAppConfigInput = { env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath };
  const artifactDir = await resolveAppArtifactDir(input);
  return await resolveNotifyDestinations({
    input,
    artifactDir,
    isRunning: (id) => controller.running.has(id),
    ...(controller.logger === undefined ? {} : { logger: controller.logger }),
  });
}
