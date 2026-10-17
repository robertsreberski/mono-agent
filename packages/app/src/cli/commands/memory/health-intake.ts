import { configuredEmbeddingIdentity } from "@mono-agent/memory/search";
import type { IndexMetadata, MemoryStoreAudit } from "@mono-agent/memory/store";

import { legacyEmbeddingModelOption } from "../../../memory/memory-embedding-identity.js";
import * as ui from "../../../ui.js";
import { assertNoLiveConfiguredAgent, memoryRegistryDirs, previewRecallSettings } from "./context.js";
import { collectStoreSize, emptySize } from "./read.js";
import {
  intakeInspectionResult,
  reasonOf,
  renderAudit,
  renderIndexTransition,
  renderIntakeInspection,
  renderIntakeMutation,
  renderStrictAudit,
  write,
  writeNoMemory,
} from "./render.js";
import {
  exists,
  isNativeModuleFailure,
  loadBujoModule,
  loadMemoryRecallModule,
  loadMemoryStoreModule,
} from "./store-access.js";
import { EMPTY_HEALTH_COUNTS, MEMORY_HEALTH_SCHEMA_VERSION } from "./types.js";
import type { MemoryCommandContext, PublishedMemoryHealthStatus, StrictMemoryHealthReport } from "./types.js";

export function notConfiguredHealthReport(now = new Date()): StrictMemoryHealthReport {
  return {
    schemaVersion: MEMORY_HEALTH_SCHEMA_VERSION,
    backend: "none",
    status: "not_configured",
    checkedAt: now.toISOString(),
    issues: [],
    counts: EMPTY_HEALTH_COUNTS,
  };
}

export async function runStrictAudit(context: MemoryCommandContext, json: boolean): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    const result = notConfiguredHealthReport();
    write(json, result, () => renderStrictAudit(result));
    return 0;
  }

  let result: StrictMemoryHealthReport;
  try {
    const { auditBujoMemoryHealth } = await loadBujoModule();
    result = auditBujoMemoryHealth({
      root: memory.path,
      mode: memory.mode,
      ...(memory.embeddings === undefined
        ? {}
        : {
            configuredEmbeddingModel: configuredEmbeddingIdentity(memory.embeddings),
            ...legacyEmbeddingModelOption(memory.embeddings),
            configuredDimension: memory.embeddings.dim ?? 768,
          }),
    });
  } catch (error) {
    result = {
      schemaVersion: MEMORY_HEALTH_SCHEMA_VERSION,
      backend: "bujo",
      mode: memory.mode,
      status: "unknown",
      checkedAt: new Date().toISOString(),
      issues: isNativeModuleFailure(error) ? ["native_module_unavailable"] : ["health_check_failed"],
      counts: EMPTY_HEALTH_COUNTS,
    };
  }
  write(json, result, () => renderStrictAudit(result));
  return strictHealthExitCode(result.status);
}

export function strictHealthExitCode(status: PublishedMemoryHealthStatus): 0 | 1 {
  switch (status) {
    case "healthy":
    case "in_progress":
    case "not_configured":
      return 0;
    case "degraded":
    case "unhealthy":
    case "unknown":
      return 1;
  }
}

export async function runIntakeInspect(
  context: MemoryCommandContext,
  id: string | undefined,
  json: boolean,
): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }
  try {
    const { inspectCompletedTurnIntake } = await loadBujoModule();
    const inspection = inspectCompletedTurnIntake(memory.path);
    const result = intakeInspectionResult(inspection, id);
    write(json, result, () => renderIntakeInspection(result));
    return 0;
  } catch {
    process.stderr.write(ui.errorLine("memory inspect failed; the intake metadata is unavailable or invalid."));
    return 1;
  }
}

