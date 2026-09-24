import type { MemoryCaptureEvidence, MemoryCaptureSpeakerKind } from "@mono-agent/agent-contracts";
import { encodeMemoryLabel, validateMemoryLabel, type MemoryLabel } from "./labels.js";

interface CaptureLabelContext {
  readonly captureSpeakerKind?: MemoryCaptureSpeakerKind;
  readonly conversationId?: string;
  readonly captureEvidence?: MemoryCaptureEvidence;
}

/** Model suggestions cannot supply speaker, tool-success, or value evidence. */
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
        if (factSupported(label, text)) {
          const userSupported = user !== undefined && factSupported(label, user);
          accepted = { ...label, attribution: userSupported ? label.attribution
            : label.attribution === "user-stated" ? "assistant-inferred" : label.attribution };
        }
      } else if (label.kind === "preference") {
        if (user !== undefined && /\b(prefers?|wants?|please|always|avoid|don't|do not|should|like to)\b/iu.test(user)
          && preferenceSupported(text, user)) {
          const scope = preferenceScope(label.scope, user, context);
          if (scope !== undefined) accepted = { ...label, scope, attribution: "user-stated" };
        }
      } else if (label.verified === true && verifiedRetry(context.captureEvidence)) {
        accepted = label;
      }
      if (accepted === undefined) continue;
      const encoded = encodeMemoryLabel(accepted);
      if (seen.has(encoded)) continue;
      seen.add(encoded);
      result.push(accepted);
    } catch { /* Invalid model label: retain the memory, not the label. */ }
  }
  return result;
}

function preferenceScope(proposed: string, user: string, context: CaptureLabelContext): string | undefined {
  const senderToken = context.captureEvidence?.senderToken;
  if (senderToken === undefined) return safeConversationScope(context.conversationId);
  if (proposed === "agent" && /\b(agent|you|your|assistant)\b/iu.test(user)) return "agent";
  if (proposed.startsWith("project:") && /\bproject\b/iu.test(user)
    && includesPhrase(user, proposed.slice(8).replaceAll("-", " "))) return proposed;
  return `user:${senderToken}`;
}

function safeConversationScope(id: string | undefined): string | undefined {
  if (id === undefined || id.length > 96 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id)) return undefined;
  return `conversation:${id}`;
}

function verifiedRetry(evidence: MemoryCaptureEvidence | undefined): boolean {
  if (evidence === undefined) return false;
  const outstanding = new Map<string, number>();
  const verified = new Set<string>();
  for (const event of evidence.toolOutcomes) {
    if (event.outcome === "failed") outstanding.set(event.category, (outstanding.get(event.category) ?? 0) + 1);
    else {
      if (outstanding.get(event.category) === 1) verified.add(event.category);
      outstanding.delete(event.category);
    }
  }
  return verified.size === 1;
}

function preferenceSupported(text: string, user: string): boolean {
  // A short shared imperative or preference phrase must survive the candidate clamp.
  const tokens = words(text).filter((word) => word.length > 3 && !["morgan", "prefer", "wants", "should"].includes(word));
  const source = words(user);
  return tokens.length > 0 && tokens.some((word) => source.includes(word));
}

function factSupported(label: Extract<MemoryLabel, { kind: "fact" }>, text: string): boolean {
  if (!includesPhrase(text, label.entityId.slice(label.entityId.indexOf(":") + 1).replaceAll("-", " "))) return false;
  const value = label.value;
  if (value.type === "date") return civilDateAppears(value.date, text);
  if (value.type === "text") return includesPhrase(text, value.text);
  if (value.type === "entity") return includesPhrase(text, value.entityId.split(":")[1]!.replaceAll("-", " "));
  return includesPhrase(text, value.role) && includesPhrase(text, value.targetEntityId.split(":")[1]!.replaceAll("-", " "));
}

function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
function includesPhrase(text: string, phrase: string): boolean {
  const source = words(text).join(" ");
  const target = words(phrase).join(" ");
  return target.length > 0 && ` ${source} `.includes(` ${target} `);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function civilDateAppears(expected: string, text: string): boolean {
  const [year, month, day] = expected.split("-").map(Number) as [number, number, number];
  if (new RegExp(`(?<!\\d)${expected}(?!\\d)`, "u").test(text)) return true;
  const monthName = MONTHS[month - 1];
  if (monthName === undefined) return false;
  const long = [...text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s*,?\s*(\d{4})\b|\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/giu)];
  for (const match of long) {
    const d = Number(match[1] ?? match[5]);
    const m = (match[2] ?? match[4] ?? "").toLowerCase();
    const y = Number(match[3] ?? match[6]);
    if (d === day && y === year && (m === monthName || m === monthName.slice(0, 3))) return true;
  }
  for (const match of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/gu)) {
    const first = Number(match[1]); const second = Number(match[2]);
    if (first <= 12 && second <= 12) continue; // ambiguous locale
    if (Number(match[3]) === year && ((first === day && second === month && first > 12)
      || (first === month && second === day && second > 12))) return true;
  }
  return false;
}
