import type { LlmComplete } from "./llm.js";
import { parseJsonLoose } from "./json.js";
import { MemoryModelError } from "./model-error.js";

export interface ExtractedEntity {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

export interface ExtractedRelation {
  readonly src: string;
  readonly dst: string;
  readonly relation: string;
}

export interface Extraction {
  readonly entities: ExtractedEntity[];
  readonly relations: ExtractedRelation[];
}

const EMPTY: Extraction = { entities: [], relations: [] };

const PROMPT = (text: string) =>
  `Extract named entities and their relations from the text below as JSON.
Return ONLY the following JSON structure with no additional text:
{"entities":[{"id":"type:name-kebab","name":"display name","type":"person|project|org|concept|..."}],"relations":[{"src":"entity-id","dst":"entity-id","relation":"verb phrase"}]}

Rules:
- Entity id must be a slug like "person:example-operator" or "project:mono-agent"
- Include only entities clearly mentioned in the text
- Relations must reference entity ids present in the entities array
- Use lowercase kebab-case for ids

TEXT:
${text}`;

interface RawEntity {
  id?: unknown;
  name?: unknown;
  type?: unknown;
}

interface RawRelation {
  src?: unknown;
  dst?: unknown;
  relation?: unknown;
}

interface RawExtraction {
  entities?: unknown;
  relations?: unknown;
}

function normalizeEntity(raw: unknown): ExtractedEntity | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as RawEntity;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (id.length === 0 || name.length === 0) return undefined;
  const result: { id: string; name: string; type?: string } = { id, name };
  if (typeof rec.type === "string" && rec.type.trim().length > 0) {
    result.type = rec.type.trim();
  }
  return result;
}

function normalizeRelation(raw: unknown, entityIds: Set<string>): ExtractedRelation | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as RawRelation;
  const src = typeof rec.src === "string" ? rec.src.trim() : "";
  const dst = typeof rec.dst === "string" ? rec.dst.trim() : "";
  const relation = typeof rec.relation === "string" ? rec.relation.trim() : "";
  if (src.length === 0 || dst.length === 0 || relation.length === 0) return undefined;
  if (!entityIds.has(src) || !entityIds.has(dst)) return undefined;
  return { src, dst, relation };
}

/**
 * Use the LLM to extract named entities and their relations from `text`.
 * Empty/whitespace text → `{entities:[], relations:[]}`.
 * Malformed LLM *output* is handled defensively (→ EMPTY), but a model *failure* (Ollama down,
 * timeout, 5xx) is rethrown as a {@link MemoryModelError} so it surfaces rather than looking like
 * "no entities found".
 */
export async function extractEntities(text: string, llm: LlmComplete): Promise<Extraction> {
  if (text.trim().length === 0) return EMPTY;

  let raw: string;
  try {
    raw = await llm.complete(PROMPT(text), { label: "capture:entities" });
  } catch (cause) {
    throw new MemoryModelError("llm", "entities", cause);
  }

  const parsed = parseJsonLoose<RawExtraction>(raw);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) return EMPTY;

  const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const entities: ExtractedEntity[] = [];
  for (const item of rawEntities) {
    const normalized = normalizeEntity(item);
    if (normalized !== undefined) entities.push(normalized);
  }

  const entityIds = new Set(entities.map((e) => e.id));
  const rawRelations = Array.isArray(parsed.relations) ? parsed.relations : [];
  const relations: ExtractedRelation[] = [];
  for (const item of rawRelations) {
    const normalized = normalizeRelation(item, entityIds);
    if (normalized !== undefined) relations.push(normalized);
  }

  return { entities, relations };
}
