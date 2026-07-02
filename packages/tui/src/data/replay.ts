import {
  combineRecordedRunEvents,
  listRecordedRuns,
  readRecordedRun,
} from "@mono-agent/observability";
import type {
  RecordedRunDetail,
  RecordedRunListItem,
  RecordedRunTimelineItem,
} from "@mono-agent/observability";

export type { RecordedRunDetail, RecordedRunListItem, RecordedRunTimelineItem };

const DEFAULT_MAX_RUNS = 200;

/** Newest-first recorded runs read straight from the agent's artifact dir. */
export async function listReplayRuns(
  artifactDir: string,
  maxRuns = DEFAULT_MAX_RUNS,
): Promise<{ runs: readonly RecordedRunListItem[]; warnings: readonly string[] }> {
  const result = await listRecordedRuns({ artifactDir, maxRuns });
  return { runs: result.runs, warnings: result.warnings };
}

export interface ReplayRunDetail {
  readonly detail: RecordedRunDetail;
  /** Coalesced timeline: streamed assistant/thinking deltas merged into one item each. */
  readonly timeline: readonly RecordedRunTimelineItem[];
}

export async function readReplayRun(
  artifactDir: string,
  runId: string,
): Promise<ReplayRunDetail | undefined> {
  const detail = await readRecordedRun({ artifactDir }, runId);
  if (detail === undefined) {
    return undefined;
  }
  return { detail, timeline: combineRecordedRunEvents(detail.events) };
}
