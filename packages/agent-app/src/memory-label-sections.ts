import type { MemoryLoadOptions } from "@mono-agent/agent-contracts";
import type { MemoryDb } from "@mono-agent/memory/store";
import { memoryGuidanceScopes, resolveMemoryEntities, safeLine, type LabelRecallStore } from "./memory-guidance.js";

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
  readonly key: string;
  readonly value: Extract<LabelHit["label"], { kind: "fact" }>["value"];
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
  readonly preferencesAndLessons?: readonly GuidanceEntry[];
  readonly text: string;
}

/** Deliberate views retain history and conflicts; no extra lookup/model call beyond the label index. */
export function readLabelSections(store: LabelRecallStore, request: LabelSectionRequest, context: LabelContext = {}): LabelSections | undefined {
  if (store.labelsForEntity === undefined || store.guidanceForScope === undefined) return undefined;
  const date = context.hostDate ?? new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  const result: { factSheet?: FactSheetEntry[]; preferencesAndLessons?: GuidanceEntry[] } = {};
  if (request.kind === undefined || request.kind === "fact") {
    const entities = resolveMemoryEntities(store, request.about ?? request.query, request.about !== undefined);
    const facts: FactSheetEntry[] = [];
    for (const entity of entities) for (const hit of store.labelsForEntity(entity.id, date)) {
      if (facts.length >= 12) break;
      if (hit.label.kind !== "fact") continue;
      facts.push({ entityId: entity.id, name: safeLine(entity.name).slice(0, 160), key: hit.label.key, value: hit.label.value,
        attribution: hit.label.attribution, recordedAt: hit.createdAt.slice(0, 10),
        current: hit.currentAt === true, conflict: hit.conflict,
        ...(hit.sourceFile === undefined ? {} : { sourceFile: hit.sourceFile }),
        ...(hit.sourceLine === undefined ? {} : { sourceLine: hit.sourceLine }) });
    }
    result.factSheet = facts;
    if (facts.length > 0) lines.push("Fact sheet:", ...facts.map((fact) =>
      `- ${safeLine(fact.name)} ${safeLine(fact.key)}: ${safeLine(JSON.stringify(fact.value))} (${fact.attribution}, recorded ${fact.recordedAt}; ${fact.current ? "current" : "historical"}${fact.conflict ? "; conflicting values" : ""})`));
  }
  if (request.kind === undefined || request.kind !== "fact") {
    const guidance: GuidanceEntry[] = [];
    for (const scope of request.about === undefined ? memoryGuidanceScopes(context.conversationId, context) : []) {
      for (const hit of store.guidanceForScope(scope)) {
        if (guidance.length >= 6) break;
        if (!hit.active || hit.label.kind === "fact" || (hit.label.kind === "lesson" && !hit.label.verified)
          || (request.kind !== undefined && hit.label.kind !== request.kind)) continue;
        guidance.push({ kind: hit.label.kind, scope, text: safeLine(hit.text).slice(0, 240), recordedAt: hit.createdAt.slice(0, 10),
          ...(hit.sourceFile === undefined ? {} : { sourceFile: hit.sourceFile }),
          ...(hit.sourceLine === undefined ? {} : { sourceLine: hit.sourceLine }) });
      }
    }
    result.preferencesAndLessons = guidance;
    if (guidance.length > 0) lines.push("Preferences & lessons:", ...guidance.map((entry) =>
      `- [${entry.kind}; ${entry.scope}; recorded ${entry.recordedAt}] ${safeLine(entry.text)}`));
  }
  return { ...result, text: lines.join("\n") };
}
