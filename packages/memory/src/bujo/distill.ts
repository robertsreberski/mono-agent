import type { MemoryType } from "../store/index.js";
import type { LlmComplete } from "./llm.js";
import { parseJsonLoose } from "./json.js";
import { MemoryModelError } from "./model-error.js";

export interface CandidateMemory {
  readonly type: MemoryType;          // task | event | note
  readonly text: string;              // one atomic sentence
  readonly salience: number;          // 0..1
  readonly isInsight: boolean;
  /** Candidate-specific canonical entity ids emitted by batched BuJo capture. */
  readonly entityIds?: readonly string[];
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
    raw = await llm.complete(PROMPT(text), { label: "capture:distill" });
  } catch (cause) {
    // Surface model outages (Ollama down, timeout, 5xx) instead of returning [] — an empty result is
    // indistinguishable from "nothing worth remembering", which is exactly how a dead model hides.
    throw new MemoryModelError("llm", "distill", cause);
  }
  const parsed = parseJsonLoose<unknown[]>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((it) => normalizeCandidate(it));
}

const VALID_TYPES = new Set<string>(["task", "event", "note"]);

export function normalizeCandidate(it: unknown): CandidateMemory[] {
  if (it === null || typeof it !== "object") return [];
  const obj = it as Record<string, unknown>;

  // Require non-empty text, then normalize to a bullet-safe single line so it round-trips through
  // serializeBullet (which rejects newlines and the `<!--mem` delimiter) instead of being silently
  // dropped by reconcile's per-candidate isolation. Collapse whitespace, strip the delimiter, cap ~280.
  const text = normalizeCandidateText(obj["text"]);
  if (text === undefined) return [];

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

/** Normalize any model-authored memory sentence to the canonical bullet-safe form. */
export function normalizeCandidateText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.normalize("NFKC").replace(/\s+/gu, " ").replace(/<!--mem/gu, "").trim().slice(0, 280);
  return text.length === 0 ? undefined : text;
}
