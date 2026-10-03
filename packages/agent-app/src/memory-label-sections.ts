import type { MemoryLoadOptions } from "@mono-agent/agent-contracts";
import type { MemoryDb } from "@mono-agent/memory/store";
import { factKeyLabel, factValueText, guidanceScoreFloor, GUIDANCE_MAX_RANK, memoryGuidanceScopes, resolveMemoryEntities, safeLine, type LabelRecallStore } from "./memory-guidance.js";
import type { MemoryRecallHit } from "./memory-recall.js";

type LabelHit = ReturnType<MemoryDb["labelsForEntity"]>[number];
export type LabelKind = "fact" | "preference" | "lesson";
export interface LabelSectionRequest {
  readonly query: string;
  readonly kind?: LabelKind;
  readonly about?: string;
}
export interface LabelContext extends MemoryLoadOptions { readonly conversationId?: string }
export interface FactSheetEntry {
  readonly entityId: string;
  readonly name: string;
  readonly key?: string;
  readonly value?: Extract<LabelHit["label"], { kind: "fact" }>["value"];
  /** The stored line itself is the only claim carried by a coarse fact. */
  readonly text?: string;
  readonly attribution: string;
  readonly recordedAt: string;
  readonly current: boolean;
  readonly conflict: boolean;
  readonly sourceFile?: string;
  readonly sourceLine?: number;
}
export interface GuidanceEntry {
  readonly kind: "preference" | "lesson";
  readonly scope: string;
  readonly text: string;
  readonly recordedAt: string;
  readonly sourceFile?: string;
  readonly sourceLine?: number;
}
export interface LabelSections {
  readonly factSheet?: readonly FactSheetEntry[];
  readonly factSheetTruncated?: boolean;
  readonly preferencesAndLessons?: readonly GuidanceEntry[];
  readonly preferencesAndLessonsTruncated?: boolean;
  readonly text: string;
}