export async function runIntakeMutation(
  context: MemoryCommandContext,
  operation: "retry" | "resolve",
  id: string | undefined,
  reason: string | undefined,
  json: boolean,
): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }
  try {
    await assertNoLiveConfiguredAgent(context.configPath, await memoryRegistryDirs(context));
    const bujo = await loadBujoModule();
    if (operation === "retry") {
      const mutation = bujo.retryCompletedTurnIntake(memory.path, id === undefined ? {} : { id });
      const result = {
        schemaVersion: MEMORY_HEALTH_SCHEMA_VERSION,
        operation,
        changed: mutation.retried > 0,
        retried: mutation.retried,
      };
      write(json, result, () => renderIntakeMutation(result));
      return 0;
    }
    const mutation = bujo.resolveCompletedTurnIntake(memory.path, id!, reason!);
    const result = {
      schemaVersion: MEMORY_HEALTH_SCHEMA_VERSION,
      operation,
      changed: mutation.resolved,
      resolved: mutation.resolved,
    };
    write(json, result, () => renderIntakeMutation(result));
    return 0;
  } catch (error) {
    const retainedPlan = /retained semantic-plan recovery/iu.test(reasonOf(error));
    process.stderr.write(ui.errorLine(retainedPlan
      ? "memory resolve refused: retained semantic-plan recovery must complete first."
      : `memory ${operation} failed: ${reasonOf(error)}`));
    return 1;
  }
}

export async function runIndexTransition(
  context: MemoryCommandContext,
  operation: "rebuild" | "rollback",
  json: boolean,
): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }

  const settings = previewRecallSettings(context.config);
  if (settings === undefined) {
    process.stderr.write(ui.errorLine(`Unable to resolve the configured built-in memory store for ${operation}.`));
    return 1;
  }

  try {
    const registryDirs = await memoryRegistryDirs(context);
    await assertNoLiveConfiguredAgent(context.configPath, registryDirs);
    const {
      resolveActiveMemoryDbPath,
      rollbackMemoryIndex,
      safeRebuildMemoryIndex,
    } = await loadBujoModule();
    const { createMemoryEmbeddingProvider } = await loadMemoryRecallModule();
    const embeddings = settings.embeddings === undefined
      ? undefined
      : await createMemoryEmbeddingProvider(settings.embeddings);
    const options = {
      root: memory.path,
      tier: memory.mode,
      ...(embeddings === undefined ? {} : { embeddings, dim: settings.embeddings?.dim ?? 768 }),
    };
    // Re-check after provider construction so a legacy writer that started
    // during setup cannot be raced by the destructive transition.
    await assertNoLiveConfiguredAgent(context.configPath, registryDirs);
    const details = operation === "rebuild"
      ? await safeRebuildMemoryIndex(options)
      : await rollbackMemoryIndex(options);
    const activeDatabase = await resolveActiveMemoryDbPath(memory.path);
    const result = {
      configured: true,
      backend: "bujo",
      operation,
      activeDatabase,
      details,
    };
    write(json, result, () => renderIndexTransition(result));
    return 0;
  } catch (error) {
    process.stderr.write(ui.errorLine(`memory ${operation} failed: ${reasonOf(error)}`));
    return 1;
  }
}

