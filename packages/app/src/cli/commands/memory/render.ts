import type { CompletedTurnIntakeInspection } from "@mono-agent/memory/bujo";
import type { EntityRecord } from "@mono-agent/memory/store";

import * as ui from "../../ui.js";
import type { StrictMemoryHealthReport } from "./types.js";

export function intakeInspectionResult(inspection: CompletedTurnIntakeInspection, id: string | undefined) {
  const items = id === undefined ? inspection.items : inspection.items.filter((item) => item.id === id);
  return {
    schemaVersion: inspection.schemaVersion,
    operation: "inspect" as const,
    matched: items.length,
    temporary: inspection.temporary,
    snapshot: inspection.snapshot,
    items,
  };
}

export function writeNoMemory(configPath: string, json: boolean): void {
  const result = {
    configured: false,
    message: `No memory configured in ${configPath}.`,
  };
  write(json, result, () => `${ui.banner("mono-agent memory", "not configured")}\n${result.message}\n`);
}

export function write<T>(json: boolean, value: T, human: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : human());
}


export function renderAudit(result: {
  readonly backend: string;
  readonly counts: { readonly total: number; readonly live: number; readonly entities: number; readonly entityRelations: number } | null;
  readonly bytes: { readonly rootBytes: number; readonly dailyBytes: number; readonly databaseBytes: number; readonly fileCount: number } | null;
  readonly duplicates: { readonly groups: number; readonly redundantRecords: number; readonly ratio: number } | null;
  readonly vectorCoverage: { readonly indexed: number; readonly liveIndexed: number; readonly liveCoverage: number } | null;
  readonly accessConcentration: { readonly totalCount: number; readonly accessedMemories: number; readonly topOnePercentShare: number } | null;
  readonly backlog: { readonly completedTurnIntake: number | null; readonly vectorIndex: number | null };
  readonly runtime?: { readonly available: boolean; readonly stale: boolean; readonly state?: string };
  readonly latency: { readonly metadataQueryMs?: number | null; readonly searchP50Ms: number | null; readonly searchP95Ms: number | null; readonly indexingMs: number | null };
  readonly cost: { readonly totalUsd: number | null; readonly embeddingCalls: number | null; readonly llmCalls: number | null; readonly tokens: number | null };
  readonly notes: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", "metadata audit") + "\n";
  out += ui.keyValue([
    ["backend", result.backend],
    ["memories", result.counts === null ? "unknown" : `${result.counts.total} total, ${result.counts.live} live`],
    ["bytes", result.bytes === null ? "unknown" : formatBytes(result.bytes.rootBytes)],
    ["duplicate ratio", result.duplicates === null ? "unknown" : formatRatio(result.duplicates.ratio)],
    ["vector coverage", result.vectorCoverage === null ? "unknown" : formatRatio(result.vectorCoverage.liveCoverage)],
    ["top 1% access share", result.accessConcentration === null ? "unknown" : formatRatio(result.accessConcentration.topOnePercentShare)],
    ["vector backlog", result.backlog.vectorIndex === null ? "unknown" : String(result.backlog.vectorIndex)],
    ["completed turn intake", result.backlog.completedTurnIntake === null ? "not live/available" : String(result.backlog.completedTurnIntake)],
    ["runtime telemetry", result.runtime === undefined || !result.runtime.available
      ? "unavailable"
      : `${result.runtime.state ?? "unknown"}${result.runtime.stale ? " (stale)" : " (live)"}`],
    ["metadata query", result.latency.metadataQueryMs == null ? "unknown" : `${result.latency.metadataQueryMs.toFixed(3)} ms`],
    ["embedding calls", result.cost.embeddingCalls === null ? "unknown" : String(result.cost.embeddingCalls)],
    ["memory LLM calls", result.cost.llmCalls === null ? "unknown" : String(result.cost.llmCalls)],
    ["recorded cost", result.cost.totalUsd === null ? "unknown" : `$${result.cost.totalUsd.toFixed(6)}`],
  ], 2);
  for (const note of result.notes) out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  return out;
}

export function renderStrictAudit(result: StrictMemoryHealthReport): string {
  return [
    ui.banner("mono-agent memory", "strict health"),
    "\n",
    ui.keyValue([
      ["schema", String(result.schemaVersion)],
      ["backend", result.backend],
      ["mode", "mode" in result ? result.mode : "none"],
      ["status", result.status],
      ["checked", result.checkedAt],
      ["issues", result.issues.length === 0 ? "none" : result.issues.join(", ")],
      ["pending", String(result.counts.pending)],
      ["due", String(result.counts.due)],
      ["dead", String(result.counts.dead)],
      ["outbox", String(result.counts.outbox)],
      ["temporary", String(result.counts.temporary)],
      ["memories", String(result.counts.memories)],
      ["vectors", String(result.counts.vectors)],
      ["missing vectors", String(result.counts.missingVectors)],
    ], 2),
  ].join("");
}

export function renderIntakeInspection(result: ReturnType<typeof intakeInspectionResult>): string {
  let out = ui.banner("mono-agent memory", "intake inspection") + "\n";
  out += ui.keyValue([
    ["matched", String(result.matched)],
    ["pending", String(result.snapshot.pending)],
    ["due", String(result.snapshot.due)],
    ["dead", String(result.snapshot.dead)],
    ["resolved", String(result.snapshot.resolved)],
    ["transitioning", String(result.snapshot.transitioning)],
    ["temporary", String(result.temporary)],
  ], 2);
  for (const item of result.items) {
    out += `  ${item.id}  state=${item.state} attempt=${item.attempt} revision=${item.revision} due=${item.due ? "yes" : "no"}`;
    if (item.lastError !== undefined) out += ` lastError=${item.lastError}`;
    out += "\n";
  }
  return out;
}

export function renderIntakeMutation(result: {
  readonly operation: "retry" | "resolve";
  readonly changed: boolean;
  readonly retried?: number;
  readonly resolved?: boolean;
}): string {
  return [
    ui.banner("mono-agent memory", `intake ${result.operation}`),
    "\n",
    ui.keyValue([
      ["changed", result.changed ? "yes" : "no"],
      ...(result.retried === undefined ? [] : [["retried", String(result.retried)] as const]),
      ...(result.resolved === undefined ? [] : [["resolved", result.resolved ? "yes" : "no"] as const]),
    ], 2),
  ].join("");
}

export function renderLocalStats(stats: {
  readonly mode: string;
  readonly effectiveTier: string;
  readonly writeMode: string;
  readonly recallToolEnabled: boolean;
  readonly root: string;
  readonly database?: string;
  readonly counts: {
    readonly total: number;
    readonly live: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byType: Readonly<Record<string, number>>;
    readonly entities: number;
  };
  readonly size: { readonly rootBytes: number; readonly dailyBytes: number; readonly databaseBytes: number; readonly fileCount: number };
  readonly lastCapture?: string;
  readonly lastAccess?: string;
  readonly lastConsolidation?: string;
  readonly topEntities: readonly EntityRecord[];
  readonly notes: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", "stats") + "\n";
  out += ui.keyValue([
    ["backend", "bujo"],
    ["configured tier", stats.mode],
    ["effective tier", stats.effectiveTier],
    ["write mode", stats.writeMode],
    ["recall tool", stats.recallToolEnabled ? "enabled" : "disabled"],
    ["root", stats.root],
    ["database", stats.database ?? "missing"],
    ["memories", `${stats.counts.total} total, ${stats.counts.live} live`],
    ["entities", String(stats.counts.entities)],
    ["size", `${formatBytes(stats.size.rootBytes)} (${stats.size.fileCount} files)`],
    ["daily logs", formatBytes(stats.size.dailyBytes)],
    ["database files", formatBytes(stats.size.databaseBytes)],
    ["last capture", stats.lastCapture ?? "unknown"],
    ["last access", stats.lastAccess ?? "unknown"],
    ["last consolidation", stats.lastConsolidation ?? "unknown"],
  ], 2);
  out += renderCounts("Status counts", stats.counts.byStatus);
  out += renderCounts("Type counts", stats.counts.byType);
  if (stats.topEntities.length > 0) {
    out += "\n" + ui.heading("Top Entities");
    for (const entity of stats.topEntities) {
      out += `  - ${entity.name}${entity.type === undefined ? "" : ` (${entity.type})`}`;
      if (entity.summary !== undefined) {
        out += `: ${entity.summary}`;
      }
      out += "\n";
    }
  }
  for (const note of stats.notes) {
    out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  }
  return out;
}

export function renderDaily(result: { readonly date: string; readonly path: string; readonly content: string }): string {
  return [
    ui.banner("mono-agent memory", result.date),
    ui.keyValue([["source", result.path]], 2),
    "\n",
    result.content.endsWith("\n") ? result.content : `${result.content}\n`,
  ].join("");
}

export function renderIndexTransition(result: {
  readonly operation: "rebuild" | "rollback";
  readonly activeDatabase: string;
  readonly details: {
    readonly indexed: number;
    readonly generation: string;
    readonly skippedRawRecords: number;
    readonly skippedUnstructuredRecords: number;
    readonly skippedMissingIdentityRecords: number;
    readonly missingIdentityLocations: readonly string[];
    readonly skippedLegacySourceRecords: number;
    readonly legacySourceLocations: readonly string[];
    readonly skippedJournalDuplicateRecords: number;
    readonly parsedSourceItems: number;
    readonly derivedLegacyAssociations: number;
  };
}): string {
  return [
    ui.banner("mono-agent memory", result.operation),
    "\n",
    ui.keyValue([
      ["status", "complete"],
      ["active database", result.activeDatabase],
      ["generation", result.details.generation],
      ["indexed memories", String(result.details.indexed)],
      ["skipped raw summaries", String(result.details.skippedRawRecords)],
      ["skipped unstructured lines", String(result.details.skippedUnstructuredRecords)],
      ["skipped missing-identity lines", String(result.details.skippedMissingIdentityRecords)],
      ["missing-identity locations", result.details.missingIdentityLocations.join(", ") || "none"],
      ["skipped legacy-source lines", String(result.details.skippedLegacySourceRecords)],
      ["legacy-source locations", result.details.legacySourceLocations.join(", ") || "none"],
      ["skipped Journal duplicates", String(result.details.skippedJournalDuplicateRecords)],
      ["parsed source items", String(result.details.parsedSourceItems)],
      ["derived legacy associations", String(result.details.derivedLegacyAssociations)],
    ], 2),
  ].join("");
}

export function renderReplayAdoption(result: {
  readonly status: "adopted";
  readonly counts: {
    readonly terminals: number;
    readonly supersedes: number;
    readonly threads: number;
  };
  readonly authorityDigest: string;
  readonly rebuildRequired: true;
}): string {
  return [
    ui.banner("mono-agent memory", "adopt replay"),
    "\n",
    ui.keyValue([
      ["status", result.status],
      ["terminal lifecycles", String(result.counts.terminals)],
      ["supersedes", String(result.counts.supersedes)],
      ["threads", String(result.counts.threads)],
      ["authority digest", result.authorityDigest],
      ["rebuild required", result.rebuildRequired ? "yes" : "no"],
    ], 2),
  ].join("");
}

export function renderSearch(result: {
  readonly query: string;
  readonly degraded?: string;
  readonly hits: readonly { readonly score: number; readonly text: string; readonly source?: string }[];
  readonly notes?: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", `search: ${result.query}`) + "\n";
  if (result.degraded !== undefined) {
    out += ui.style.yellow(`[WARN] ${result.degraded}`) + "\n";
  }
  for (const note of result.notes ?? []) {
    out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  }
  if (result.hits.length === 0) {
    return out + "No memories matched.\n";
  }
  for (const hit of result.hits) {
    out += `${hit.score.toFixed(3)}  ${hit.text}\n`;
    if (hit.source !== undefined) {
      out += `       source: ${hit.source}\n`;
    }
  }
  return out;
}

export function renderTop(result: {
  readonly hits: readonly {
    readonly salience: number;
    readonly text: string;
    readonly source?: string;
    readonly status?: string;
    readonly type?: string;
  }[];
  readonly notes?: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", "top") + "\n";
  for (const note of result.notes ?? []) {
    out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  }
  if (result.hits.length === 0) {
    return out + "No memories indexed.\n";
  }
  for (const hit of result.hits) {
    const meta = [
      `salience ${hit.salience.toFixed(3)}`,
      ...(hit.type === undefined ? [] : [hit.type]),
      ...(hit.status === undefined ? [] : [hit.status]),
      ...(hit.source === undefined ? [] : [`source ${hit.source}`]),
    ].join("; ");
    out += `${hit.text}\n`;
    out += `       ${meta}\n`;
  }
  return out;
}

function renderCounts(label: string, counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return "";
  }
  return "\n" + ui.heading(label) + entries.map(([key, value]) => `  ${key}: ${value}\n`).join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KB";
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i] ?? unit;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
