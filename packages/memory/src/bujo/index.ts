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
export { rebuildFromMarkdown } from "./rebuild.js";
export { MARKER_FOR, parseBullet, serializeBullet, parseDailyFile, serializeDailyFile } from "./grammar.js";
export { appendBullet, dailyFilePath } from "./daily.js";
export { createIdFactory } from "./ids.js";
export type { Bullet, BujoOptions, BujoTier } from "./types.js";
export type { LlmComplete, LlmCompleteOptions } from "./llm.js";
export { MemoryModelError } from "./model-error.js";
export type { MemoryModelKind } from "./model-error.js";

// Phase 2 capture pipeline
export { captureTurn } from "./capture.js";
export type { CaptureTurnResult } from "./capture.js";
export { extractCapturePlan, MAX_CAPTURE_ENTITIES, MAX_CAPTURE_MEMORIES, MAX_CAPTURE_RELATIONS } from "./capture-batch.js";
export type { CapturePlan } from "./capture-batch.js";
export { distill } from "./distill.js";
export type { CandidateMemory } from "./distill.js";
export { reconcile } from "./reconcile.js";
export { reconcileBatch } from "./reconcile.js";
export type { ReconcileAction, ReconcileDeps } from "./reconcile.js";
export { extractEntities } from "./entities.js";
export type { Extraction, ExtractedEntity, ExtractedRelation } from "./entities.js";
export { appendAssociation, readGraph } from "./graph.js";

// Phase 4 built-in LLM adapter
export { createOllamaLlm } from "./ollama-llm.js";

// Phase 3 rituals
export { reflect } from "./reflect.js";
export type { ReflectDeps, ReflectResult } from "./reflect.js";
export { migrate } from "./migrate.js";
export type { MigrateDeps, MigrateResult } from "./migrate.js";
export { writeFutureLog, writeIndex } from "./projections.js";
