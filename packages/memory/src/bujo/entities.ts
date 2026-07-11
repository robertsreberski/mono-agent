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
const ENTITY_ID_MAX_CHARS = 96;
const ENTITY_NAME_MAX_CHARS = 160;
const ENTITY_TYPE_MAX_CHARS = 48;
const RELATION_MAX_CHARS = 96;
const ENTITY_ID = /^[a-z][a-z0-9-]{0,31}:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ENTITY_TYPE = /^[a-z][a-z0-9-]*$/u;
const RELATION = /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/u;

const PROMPT = (text: string) =>
  `Extract named entities and their relations from the text below as JSON.
Return ONLY the following JSON structure with no additional text:
{"entities":[{"id":"type:name-kebab","name":"display name","type":"person|project|org|concept|..."}],"relations":[{"src":"entity-id","dst":"entity-id","relation":"verb phrase"}]}

Rules:
- Entity id must be a slug like "person:morgan-reberski" or "project:mono-agent"
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
  const id = normalizeBoundedString(rec.id, ENTITY_ID_MAX_CHARS);
  const name = normalizeBoundedString(rec.name, ENTITY_NAME_MAX_CHARS);
  if (id === undefined || name === undefined || !ENTITY_ID.test(id)) return undefined;
  const result: { id: string; name: string; type?: string } = { id, name };
  const type = normalizeBoundedString(rec.type, ENTITY_TYPE_MAX_CHARS);
  if (type !== undefined && ENTITY_TYPE.test(type)) result.type = type;
  return result;
}

function normalizeRelation(raw: unknown, entityIds: Set<string>): ExtractedRelation | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as RawRelation;
  const src = normalizeBoundedString(rec.src, ENTITY_ID_MAX_CHARS);
  const dst = normalizeBoundedString(rec.dst, ENTITY_ID_MAX_CHARS);
  const relation = normalizeBoundedString(rec.relation, RELATION_MAX_CHARS);
  if (src === undefined || dst === undefined || relation === undefined || !RELATION.test(relation)) return undefined;
  if (!ENTITY_ID.test(src) || !ENTITY_ID.test(dst)) return undefined;
  if (!entityIds.has(src) || !entityIds.has(dst)) return undefined;
  return { src, dst, relation };
}

function normalizeBoundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || [...normalized].length > maxChars || Buffer.byteLength(normalized, "utf8") > maxChars * 4) {
    return undefined;
  }
  if (/[\p{Cc}\p{Cs}]/u.test(normalized)) return undefined;
  return normalized;
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
  return normalizeExtraction(parsed);
}

export function normalizeExtraction(parsed: unknown): Extraction {
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) return EMPTY;
  const input = parsed as RawExtraction;
  const rawEntities = Array.isArray(input.entities) ? input.entities : [];
  const entities: ExtractedEntity[] = [];
  for (const item of rawEntities) {
    const normalized = normalizeEntity(item);
    if (normalized !== undefined) entities.push(normalized);
  }

  const entityIds = new Set(entities.map((e) => e.id));
  const rawRelations = Array.isArray(input.relations) ? input.relations : [];
  const relations: ExtractedRelation[] = [];
  for (const item of rawRelations) {
    const normalized = normalizeRelation(item, entityIds);
    if (normalized !== undefined) relations.push(normalized);
  }

  return { entities, relations };
}
