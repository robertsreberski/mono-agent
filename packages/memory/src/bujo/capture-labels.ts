import type { MemoryCaptureEvidence, MemoryCaptureSpeakerKind } from "@mono-agent/agent-contracts";
import { createHash } from "node:crypto";
import { encodeMemoryLabel, validateMemoryLabel, type MemoryLabel } from "./labels.js";
import { splitCaptureSentences } from "./distill.js";

export interface CaptureLabelContext {
  readonly captureSpeakerKind?: MemoryCaptureSpeakerKind;
  readonly conversationId?: string;
  readonly captureEvidence?: MemoryCaptureEvidence;
  readonly entityNames?: ReadonlyMap<string, string>;
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
        if (ownerFact
          ? context.captureEvidence?.ownerTurn === true && user !== undefined
            && ownerFactSupported(label, text) && ownerFactSupported(label, user)
          : factSupported(label, text, context.entityNames)) {
          const userSupported = user !== undefined && valueSupported(label, user);
          const attribution = label.attribution === "unknown" ? "unknown"
            : label.attribution === "user-stated" && userSupported ? "user-stated" : "assistant-inferred";
          accepted = { ...label, attribution };
        }
      } else if (label.kind === "preference") {
        if (user !== undefined && preferenceSupported(text, user)) {
          const scope = preferenceScope(label.scope, user, context);
          if (scope !== undefined) accepted = { ...label, scope, attribution: "user-stated" };
        }
      } else if (label.verified === true && verifiedRetryCount(context.captureEvidence) > 0) {
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
  return /\b(?:prefer|prefers|preferred|should|want|wants|please|keep|use|preferisce|wil|chce)\b/iu.test(text)
    && contentWords(text).some((word) => source.includes(word));
}
// Only finite owner properties have a supported grammatical binding. A bare
// first-person pronoun elsewhere in a message cannot assign a relative's fact.
const OWNER_PROPERTY: Readonly<Record<string, RegExp>> = {
  birth_date: /\b(?:my|the (?:user|owner)'s)\s+(?:birthday|birth\s+date)\b|\b(?:i|the (?:user|owner))\s+(?:was|am|'m)\s+born\b/iu,
  full_name: /\b(?:my|the (?:user|owner)'s)\s+(?:full\s+)?name\b|\b(?:i\s+am|i'm|the (?:user|owner)\s+is)\s+(?:named|called)\b/iu,
  preferred_name: /\b(?:my|the (?:user|owner)'s)\s+(?:preferred\s+)?name\b|\b(?:i|the (?:user|owner))\s+(?:prefer|prefers|go\s+by|goes\s+by)\b/iu,
  home_location: /\b(?:my|the (?:user|owner)'s)\s+home\b|\b(?:i|the (?:user|owner))\s+(?:live|lives|lived|moved)\s+(?:in|to|at)\b|\b(?:i\s+am|i'm|the (?:user|owner)\s+is)\s+based\s+in\b/iu,
  work_location: /\b(?:my|the (?:user|owner)'s)\s+(?:work|job|employer)\b|\b(?:i|the (?:user|owner))\s+(?:work|works|worked)\s+(?:at|for|as|in)\b/iu,
  "other:favorite-color": /\b(?:my|the (?:user|owner)'s)\s+favorite\s+colou?r\b|\b(?:i|the (?:user|owner))\s+(?:prefer|prefers)\b/iu,
};
export function ownerFactSupported(label: Extract<MemoryLabel, { kind: "fact" }>, text: string): boolean {
  const property = OWNER_PROPERTY[label.key];
  if (property === undefined) return false;
  return splitCaptureSentences(text).some((sentence) => valueSupported(label, sentence)
    && property.test(normalize(sentence).replace(/[’]/gu, "'")));
}

export function factSupported(label: Extract<MemoryLabel, { kind: "fact" }>, text: string,
  names?: ReadonlyMap<string, string>): boolean {
  const slug = label.entityId.slice(label.entityId.indexOf(":") + 1);
  if (!subjectSupported(text, slug, names?.get(label.entityId))) return false;
  return valueSupported(label, text);
}
function subjectSupported(text: string, slug: string, display?: string): boolean {
  if (display !== undefined && includesPhrase(text, display)) return true;
  return slug.split("-").some((token) => words(token).some((word) => word.length >= 3 && words(text).includes(word)));
}
export function valueSupported(label: Extract<MemoryLabel, { kind: "fact" }>, text: string): boolean {
  const value = label.value;
  if (value.type === "date") return civilDateAppears(value.date, text);
  if (value.type === "text") return includesPhrase(text, value.text);
  if (value.type === "entity") return subjectSupported(text, value.entityId.split(":")[1]!);
  const roleWords: Readonly<Record<string, readonly string[]>> = {
    child: ["child", "children", "son", "daughter", "kid", "kids"],
    parent: ["parent", "mother", "mom", "mum", "father", "dad"],
    partner: ["partner", "wife", "husband", "spouse"],
    spouse: ["spouse", "wife", "husband", "partner"],
    sibling: ["sibling", "brother", "sister"],
  };
  return (roleWords[value.role] ?? [value.role]).some((word) => includesPhrase(text, word))
    && subjectSupported(text, value.targetEntityId.split(":")[1]!);
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
