import type { MemoryCaptureEvidence, MemoryCaptureSpeakerKind } from "@mono-agent/agent-contracts";
import { createHash } from "node:crypto";
import { encodeMemoryLabel, isStructuredFact, validateMemoryLabel, type FactMemoryLabel, type MemoryLabel } from "./labels.js";
import { splitCaptureSentences } from "./distill.js";

export interface CaptureLabelContext {
  readonly captureSpeakerKind?: MemoryCaptureSpeakerKind;
  readonly conversationId?: string;
  readonly captureEvidence?: MemoryCaptureEvidence;
  readonly entityNames?: ReadonlyMap<string, string>;
  readonly entityIds?: readonly string[];
}

/** The same host rules apply before reconciliation and to its final merged text. */
export function captureLabels(raw: readonly unknown[], text: string, context: CaptureLabelContext): readonly MemoryLabel[] {
  const result: MemoryLabel[] = [];
  const seen = new Set<string>();
  const user = context.captureSpeakerKind === "human-turn" ? context.captureEvidence?.userText : undefined;
  for (const candidate of raw) {
    if (result.length === 8) break;
    try {
      const label = validateMemoryLabel(candidate);
      let accepted: MemoryLabel | undefined;
      if (label.kind === "fact") {
        const ownerFact = label.entityId === "person:owner";
        const subject = ownerFact ? context.captureEvidence?.ownerTurn === true
          && (ownerSubject(text) || isStructuredFact(label) && BUILTIN_FACT_KEYS.has(label.key) && ownerFactSupported(label, text))
          : (context.entityIds === undefined || context.entityIds.includes(label.entityId))
            && subjectSupported(text, label.entityId.slice(7), context.entityNames?.get(label.entityId));
        if (context.captureSpeakerKind !== "trigger" && subject) {
          const structured = isStructuredFact(label) && BUILTIN_FACT_KEYS.has(label.key)
            && (ownerFact ? ownerFactSupported(label, text) : factSupported(label, text, context.entityNames));
          const userSupported = user !== undefined && (structured && isStructuredFact(label)
            ? ownerFact ? ownerFactSupported(label, user)
              : subjectSupported(user, label.entityId.slice(7), context.entityNames?.get(label.entityId)) && valueSupported(label, user)
            : userStatesCoarse(user, text, label.entityId, context));
          const attribution = label.attribution === "user-stated" && userSupported ? "user-stated" : "assistant-inferred";
          accepted = structured ? { ...label, attribution } : { v: 1, kind: "fact", entityId: label.entityId, attribution };
        }
      } else if (label.kind === "preference") {
        if (user !== undefined && preferenceSupported(text, user)) {
          const scope = preferenceScope(label.scope, user, context);
          if (scope !== undefined) accepted = { ...label, scope, attribution: "user-stated" };
        }
      } else if (label.verified === true && verifiedOutcomeCount(context.captureEvidence) > 0
        && /\b(?:resolved|fixed|verified|passed|succeeded)\b/iu.test(text)
        && /\b(?:by|using|instead|because)\b/iu.test(text)) {
        const project = user === undefined ? undefined : explicitProject(label.scope, user);
        accepted = { ...label, scope: project ?? "agent" };
      }
      if (accepted === undefined) continue;
      const encoded = encodeMemoryLabel(accepted);
      if (seen.has(encoded)) continue;
      seen.add(encoded);
      result.push(accepted);
    } catch { /* Invalid model label: retain its memory, not its label. */ }
  }
  return result;
}

/** Host-owned facts for already-admitted, person-associated durable lines. */
export function deriveCoarseFactLabels(
  text: string, type: "note" | "event" | "task", context: CaptureLabelContext,
): readonly MemoryLabel[] {
  if (type === "task" || context.captureSpeakerKind === "trigger") return [];
  const user = context.captureSpeakerKind === "human-turn" ? context.captureEvidence?.userText : undefined;
  return [...new Set(context.entityIds ?? [])].filter((id) => id.startsWith("person:")).slice(0, 8)
    .flatMap((id): MemoryLabel[] => {
      const owner = id === "person:owner";
      if (owner ? context.captureEvidence?.ownerTurn !== true || !ownerSubject(text)
        : !subjectSupported(text, id.slice(7), context.entityNames?.get(id))) return [];
      const stated = user !== undefined && userStatesCoarse(user, text, id, context);
      return [{ v: 1, kind: "fact", entityId: id,
        attribution: stated ? "user-stated" : "assistant-inferred" }];
    });
}

/**
 * A coarse person fact is user-stated only when one of the user's own
 * sentences ASSERTS it: that sentence names the person, is not a question, and
 * shares a substantive part of the line's claim (a content word beyond the
 * name). Naming someone in a question is not stating a fact.
 */
