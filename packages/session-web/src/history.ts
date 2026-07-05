/**
 * Recorded-run history for a discovered instance. Reads the agent's own artifact
 * dir (the JSONL recorder output) and maps each run to the UI {@link Session}
 * model via `mapRunToSession` — the exact same mapping the TUI replay uses, so
 * both surfaces decompose a run identically.
 */
import { listRecordedRuns, mapRunToSession, readRecordedRun } from "@mono-agent/observability";
import type { RecordedRunListItem, RunSummary, RuntimeEventLike, Session } from "@mono-agent/observability";

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
 * Matches the TUI replay's detail read (`REPLAY_MAX_STRING_BYTES`). observability's
 * own default (~4 KiB) is tuned for compact summaries and guts tool/message
 * payloads; a session's steps need the fuller (redacted) payload.
 */
const DETAIL_MAX_STRING_BYTES = 32_768;

export interface ListInstanceSessionsOptions {
  readonly maxRuns: number;
}

/**
 * Newest-first summary rows for an instance. This intentionally reads only
 * `*.summary.json` metadata via `listRecordedRuns` plus summary-file stats; it
 * never touches the events JSONL. Full timelines are loaded by
 * {@link readInstanceSession} on the detail endpoint.
 */
export async function listInstanceSessionSummaries(
  instance: DiscoveredWebInstance,
  options: ListInstanceSessionsOptions,
): Promise<readonly SourceStampedSessionSummary[]> {
  const artifactDir = instance.instance.artifactDir;
  const { runs } = await listRecordedRuns({ artifactDir, maxRuns: options.maxRuns });
  const sessions: SourceStampedSessionSummary[] = [];
  for (const run of runs) {
    const signature = diskRunSignature(run);
    if (signature === undefined) {
      continue;
    }
    sessions.push({
      session: mapListItemToSession(instance, run),
      signature,
    });
  }
  return sessions;
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
 * deliberately step-less; use {@link readInstanceSession} for full detail.
 */
export async function listInstanceSessions(
  instance: DiscoveredWebInstance,
  options: ListInstanceSessionsOptions,
): Promise<readonly SourceStampedSession[]> {
  return (await listInstanceSessionSummaries(instance, options)).map((entry) => entry.session);
}

/** A single run read in full and mapped to a {@link Session}; `undefined` when the run isn't on disk. */
export async function readInstanceSession(
  instance: DiscoveredWebInstance,
  runId: string,
): Promise<SourceStampedSession | undefined> {
  const artifactDir = instance.instance.artifactDir;
  const detail = await readRecordedRun({ artifactDir, maxStringBytes: DETAIL_MAX_STRING_BYTES }, runId);
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
  return { ...session, sourceId: instance.instance.sourceId };
}

function toRuntimeEvent(payload: unknown): RuntimeEventLike {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as RuntimeEventLike)
    : { type: "unknown" };
}

/**
 * Widen a {@link RecordedRunListItem} (what the reader returns) to the
 * {@link RunSummary} `mapRunToSession` expects. The two differ only in fields the
 * mapper never reads (`artifactPaths`, `systemPrompt`); supplying an empty
 * `artifactPaths` satisfies the type without inventing data.
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

function stripSessionDetailText(
  session: Session,
): Omit<Session, "instrTr" | "recalled" | "finalTr"> {
  const {
    instrTr: _instrTr,
    recalled: _recalled,
    finalTr: _finalTr,
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