/** Deliberate views retain history and conflicts; guidance uses the effective query's retrieved candidates, with no extra lookup. */
export function readLabelSections(store: LabelRecallStore, request: LabelSectionRequest, context: LabelContext = {}, candidates: readonly MemoryRecallHit[] = []): LabelSections | undefined {
  if (store.labelsForEntity === undefined || store.guidanceForScope === undefined) return undefined;
  const date = context.hostLocalDate ?? context.hostDate ?? new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  const result: Omit<LabelSections, "text"> = {};
  if (request.kind === undefined || request.kind === "fact") {
    const entities = resolveMemoryEntities(store, request.about ?? request.query, request.about !== undefined);
    const ambiguous = entities.length > 1 && new Set(entities.map((entity) => entity.name.normalize("NFD")
      .replace(/\p{M}/gu, "").toLowerCase())).size < entities.length;
    const rows = entities.slice(0, 3).flatMap((entity) => store.labelsForEntity!(entity.id, date)
      .filter((hit): hit is LabelHit & { label: Extract<LabelHit["label"], { kind: "fact" }> } => hit.label.kind === "fact")
      .map((hit) => ({ entity, hit })));
    // Structured rows first, so many keyless person lines can never push a
    // structured value or conflict past the cut; then current/active first so
    // a long historical ledger cannot hide today's values.
    rows.sort((a, b) => Number(b.hit.label.key !== undefined) - Number(a.hit.label.key !== undefined)
      || Number(b.hit.active && b.hit.currentAt) - Number(a.hit.active && a.hit.currentAt)
      || Number(b.hit.active) - Number(a.hit.active)
      || b.hit.createdAt.localeCompare(a.hit.createdAt)
      || a.hit.memoryId.localeCompare(b.hit.memoryId));
    const facts: FactSheetEntry[] = rows.slice(0, 12).map(({ entity, hit }) => ({
      entityId: entity.id, name: safeLine(entity.name).slice(0, 160),
      ...(hit.label.key === undefined ? { text: safeLine(hit.text).slice(0, 240) }
        : { key: hit.label.key, value: hit.label.value }),
      attribution: hit.label.attribution, recordedAt: hit.createdAt.slice(0, 10),
      current: hit.currentAt === true, conflict: hit.conflict,
      ...(hit.sourceFile === undefined ? {} : { sourceFile: hit.sourceFile }),
      ...(hit.sourceLine === undefined ? {} : { sourceLine: hit.sourceLine }),
    }));
    const factSheetTruncated = rows.length > 12 || entities.length > 3;
    Object.assign(result, { factSheet: facts, factSheetTruncated });
    if (ambiguous) lines.push(`Ambiguous name — ${entities.length} entities, specify an entity id.`);
    if (facts.length > 0) lines.push("Fact sheet:", ...facts.map((fact) =>
      `- ${safeLine(fact.name)} [${fact.entityId}] ${fact.key === undefined ? "fact" : safeLine(factKeyLabel(fact.key))}: ${safeLine(fact.value === undefined ? fact.text ?? "" : factValueText(fact.value))} (${fact.attribution}, recorded ${fact.recordedAt}; ${fact.current ? "current" : "historical"}${fact.conflict ? "; conflicting values" : ""})`));
    if (factSheetTruncated) lines.push("Fact sheet truncated; request a narrower entity or kind.");
  }
  if (request.kind === undefined || request.kind !== "fact") {
    const guidance: GuidanceEntry[] = [];
    let guidanceTruncated = false;
    const scores = new Map(candidates.map((hit) => [hit.record.id, hit.score]));
    const floor = guidanceScoreFloor(candidates.map((hit) => hit.score));
    const ranked = new Set([...candidates].sort((a, b) => b.score - a.score)
      .slice(0, GUIDANCE_MAX_RANK).map((hit) => hit.record.id));
    // Explicit guidance-kind requests can inspect the best retrieved guidance below
    // the background floor; ordinary recall uses the same floor and rank window.
    const explicitGuidance = request.kind === "preference" || request.kind === "lesson";
    // User > conversation > agent: rank by query within each scope, not by insertion order.
    for (const scope of request.about === undefined ? memoryGuidanceScopes(context.conversationId, context).reverse() : []) {
      const scoped = store.guidanceForScope(scope).filter((hit) => hit.active && hit.label.kind !== "fact"
        && (hit.label.kind !== "lesson" || hit.label.verified)
        && (request.kind === undefined || hit.label.kind === request.kind)
        && ranked.has(hit.memoryId) && (explicitGuidance || (scores.get(hit.memoryId) ?? 0) >= floor))
        .sort((a, b) => (scores.get(b.memoryId) ?? 0) - (scores.get(a.memoryId) ?? 0)
          || a.memoryId.localeCompare(b.memoryId));
      for (const hit of scoped) {
        if (hit.label.kind === "fact") continue;
        if (guidance.length === 6) { guidanceTruncated = true; break; }
        guidance.push({ kind: hit.label.kind, scope, text: safeLine(hit.text).slice(0, 240), recordedAt: hit.createdAt.slice(0, 10),
          ...(hit.sourceFile === undefined ? {} : { sourceFile: hit.sourceFile }),
          ...(hit.sourceLine === undefined ? {} : { sourceLine: hit.sourceLine }) });
      }
      if (guidanceTruncated) break;
    }
    if (guidance.length > 0) Object.assign(result, { preferencesAndLessons: guidance, preferencesAndLessonsTruncated: guidanceTruncated });
    if (guidance.length > 0) lines.push("Preferences & lessons:", ...guidance.map((entry) =>
      `- [${entry.kind}; ${entry.scope}; recorded ${entry.recordedAt}] ${entry.text}`));
    if (guidanceTruncated) lines.push("Preferences & lessons truncated; inspect a narrower scope.");
  }
  return { ...result, text: lines.join("\n") };
}
