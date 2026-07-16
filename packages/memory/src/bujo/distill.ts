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

export const MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS = 160;
export const MAX_RECONCILIATION_TEXT_CODE_POINTS = 280;

type CandidateTextPath = "capture" | "reconcile";

const PROMPT = (text: string) => `Extract durable memories from the text below as a JSON array.
Each item: {"type":"task|event|note","text":"<one atomic sentence>","salience":0..1,"isInsight":true|false}.
Rules: one fact per item; <=${MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS} Unicode code points; omit chit-chat; salience reflects long-term importance; isInsight=true only for synthesized higher-level conclusions. Return ONLY the JSON array.

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
  // dropped by reconcile's per-candidate isolation. Collapse whitespace, strip the delimiter, and
  // apply the capture path's 160-code-point contract.
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

/** Normalize model-authored memory text with the path-specific capture or reconciliation cap. */
export function normalizeCandidateText(
  value: unknown,
  path: CandidateTextPath = "capture",
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\p{Cs}/gu, "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .replace(/<!--mem/gu, "")
    .trim();
  const maxCodePoints = path === "capture"
    ? MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS
    : MAX_RECONCILIATION_TEXT_CODE_POINTS;
  const text = Array.from(normalized).slice(0, maxCodePoints).join("");
  return text.length === 0 ? undefined : text;
}