function userStatesCoarse(user: string, text: string, entityId: string, context: CaptureLabelContext): boolean {
  const owner = entityId === "person:owner";
  if (owner && context.captureEvidence?.ownerTurn !== true) return false;
  const display = context.entityNames?.get(entityId);
  const name = new Set(owner ? ["user", "owner"] : [...words(entityId.slice(7).replaceAll("-", " ")), ...words(display ?? "")]);
  const claim = (value: string): string[] => words(value).filter((word) => word.length > 3 && !name.has(word)
    && !CLAIM_FUNCTION_WORDS.has(word));
  const line = claim(text);
  return user.split(/(?<=[.!?])\s+/u).some((sentence) => !question(sentence)
    && (owner ? ownerSubject(sentence) : subjectSupported(sentence, entityId.slice(7), display))
    && claim(sentence).some((word) => line.includes(word)));
}
function question(sentence: string): boolean {
  return /\?\s*$/u.test(sentence) || INTERROGATIVE.test(normalize(sentence).trim());
}
const INTERROGATIVE = /^(?:what|who|whom|whose|which|when|where|why|how|is|are|was|were|do|does|did|can|could|will|would|should|has|have|had)\b/u;
const CLAIM_FUNCTION_WORDS = new Set(["about", "what", "when", "where", "which", "who", "whom", "whose", "that", "this", "these",
  "those", "with", "from", "into", "have", "has", "had", "been", "were", "will", "would", "could", "should", "their", "there",
  "they", "them", "then", "than", "your", "yours", "also", "just", "some", "does", "said", "told", "says", "asked", "user", "owner"]);

/**
 * Whether rewritten text still supports an existing fact label as stored:
 * its subject and, when structured, its value. Attribution is never
 * re-derived, so user-stated, document and legacy structured refs survive a
 * rewrite unchanged or are dropped, never downgraded.
 */
export function rewrittenTextSupportsFact(label: FactMemoryLabel, text: string, names?: ReadonlyMap<string, string>): boolean {
  const mentions = (id: string): boolean => id === "person:owner"
    ? ownerSubject(text) : subjectSupported(text, id.slice(id.indexOf(":") + 1), names?.get(id));
  if (!isStructuredFact(label)) return mentions(label.entityId);
  if (!mentions(label.entityId) && !(label.entityId === "person:owner" && ownerFactSupported(label, text))) return false;
  const value = label.value;
  return value.type === "entity" ? mentions(value.entityId)
    : value.type === "relationship" ? mentions(value.targetEntityId) : valueSupported(label, text);
}

export function verifiedOutcomeCount(evidence: MemoryCaptureEvidence | undefined): number {
  return evidence?.toolOutcomes.filter((event) => event.outcome === "succeeded").length ?? 0;
}

export function verifiedRetryCount(evidence: MemoryCaptureEvidence | undefined): number {
  if (evidence === undefined) return 0;
  const outstanding = new Map<string, number>();
  let verified = 0;
  for (const event of evidence.toolOutcomes) {
    if (event.outcome === "failed") outstanding.set(event.category, (outstanding.get(event.category) ?? 0) + 1);
    else {
      if (outstanding.get(event.category) === 1) verified += 1;
      outstanding.delete(event.category);
    }
  }
  return verified;
}

