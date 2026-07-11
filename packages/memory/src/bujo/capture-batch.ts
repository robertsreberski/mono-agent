import { normalizeCandidate, type CandidateMemory } from "./distill.js";
import { normalizeExtraction, type ExtractedEntity, type ExtractedRelation } from "./entities.js";
import { parseJsonLoose } from "./json.js";
import type { LlmComplete } from "./llm.js";
import { MemoryModelError } from "./model-error.js";

export const MAX_CAPTURE_MEMORIES = 8;
export const MAX_CAPTURE_ENTITIES = 16;
export const MAX_CAPTURE_RELATIONS = 16;

export interface CapturePlan {
  readonly candidates: readonly CandidateMemory[];
  readonly entities: readonly ExtractedEntity[];
  readonly relations: readonly ExtractedRelation[];
}

interface RawCapturePlan {
  readonly memories?: unknown;
  readonly entities?: unknown;
  readonly relations?: unknown;
}

const prompt = (text: string): string => `Extract one bounded, durable memory plan from the completed turn below.
Return ONLY JSON:
{"memories":[{"type":"task|event|note","text":"one atomic sentence","salience":0,"isInsight":false,"entityIds":["person:name"]}],"entities":[{"id":"type:name-kebab","name":"display name","type":"person|project|org|concept"}],"relations":[{"src":"entity-id","dst":"entity-id","relation":"verb phrase"}]}

Rules:
- At most ${MAX_CAPTURE_MEMORIES} memories, ${MAX_CAPTURE_ENTITIES} entities, and ${MAX_CAPTURE_RELATIONS} relations.
- Omit chit-chat and transient tool output.
- Every memory is one durable fact, <=160 characters.
- A memory.entityIds list contains ONLY entities directly stated in that same fact.
- Relations and entityIds reference ids in this response. Never associate every memory with every turn entity.

TURN:
${text}`;

/** One LLM call produces candidates and their precise graph evidence. */
export async function extractCapturePlan(text: string, llm: LlmComplete): Promise<CapturePlan> {
  if (text.trim().length === 0) return { candidates: [], entities: [], relations: [] };
  let raw: string;
  try {
    raw = await llm.complete(prompt(text), { label: "capture:extract" });
  } catch (cause) {
    throw new MemoryModelError("llm", "capture-extract", cause);
  }
  const parsed = parseJsonLoose<RawCapturePlan>(raw);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return { candidates: [], entities: [], relations: [] };
  }

  const normalizedGraph = normalizeExtraction({ entities: parsed.entities, relations: parsed.relations });
  const entities = normalizedGraph.entities.slice(0, MAX_CAPTURE_ENTITIES);
  const entityIds = new Set(entities.map((entity) => entity.id));
  const relations = normalizedGraph.relations
    .filter((relation) => entityIds.has(relation.src) && entityIds.has(relation.dst))
    .slice(0, MAX_CAPTURE_RELATIONS);
  const rawMemories = Array.isArray(parsed.memories) ? parsed.memories : [];
  const normalizedCandidates = rawMemories.slice(0, MAX_CAPTURE_MEMORIES).flatMap((rawMemory) => {
    const candidate = normalizeCandidate(rawMemory)[0];
    if (candidate === undefined) return [];
    const record = rawMemory as { entityIds?: unknown };
    const associated = Array.isArray(record.entityIds)
      ? [...new Set(record.entityIds.filter((id): id is string => typeof id === "string" && entityIds.has(id)))]
      : [];
    return [{ ...candidate, entityIds: associated }];
  });
  const candidates = dedupeCaptureCandidates(normalizedCandidates);
  return { candidates, entities, relations };
}

/**
 * Freeze one deterministic fact per intra-turn ambiguity before taking the
 * pre-turn similarity snapshot. Exact normalized duplicates merge only their
 * explicitly supplied entity ids. A later near-duplicate/refinement/conflict
 * is dropped rather than producing competing durable rows without a third LLM
 * adjudication call; distinct facts remain independent.
 */
function dedupeCaptureCandidates(candidates: readonly CandidateMemory[]): CandidateMemory[] {
  const kept: CandidateMemory[] = [];
  const exactIndexes = new Map<string, number>();
  for (const candidate of candidates) {
    const tokens = candidateTokens(candidate.text);
    const key = tokens.join("\u0000");
    const exactIndex = exactIndexes.get(key);
    if (exactIndex !== undefined) {
      const current = kept[exactIndex];
      if (current !== undefined) {
        kept[exactIndex] = {
          ...current,
          entityIds: [...new Set([...(current.entityIds ?? []), ...(candidate.entityIds ?? [])])].sort(),
        };
      }
      continue;
    }
    if (kept.some((current) => isAmbiguousNearDuplicate(candidateTokens(current.text), tokens))) continue;
    exactIndexes.set(key, kept.length);
    kept.push(candidate);
  }
  return kept;
}

function candidateTokens(text: string): string[] {
  return text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isAmbiguousNearDuplicate(left: readonly string[], right: readonly string[]): boolean {
  if (left.length < 3 || right.length < 3) return false;
  const smaller = Math.min(left.length, right.length);
  const rightSet = new Set(right);
  const overlap = new Set(left.filter((token) => rightSet.has(token))).size / smaller;
  let prefix = 0;
  while (prefix < smaller && left[prefix] === right[prefix]) prefix += 1;
  return prefix >= 2 && prefix / smaller >= 0.5 && overlap >= 0.6;
}
