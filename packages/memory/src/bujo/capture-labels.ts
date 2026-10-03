import type { MemoryCaptureEvidence, MemoryCaptureSpeakerKind } from "@mono-agent/agent-contracts";
import { createHash } from "node:crypto";
import { encodeMemoryLabel, isStructuredFact, validateMemoryLabel, type FactMemoryLabel, type MemoryLabel } from "./labels.js";

/**
 * Where the extraction model says a memory's claim came from in this turn. The
 * host trusts it only within structural bounds; see `boundedCaptureSource`.
 */
export type CaptureSource = "user" | "assistant" | "tool" | "document";
export const CAPTURE_SOURCES: readonly CaptureSource[] = ["user", "assistant", "tool", "document"];

export interface CaptureLabelContext {
  readonly captureSpeakerKind?: MemoryCaptureSpeakerKind;
  readonly conversationId?: string;
  readonly captureEvidence?: MemoryCaptureEvidence;
  readonly entityNames?: ReadonlyMap<string, string>;
  readonly entityIds?: readonly string[];
  /** The memory's host-bounded source. Absent means no first-party claim. */
  readonly source?: CaptureSource;
  /**
   * Curate only: the stored line is already established as about the owner.
   * Such labels are never user-stated, because there is no user turn.
   */
  readonly ownerLine?: boolean;
}

/**
 * The model judges the source; the host only bounds it structurally. `user`
 * needs a human turn that carries user text, and `tool` needs host-observed
 * tool outcomes. An unsupported claim falls back to `assistant`.
 */
export function boundedCaptureSource(proposed: CaptureSource | undefined,
  context: Pick<CaptureLabelContext, "captureSpeakerKind" | "captureEvidence">): CaptureSource | undefined {
  if (proposed === "user") return humanUserText(context) === undefined ? "assistant" : "user";
  if (proposed === "tool") return (context.captureEvidence?.toolOutcomes.length ?? 0) > 0 ? "tool" : "assistant";
  return proposed;
}

function humanUserText(context: Pick<CaptureLabelContext, "captureSpeakerKind" | "captureEvidence">): string | undefined {
  const user = context.captureSpeakerKind === "human-turn" ? context.captureEvidence?.userText : undefined;
  return user === undefined || user.trim().length === 0 ? undefined : user;
}

/**
 * The same host rules apply before reconciliation and to its final merged
 * text. Every rule is structural: entity association, names and values as
 * normalised substrings, the host-bounded source and host tool outcomes. The
 * semantic judgements (who said it, whether it is a preference or a lesson)
 * belong to the extraction model.
 */