function preferenceScope(proposed: string, user: string, context: CaptureLabelContext): string | undefined {
  const senderToken = context.captureEvidence?.senderToken;
  if (proposed === "agent" && context.captureEvidence?.ownerTurn === true) return "agent";
  if (senderToken === undefined) return explicitProject(proposed, user) ?? safeConversationScope(context.conversationId);
  return explicitProject(proposed, user) ?? `user:${senderToken}`;
}
function explicitProject(scope: string, user: string): string | undefined {
  if (!scope.startsWith("project:")) return undefined;
  const named = scope.slice(8).replaceAll("-", " ");
  return /\b(project|progetto|projekt)\b/iu.test(normalize(user)) && includesPhrase(user, named) ? scope : undefined;
}
export function safeConversationScope(id: string | undefined): string | undefined {
  if (id === undefined || id.length === 0) return undefined;
  if (id.length <= 96 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id)
    && !id.startsWith("h_")) return `conversation:${id}`;
  // Reserve h_ for hashed scopes: a raw h_ id is always hashed itself, so a
  // caller cannot choose a raw id that aliases some other conversation's hash.
  return `conversation:h_${createHash("sha256").update(id).digest("hex")}`;
}
function preferenceSupported(text: string, user: string): boolean {
  const contentWords = (value: string): string[] => {
    const tokens = words(value);
    // A leading capitalized speaker/name alone is not evidence for the guidance.
    if (/^\p{Lu}/u.test(value) && tokens.length > 1) tokens.shift();
    return tokens.filter((word) => word.length > 3 && !["prefer", "prefers", "wants", "should"].includes(word));
  };
  const source = contentWords(user);
  const standing = /\b(?:prefer|prefers|preferred|likes?|dislikes?|hate|never|always|avoid|again|don't|do not|should|want|wants|keep|use|preferisce|wil|chce)\b/iu;
  return standing.test(user) && standing.test(text)
    && contentWords(text).some((word) => source.includes(word));
}
const BUILTIN_FACT_KEYS = new Set(["birth_date", "full_name", "preferred_name", "home_location", "work_location"]);
function ownerSubject(text: string): boolean {
  return /(?:^|[.!?]\s+)(?:(?:the (?:user|owner)|i(?:'m|'ve)?)\s+(?!told\b|said\b|reported\b|mentioned\b)|my\s+)/iu.test(text);
}
// Only finite structured owner properties have a supported grammatical binding.
export const OWNER_PROPERTY: Readonly<Record<string, RegExp>> = {
  birth_date: /\b(?:my|the (?:user|owner)'s)\s+(?:birthday|birth\s+date)\b|\b(?:i|the (?:user|owner))\s+(?:was|am|'m)\s+born\b/iu,
  full_name: /\b(?:my|the (?:user|owner)'s)\s+(?:full\s+)?name\b|\b(?:i\s+am|i'm|the (?:user|owner)\s+is)\s+(?:named|called)\b/iu,
  preferred_name: /\b(?:my|the (?:user|owner)'s)\s+(?:preferred\s+)?name\b|\b(?:i|the (?:user|owner))\s+(?:prefer|prefers|go\s+by|goes\s+by)\b/iu,
  home_location: /\b(?:my|the (?:user|owner)'s)\s+home\b|\b(?:i|the (?:user|owner))\s+(?:live|lives|lived|moved)\s+(?:in|to|at)\b|\b(?:i\s+am|i'm|the (?:user|owner)\s+is)\s+based\s+in\b/iu,
  work_location: /\b(?:my|the (?:user|owner)'s)\s+(?:work|job|employer)\b|\b(?:i|the (?:user|owner))\s+(?:work|works|worked)\s+(?:at|for|as|in)\b/iu,
};
export function ownerFactSupported(label: FactMemoryLabel, text: string): boolean {
  if (!isStructuredFact(label)) return false;
  const property = OWNER_PROPERTY[label.key];
  if (property === undefined) return false;
  return splitCaptureSentences(text).some((sentence) => valueSupported(label, sentence)
    && property.test(normalize(sentence).replace(/[’]/gu, "'")));
}

export function factSupported(label: FactMemoryLabel, text: string,
  names?: ReadonlyMap<string, string>): boolean {
  if (!isStructuredFact(label)) return false;
  const slug = label.entityId.slice(label.entityId.indexOf(":") + 1);
  if (!subjectSupported(text, slug, names?.get(label.entityId))) return false;
  return valueSupported(label, text, names);
}
function subjectSupported(text: string, slug: string, display?: string): boolean {
  if (display !== undefined && includesPhrase(text, display)) return true;
  return includesPhrase(text, slug.replaceAll("-", " "));
}
export function valueSupported(label: FactMemoryLabel, text: string,
  _names?: ReadonlyMap<string, string>): boolean {
  if (!isStructuredFact(label)) return false;
  const value = label.value;
  if (value.type === "date") return civilDateAppears(value.date, text);
  if (value.type === "text") return includesPhrase(text, value.text);
  return false;
}
function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
function words(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}
function includesPhrase(text: string, phrase: string): boolean {
  const source = words(text).join(" ");
  const target = words(phrase).join(" ");
  return target.length > 0 && ` ${source} `.includes(` ${target} `);
}

const MONTHS: readonly (readonly string[])[] = [
  ["january", "jan", "gennaio", "januari", "styczen", "stycznia"],
  ["february", "feb", "febbraio", "februari", "luty", "lutego"],
  ["march", "mar", "marzo", "maart", "marzec", "marca"],
  ["april", "apr", "aprile", "kwiecien", "kwietnia"],
  ["may", "maggio", "mei", "maj", "maja"],
  ["june", "jun", "giugno", "juni", "czerwiec", "czerwca"],
  ["july", "jul", "luglio", "juli", "lipiec", "lipca"],
  ["august", "aug", "agosto", "augustus", "sierpien", "sierpnia"],
  ["september", "sep", "settembre", "wrzesien", "wrzesnia"],
  ["october", "oct", "ottobre", "oktober", "pazdziernik", "pazdziernika"],
  ["november", "nov", "novembre", "listopad", "listopada"],
  ["december", "dec", "dicembre", "grudzien", "grudnia"],
];
function civilDateAppears(expected: string, text: string): boolean {
  const [year, month, day] = expected.split("-").map(Number) as [number, number, number];
  if (new RegExp(`(?<!\\d)${expected}(?!\\d)`, "u").test(text)) return true;
  const source = normalize(text);
  const long = [...source.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s*,?\s*(\d{4})\b|\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/gu)];
  for (const match of long) {
    const d = Number(match[1] ?? match[5]);
    const m = match[2] ?? match[4] ?? "";
    const y = Number(match[3] ?? match[6]);
    if (d === day && y === year && MONTHS[month - 1]?.includes(m)) return true;
  }
  for (const match of source.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/gu)) {
    const first = Number(match[1]); const second = Number(match[2]);
    if (first <= 12 && second <= 12) continue; // locale ambiguous, even when it would match
    if (Number(match[3]) === year && ((first === day && second === month && first > 12)
      || (first === month && second === day && second > 12))) return true;
  }
  return false;
}
