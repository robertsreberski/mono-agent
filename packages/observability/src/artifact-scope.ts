import { resolve } from "node:path";

import type { RunArtifactKind, RunArtifactScope } from "./types.js";

export const MEMORY_ARTIFACT_NAMESPACE = "memory";

export interface SummaryFileLocation {
  readonly artifactDir: string;
  readonly fileName: string;
  readonly relativeFileName: string;
  readonly namespaceKind: RunArtifactKind;
}

type SummaryKindFields = {
  readonly conversationId?: unknown;
  readonly runId?: unknown;
  readonly source?: unknown;
};

export function artifactDirForKind(rootArtifactDir: string, artifactKind: RunArtifactKind): string {
  const root = resolve(rootArtifactDir);
  return artifactKind === "memory" ? resolve(root, MEMORY_ARTIFACT_NAMESPACE) : root;
}

export function relativeSummaryFileName(fileName: string, namespaceKind: RunArtifactKind): string {
  return namespaceKind === "memory" ? `${MEMORY_ARTIFACT_NAMESPACE}/${fileName}` : fileName;
}

export function normalizeRunArtifactScope(scope: RunArtifactScope | undefined): RunArtifactScope {
  if (scope === undefined) {
    return "agent";
  }
  if (scope === "agent" || scope === "memory" || scope === "all") {
    return scope;
  }
  throw new Error("scope must be \"agent\", \"memory\", or \"all\".");
}

export function isMemorySummary(summary: SummaryKindFields): boolean {
  return summary.source === "memory" ||
    (typeof summary.conversationId === "string" && summary.conversationId.startsWith("memory:")) ||
    (typeof summary.runId === "string" && summary.runId.startsWith("mem-"));
}

export function summaryMatchesArtifactScope(
  namespaceKind: RunArtifactKind,
  summary: SummaryKindFields,
  scope: RunArtifactScope,
): boolean {
  if (scope === "all") {
    return true;
  }
  if (namespaceKind === "memory") {
    return scope === "memory";
  }
  const memory = isMemorySummary(summary);
  return scope === "memory" ? memory : !memory;
}