export function captureLabels(raw: readonly unknown[], text: string, context: CaptureLabelContext): readonly MemoryLabel[] {
  const result: MemoryLabel[] = [];
  const seen = new Set<string>();
  const user = humanUserText(context);
  const fromUser = context.source === "user" && user !== undefined;
  for (const candidate of raw) {
    if (result.length === 8) break;
    try {
      const label = validateMemoryLabel(candidate);
      let accepted: MemoryLabel | undefined;
      if (label.kind === "fact") {
        if (context.captureSpeakerKind !== "trigger" && factSubject(label.entityId, text, context)) {
          const structured = isStructuredFact(label) && BUILTIN_FACT_KEYS.has(label.key) && valueSupported(label, text)
            && !(label.entityId === OWNER && namesAnotherPerson(text, context));
          const stated = userStates(label.entityId, context)
            && (!structured || valueSupported(label, user ?? ""));
          const attribution = label.attribution === "user-stated" && stated ? "user-stated" : "assistant-inferred";
          accepted = structured ? { ...label, attribution } : { v: 1, kind: "fact", entityId: label.entityId, attribution };
        }
      } else if (label.kind === "preference") {
        if (fromUser && user !== undefined) {
          const scope = preferenceScope(label.scope, user, context);
          if (scope !== undefined) accepted = { ...label, scope, attribution: "user-stated" };
        }
      } else if (label.verified === true && verifiedOutcomeCount(context.captureEvidence) > 0) {
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
  return [...new Set(context.entityIds ?? [])].filter((id) => id.startsWith("person:")).slice(0, 8)
    .flatMap((id): MemoryLabel[] => factSubject(id, text, context)
      ? [{ v: 1, kind: "fact", entityId: id, attribution: userStates(id, context) ? "user-stated" : "assistant-inferred" }]
      : []);
}

/**
 * Whether a line may carry a fact about this person. Any person needs the
 * capture's entity association. The owner additionally needs a host-verified
 * owner turn whose memory the model sourced to the user; another person needs
 * their name in the line. No subject grammar, so this works in any language.
 */
function factSubject(entityId: string, text: string, context: CaptureLabelContext): boolean {
  if (context.entityIds !== undefined && !context.entityIds.includes(entityId)) return false;
  if (entityId === OWNER) {
    return context.ownerLine === true || (context.entityIds !== undefined && context.captureEvidence?.ownerTurn === true
      && context.source === "user" && humanUserText(context) !== undefined);
  }
  return subjectSupported(text, entityId.slice(7), context.entityNames?.get(entityId));
}

/**
 * A fact is user-stated only when the model sourced the memory to the user on a
 * human turn and the user's own text names the person (normalised substring);
 * for the owner, the owner rule in `factSubject` is the naming evidence.
 */
function userStates(entityId: string, context: CaptureLabelContext): boolean {
  const user = humanUserText(context);
  if (context.source !== "user" || user === undefined) return false;
  if (entityId === OWNER) return context.captureEvidence?.ownerTurn === true;
  return subjectSupported(user, entityId.slice(7), context.entityNames?.get(entityId));
}
const OWNER = "person:owner";

/**
 * A structured owner property needs its subject to be unambiguous. When the
 * line is also associated with, or names, another person entity, the value
 * may be theirs: keep only the coarse owner fact. Associations and names only.
 */
function namesAnotherPerson(text: string, context: CaptureLabelContext): boolean {
  const others = new Set([...(context.entityIds ?? []), ...(context.entityNames?.keys() ?? [])]
    .filter((id) => id.startsWith("person:") && id !== OWNER));
  return [...others].some((id) => (context.entityIds ?? []).includes(id)
    || subjectSupported(text, id.slice(7), context.entityNames?.get(id)));
}

/**
 * Whether rewritten text still supports an existing fact label as stored:
 * its subject and, when structured, its value. Attribution is never
 * re-derived, so user-stated, document and legacy structured refs survive a
 * rewrite unchanged or are dropped, never downgraded. The owner is not named
 * in text, so an owner label depends only on its structured value.
 */
export function rewrittenTextSupportsFact(label: FactMemoryLabel, text: string, names?: ReadonlyMap<string, string>): boolean {
  const mentions = (id: string): boolean => id === OWNER
    || subjectSupported(text, id.slice(id.indexOf(":") + 1), names?.get(id));
  if (!mentions(label.entityId)) return false;
  if (!isStructuredFact(label)) return true;
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
/** A project scope needs the project's own name in the user's text. */
function explicitProject(scope: string, user: string): string | undefined {
  if (!scope.startsWith("project:")) return undefined;
  return includesPhrase(user, scope.slice(8).replaceAll("-", " ")) ? scope : undefined;
}
export function safeConversationScope(id: string | undefined): string | undefined {
  if (id === undefined || id.length === 0) return undefined;
  if (id.length <= 96 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id)
    && !id.startsWith("h_")) return `conversation:${id}`;
  // Reserve h_ for hashed scopes: a raw h_ id is always hashed itself, so a
  // caller cannot choose a raw id that aliases some other conversation's hash.
  return `conversation:h_${createHash("sha256").update(id).digest("hex")}`;
}
const BUILTIN_FACT_KEYS = new Set(["birth_date", "full_name", "preferred_name", "home_location", "work_location"]);

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

/**
 * A structured date is supported only when its month can be compared
 * structurally: the ISO form, or an unambiguous numeric day/month/year form.
 * A month written in words (any language) is ambiguous and never matches.
 */
function civilDateAppears(expected: string, text: string): boolean {
  const [year, month, day] = expected.split("-").map(Number) as [number, number, number];
  if (new RegExp(`(?<!\\d)${expected}(?!\\d)`, "u").test(text)) return true;
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?!\d)/gu)) {
    const first = Number(match[1]); const second = Number(match[2]);
    if (first <= 12 && second <= 12 && first !== second) continue; // locale ambiguous
    if (Number(match[3]) === year && ((first === day && second === month) || (first === month && second === day))) return true;
  }
  return false;
}
