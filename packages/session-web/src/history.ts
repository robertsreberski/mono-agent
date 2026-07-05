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
} from "@mono-agent/observability";
import type { RecordedRunListItem, RunSummary, RuntimeEventLike, Session } from "@mono-agent/observability";

import type { DiscoveredWebInstance } from "./discovery.js";

export type SourceStampedSession = Session & { readonly sourceId: string };

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
 * Newest-first sessions for an instance. `listRecordedRuns` yields the run list
 * (already newest-first); each run is then read in full (`readRecordedRun`) and
 * mapped to a {@link Session} with complete steps. A run missing from disk between
 * the list and the read (rotated out mid-scan) is simply skipped.
 */
export async function listInstanceSessions(
  instance: DiscoveredWebInstance,
  options: ListInstanceSessionsOptions,
): Promise<readonly SourceStampedSession[]> {
  const artifactDir = instance.instance.artifactDir;
  const { runs } = await listRecordedRuns({ artifactDir, maxRuns: options.maxRuns });
  const sessions: SourceStampedSession[] = [];
  for (const run of runs) {
    const session = await readInstanceSession(instance, run.runId);
    if (session !== undefined) {
      sessions.push(session);
    }
  }
  return sessions;
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