export async function runAudit(context: MemoryCommandContext, json: boolean): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }

  const root = memory.path;
  const { readBujoRuntimeSnapshot, resolveActiveMemoryDbPath } = await loadBujoModule();
  const { openMemoryDb } = await loadMemoryStoreModule();
  const runtime = readBujoRuntimeSnapshot(root);
  const dbPath = await resolveActiveMemoryDbPath(root);
  const rootExists = await exists(root);
  const size = rootExists ? await collectStoreSize(root) : emptySize();
  let audit: MemoryStoreAudit | undefined;
  let generation: IndexMetadata | undefined;
  let metadataQueryMs: number | null = null;
  if (await exists(dbPath)) {
    const db = openMemoryDb({ path: dbPath, readOnly: true });
    try {
      const started = performance.now();
      audit = db.audit();
      generation = db.indexMetadata();
      metadataQueryMs = performance.now() - started;
    } finally {
      db.close();
    }
  }
  const live = audit?.counts.live ?? 0;
  const liveIndexed = audit?.vectors.liveIndexed ?? 0;
  const semanticExpected = memory.embeddings !== undefined;
  const runtimeQueues = runtime.snapshot?.queues;
  const completedTurnIntake = runtime.stale ? undefined : runtimeQueues?.intake;
  const runtimeVectorBacklog = runtime.stale ? undefined : runtimeQueues?.index?.remainingBacklog;
  const result = {
    configured: true,
    backend: "bujo",
    mode: memory.mode,
    ...(generation === undefined ? {} : { generation }),
    metadataOnly: true,
    counts: audit?.counts ?? { total: 0, live: 0, entities: 0, entityRelations: 0 },
    bytes: size,
    duplicates: audit?.duplicates ?? { groups: 0, redundantRecords: 0, ratio: 0 },
    vectorCoverage: audit?.vectors ?? { indexed: 0, liveIndexed: 0, liveCoverage: live === 0 ? 1 : 0 },
    accessConcentration: audit?.access ?? { totalCount: 0, accessedMemories: 0, topOnePercentShare: 0 },
    backlog: {
      known: true,
      completedTurnIntake: completedTurnIntake === undefined ? null : completedTurnIntake.pending,
      vectorIndex: runtimeVectorBacklog ?? (semanticExpected ? Math.max(0, live - liveIndexed) : 0),
    },
    runtime: {
      available: runtime.available,
      stale: runtime.stale,
      ...(runtime.reason === undefined ? {} : { reason: runtime.reason }),
      ...(runtime.ageMs === undefined ? {} : { ageMs: runtime.ageMs }),
      ...(runtime.processAlive === undefined ? {} : { processAlive: runtime.processAlive }),
      ...(runtime.snapshot === undefined ? {} : {
        pid: runtime.snapshot.pid,
        tier: runtime.snapshot.tier,
        state: runtime.snapshot.state,
        startedAt: runtime.snapshot.startedAt,
        updatedAt: runtime.snapshot.updatedAt,
        queues: runtime.snapshot.queues,
      }),
    },
    latency: {
      known: metadataQueryMs !== null,
      metadataQueryMs,
      searchP50Ms: null,
      searchP95Ms: null,
      indexingMs: null,
    },
    cost: {
      known: runtime.snapshot !== undefined,
      totalUsd: null,
      embeddingCalls: runtime.snapshot?.counters.embeddingCalls ?? null,
      embeddingTexts: runtime.snapshot?.counters.embeddingTexts ?? null,
      llmCalls: runtime.snapshot?.counters.llmCalls ?? null,
      llmInputChars: runtime.snapshot?.counters.llmInputChars ?? null,
      tokens: null,
    },
    notes: [
      ...(audit === undefined ? [`No SQLite index found at ${dbPath}.`] : []),
      ...(generation === undefined ? [] : [
        `Generation ${generation.generation}: skipped raw summaries ${generation.skippedRawRecords ?? 0}, `
        + `unstructured source lines ${generation.skippedUnstructuredRecords ?? 0}, `
        + `missing-identity source lines ${generation.skippedMissingIdentityRecords ?? 0} `
        + `(${generation.missingIdentityLocations?.join(", ") || "none"}), `
        + `legacy-source lines ${generation.skippedLegacySourceRecords ?? 0} `
        + `(${generation.legacySourceLocations?.join(", ") || "none"}), `
        + `Journal duplicate lines ${generation.skippedJournalDuplicateRecords ?? 0}, `
        + `parsed source items ${generation.parsedSourceItems ?? 0}, `
        + `derived legacy associations ${generation.derivedLegacyAssociations ?? 0}.`,
      ]),
      "Search latency and model cost require benchmark/run telemetry and are not inferred from memory content.",
      ...(!runtime.available ? [
        `Runtime queue/call telemetry is ${runtime.reason === "invalid" ? "invalid" : "not available until the configured store starts"}.`,
      ] : runtime.stale ? [
        `Runtime queue/call telemetry is stale (${runtime.snapshot?.state ?? "unknown"} snapshot; last update ${runtime.snapshot?.updatedAt ?? "unknown"}).`,
      ] : []),
    ],
  };
  write(json, result, () => renderAudit(result));
  return 0;
}
