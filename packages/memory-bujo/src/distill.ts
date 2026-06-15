import type { MemoryType } from "@mono-agent/memory-store";
import type { LlmComplete } from "./llm.js";
import { parseJsonLoose } from "./json.js";

export interface CandidateMemory {
  readonly type: MemoryType;          // task | event | note
  readonly text: string;              // one atomic sentence
  readonly salience: number;          // 0..1
  readonly isInsight: boolean;
}

const PROMPT = (text: string) => `Extract durable memories from the text below as a JSON array.
Each item: {"type":"task|event|note","text":"<one atomic sentence>","salience":0..1,"isInsight":true|false}.
Rules: one fact per item; <=160 chars; omit chit-chat; salience reflects long-term importance; isInsight=true only for synthesized higher-level conclusions. Return ONLY the JSON array.

TEXT:
${text}`;

export async function distill(text: string, llm: LlmComplete): Promise<CandidateMemory[]> {
  if (text.trim().length === 0) return [];
  let raw: string;
  try {
    raw = await llm.complete(PROMPT(text));
  } catch {
    return []; // LLM failure → no candidates (keeps distill, and captureTurn, never-throw)
  }
  const parsed = parseJsonLoose<unknown[]>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((it) => normalizeCandidate(it));
}

const VALID_TYPES = new Set<string>(["task", "event", "note"]);

function normalizeCandidate(it: unknown): CandidateMemory[] {
  if (it === null || typeof it !== "object") return [];
  const obj = it as Record<string, unknown>;

  // Require non-empty trimmed text, capped at ~280 chars
  const rawText = typeof obj["text"] === "string" ? obj["text"].trim() : "";
  if (rawText.length === 0) return [];
  const text = rawText.slice(0, 280);

  // Coerce type to one of task/event/note (default "note")
  const rawType = typeof obj["type"] === "string" ? obj["type"] : "";
  const type: MemoryType = VALID_TYPES.has(rawType) ? (rawType as MemoryType) : "note";

  // Clamp salience to [0,1] (default 0.5 when missing/non-finite)
  const rawSalience = typeof obj["salience"] === "number" ? obj["salience"] : NaN;
  const salience = Number.isFinite(rawSalience)
    ? Math.min(1, Math.max(0, rawSalience))
    : 0.5;

  // Coerce isInsight to boolean (default false)
  const isInsight = typeof obj["isInsight"] === "boolean" ? obj["isInsight"] : false;

  return [{ type, text, salience, isInsight }];
}
