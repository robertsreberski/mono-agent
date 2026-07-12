export { createBujoMemoryStore, BujoMemoryStore } from "./store.js";
export {
  AUTO_RECALL_BACKEND_HITS,
  AUTO_RECALL_MAX_BYTES,
  AUTO_RECALL_MAX_HITS,
  AUTO_RECALL_MIN_SCORE,
  AUTO_RECALL_RELATIVE_SCORE,
  composeRecallBlock,
  selectAutomaticRecallHits,
} from "./recall.js";
export { isConversationRelativeQuery } from "./recall-evidence.js";
export {
  rebuildFromMarkdown,
  rollbackMemoryIndex,
  safeRebuildMemoryIndex,
} from "./rebuild.js";
export type {
  SafeMemoryIndexOptions,
  SafeMemoryIndexResult,
  SafeMemoryRebuildHooks,
} from "./rebuild.js";
export {
  MEMORY_REBUILD_POLICY_VERSION,
  readManagedIndexManifest,
  resolveActiveMemoryDbPath,
} from "./generations.js";
export type { ManagedGeneration, ManagedIndexManifest } from "./generations.js";
export {
  BUJO_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS,
  readBujoRuntimeSnapshot,
} from "./runtime-snapshot.js";
export type {
  BujoRuntimeCounters,
  BujoRuntimeSnapshot,
  BujoRuntimeSnapshotObservation,
} from "./runtime-snapshot.js";
export {
  auditBujoMemoryHealth,
  BUJO_MEMORY_HEALTH_SCHEMA_VERSION,
  MEMORY_HEALTH_ISSUE_CODES,
} from "./audit.js";
export type {
  BujoMemoryHealthOptions,
  BujoMemoryHealthReport,
  MemoryHealthCounts,
  MemoryHealthIssueCode,
  MemoryHealthStatus,
} from "./audit.js";
export { MARKER_FOR, parseBullet, serializeBullet, parseDailyFile, serializeDailyFile } from "./grammar.js";
export { appendBullet, dailyFilePath } from "./daily.js";
export { createIdFactory } from "./ids.js";
export type { Bullet, BujoOptions, BujoTier } from "./types.js";
export type { LlmComplete, LlmCompleteOptions } from "./llm.js";
export { MemoryModelError, MemoryModelOutputError } from "./model-error.js";
export type { MemoryModelKind } from "./model-error.js";

// Phase 2 capture pipeline
export { captureTurn, captureTurnStrict } from "./capture.js";
export type { CaptureTurnResult } from "./capture.js";
export {
  extractCapturePlan,
  extractCapturePlanStrict,
  MAX_CAPTURE_ENTITIES,
  MAX_CAPTURE_MEMORIES,
  MAX_CAPTURE_RELATIONS,
} from "./capture-batch.js";
export type { CapturePlan } from "./capture-batch.js";
export {
  auditCompletedTurnIntake,
  inspectCompletedTurnIntake,
  resolveCompletedTurnIntake,
  retryCompletedTurnIntake,
  COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
} from "./capture-intake.js";
export type {
  CompletedTurnIntakeAudit,
  CompletedTurnIntakeInspection,
  CompletedTurnIntakeItem,
  CompletedTurnIntakeSnapshot,
} from "./capture-intake.js";
export { distill } from "./distill.js";
export type { CandidateMemory } from "./distill.js";
export { reconcile } from "./reconcile.js";
export { reconcileBatch } from "./reconcile.js";
export type { ReconcileAction, ReconcileDeps } from "./reconcile.js";
export { extractEntities } from "./entities.js";
export type { Extraction, ExtractedEntity, ExtractedRelation } from "./entities.js";
export { appendAssociation, appendGraphBatch, readGraph } from "./graph.js";
export type { GraphBatchInput, GraphBatchResult } from "./graph.js";
export { auditCanonicalGraphParity } from "./graph-parity.js";
export type {
  CanonicalGraphMutationState,
  CanonicalGraphParityIssue,
  CanonicalGraphParityIssueCode,
  CanonicalGraphParityOptions,
  CanonicalGraphParityResult,
  CanonicalGraphParitySection,
  CanonicalGraphParityStatus,
} from "./graph-parity.js";

// Phase 4 built-in LLM adapter
export { createOllamaLlm } from "./ollama-llm.js";

// Phase 3 rituals
export { reflect } from "./reflect.js";
export type { ReflectDeps, ReflectResult } from "./reflect.js";
export { migrate } from "./migrate.js";
export type { MigrateDeps, MigrateResult } from "./migrate.js";
export { writeFutureLog, writeIndex } from "./projections.js";
