/**
 * Recorded-run history for a discovered instance. Reads the agent's own artifact
 * dir (the JSONL recorder output) and maps each run to the UI {@link Session}
 * model via `mapRunToSession` — the exact same mapping the TUI replay uses, so
 * both surfaces decompose a run identically.
 */
import {
  listRecordedRuns,
  mapRunToSession,
  readRecordedRun,
  RUNS_HEALTH_STALE_RUNNING_MS,
} from "@mono-agent/observability";
import type { RecordedRunListItem, RunArtifactScope, RunSummary, RuntimeEventLike, Session } from "@mono-agent/observability";

import type { DiscoveredWebInstance } from "./discovery.js";

export type SourceStampedSession = Session & { readonly sourceId: string };

export interface DiskRunSignature {
  readonly summaryFileName: string;
  readonly summaryMtimeMs: number;
  readonly updatedAt: string;
  readonly status: string;
  readonly eventCount: number;
}

export interface SourceStampedSessionSummary {
  readonly session: SourceStampedSession;
  readonly signature: DiskRunSignature;
}

/**
 * Raises the read ceiling for legacy/custom-recorder artifacts. The current
 * recorder already caps each persisted event string at 4,096 bytes by default;
 * this 32 KiB ceiling remains bounded and cannot recover pre-terminal crash loss.
 */
const DETAIL_MAX_STRING_BYTES = 32_768;

export interface ListInstanceSessionsOptions {
  readonly maxRuns: number;
  readonly includeMemory?: boolean;
  readonly nowMs?: number;
}

export interface ReadInstanceSessionOptions {
  readonly includeMemory?: boolean;
  readonly nowMs?: number;
}

export interface ListInstanceSessionSummariesResult {
  readonly total: number;
  readonly summaries: readonly SourceStampedSessionSummary[];
}

/**
 * Newest-first summary rows for an instance. This intentionally reads only
 * `*.summary.json` metadata via `listRecordedRuns` plus summary-file stats; it
 * never touches the events JSONL. Persisted, bounded timelines are loaded by
 * {@link readInstanceSession} on the detail endpoint.
 */
export async function listInstanceSessionSummaries(
  instance: DiscoveredWebInstance,
  options: ListInstanceSessionsOptions,
): Promise<readonly SourceStampedSessionSummary[]> {
  return (await listInstanceSessionSummaryPage(instance, options)).summaries;
}

export async function listInstanceSessionSummaryPage(
  instance: DiscoveredWebInstance,
  options: ListInstanceSessionsOptions,
): Promise<ListInstanceSessionSummariesResult> {
  const artifactDir = instance.instance.artifactDir;
  const { runs, totalRuns } = await listRecordedRuns({
    artifactDir,
    maxRuns: options.maxRuns,
    scope: runScope(options.includeMemory === true),
  });
  const sessions: SourceStampedSessionSummary[] = [];
  for (const run of runs) {
    const signature = diskRunSignature(run);
    if (signature === undefined) {
      continue;
    }
    sessions.push({
      session: projectStaleRunningSession(mapListItemToSession(instance, run), nowMs(options)),
      signature,
    });
  }
  return { total: totalRuns, summaries: sessions };
}

export async function readInstanceSessionSummaryByFileName(
  instance: DiscoveredWebInstance,
  summaryFileName: string,
  options: ListInstanceSessionsOptions,
): Promise<SourceStampedSessionSummary | undefined> {
  const summaries = await listInstanceSessionSummaries(instance, options);
  return summaries.find((entry) => entry.signature.summaryFileName === summaryFileName);
}

/**
 * Back-compat alias for callers that only need list rows. These rows are
 * deliberately step-less; use {@link readInstanceSession} for persisted,
 * bounded detail.
 */
export async function listInstanceSessions(
  instance: DiscoveredWebInstance,
  options: ListInstanceSessionsOptions,
): Promise<readonly SourceStampedSession[]> {
  return (await listInstanceSessionSummaries(instance, options)).map((entry) => entry.session);
}

/** A single run mapped from its persisted, bounded artifact; `undefined` when the run isn't on disk. */
export async function readInstanceSession(
  instance: DiscoveredWebInstance,
  runId: string,
  options: ReadInstanceSessionOptions = {},
): Promise<SourceStampedSession | undefined> {
  const artifactDir = instance.instance.artifactDir;
  const detail = await readRecordedRun({
    artifactDir,
    maxStringBytes: DETAIL_MAX_STRING_BYTES,
    scope: runScope(options.includeMemory === true),
  }, runId);
  if (detail === undefined) {
    return undefined;
  }
  // `mapRunToSession` walks the raw runtime event shape (`event.message.content`,
  // `event.tool_use_id`, …); the reader exposes each redacted raw event as
  // `RecordedRunEvent.payload` under a classified envelope, so unwrap the payloads.
  const events = detail.events.map((event) => toRuntimeEvent(event.payload));
  const session = mapRunToSession(runSummaryFromListItem(detail.summary), events, {
    instanceLabel: instance.instance.label,
    ...(instance.instance.cwd.length === 0 ? {} : { cwd: instance.instance.cwd }),
  });
  return projectStaleRunningSession({ ...session, sourceId: instance.instance.sourceId }, nowMs(options));
}

function runScope(includeMemory: boolean): RunArtifactScope {
  return includeMemory ? "all" : "agent";
}

function toRuntimeEvent(payload: unknown): RuntimeEventLike {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as RuntimeEventLike)
    : { type: "unknown" };
}

/**
 * Widen a {@link RecordedRunListItem} (what the reader returns) to the
 * {@link RunSummary} `mapRunToSession` expects. The list item already carries
 * `systemPrompt` (the mapper reads it into `Session.sysPrompt`); it lacks only
 * `artifactPaths`, so supplying an empty array satisfies the type without
 * inventing data. On the light list path `mapListItemToSession` strips the
 * resulting `sysPrompt` back off — it belongs to the lazy detail read.
 */
function runSummaryFromListItem(item: RecordedRunListItem): RunSummary {
  return { ...item, artifactPaths: [] };
}

function mapListItemToSession(instance: DiscoveredWebInstance, item: RecordedRunListItem): SourceStampedSession {
  const summary = runSummaryFromListItem(item);
  const session = mapRunToSession(summary, [], {
    instanceLabel: instance.instance.label,
    sourceId: instance.instance.sourceId,
    ...(instance.instance.cwd.length === 0 ? {} : { cwd: instance.instance.cwd }),
  });
  const base = stripSessionDetailText(session);
  return {
    ...base,
    sourceId: instance.instance.sourceId,
    // Keep list/SSE snapshots compatible with the existing Session wire shape
    // while leaving timelines and delivered output to the lazy detail endpoint.
    outcome: summary.status === "succeeded" && summary.eventCount > 0 ? "notified" : session.outcome,
    instr: "",
    hasRecall: false,
    finalText: "",
    toolCounts: {},
    totals: {
      ...session.totals,
      asst: 0,
      tcalls: 0,
      think: 0,
      steps: summary.eventCount,
    },
    steps: [],
  };
}

export function projectStaleRunningSession(
  session: SourceStampedSession,
  now: number,
): SourceStampedSession {
  if (session.status !== "running" || !isStaleStartedAt(session.startTs, now)) {
    return session;
  }
  return { ...session, status: "stalled" };
}

function stripSessionDetailText(
  session: Session,
): Omit<Session, "instrTr" | "recalled" | "finalTr" | "ctx" | "sysPrompt" | "sysPromptTr"> {
  const {
    instrTr: _instrTr,
    recalled: _recalled,
    finalTr: _finalTr,
    // Per-turn context (history + memory) and the compiled system prompt stay on
    // the lazy detail read only — list rows stay light and step-less.
    ctx: _ctx,
    sysPrompt: _sysPrompt,
    sysPromptTr: _sysPromptTr,
    ...base
  } = session;
  return base;
}

function diskRunSignature(item: RecordedRunListItem): DiskRunSignature | undefined {
  if (item.summaryFileName === undefined || item.summaryMtimeMs === undefined) {
    return undefined;
  }
  return {
    summaryFileName: item.summaryFileName,
    summaryMtimeMs: item.summaryMtimeMs,
    updatedAt: item.updatedAt,
    status: item.status,
    eventCount: item.eventCount,
  };
}

function nowMs(options: { readonly nowMs?: number }): number {
  return options.nowMs ?? Date.now();
}

function isStaleStartedAt(startTs: string, now: number): boolean {
  const startedAtMs = Date.parse(startTs);
  return Number.isFinite(startedAtMs) && now - startedAtMs > RUNS_HEALTH_STALE_RUNNING_MS;
}
