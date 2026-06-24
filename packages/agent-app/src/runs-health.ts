import {
  describeRunFailureKind,
  type RecordedRunListItem,
  type RunSummaryStatus,
} from "@mono-agent/observability";

export const RUNS_HEALTH_MAX_RUNS = 50;
export const RUNS_HEALTH_STALE_RUNNING_MS = 30 * 60_000;

export type RunsHealthStatus = "ok" | "waiting" | "disabled";

export interface RunsHealthDisplay {
  readonly status: RunsHealthStatus;
  readonly details: readonly string[];
}

export interface BuildRunsHealthDisplayInput {
  readonly artifactDir: string;
  readonly runs: readonly RecordedRunListItem[];
  readonly warnings: readonly string[];
  readonly nowMs?: number;
  readonly maxRuns?: number;
}

const RUN_SUMMARY_STATUSES = ["running", "succeeded", "failed", "cancelled", "interrupted"] as const satisfies readonly RunSummaryStatus[];
const FAILED_LIKE_RUN_STATUSES = new Set<RunSummaryStatus>(["failed", "cancelled", "interrupted"]);

export function buildRunsHealthDisplay(input: BuildRunsHealthDisplayInput): RunsHealthDisplay {
  const maxRuns = input.maxRuns ?? RUNS_HEALTH_MAX_RUNS;
  const details = [
    `Artifact dir: ${input.artifactDir}`,
    `Inspected recent runs: ${input.runs.length} (max ${maxRuns}).`,
  ];
  let hasWarnings = false;

  for (const warning of input.warnings) {
    hasWarnings = true;
    details.push(`[WARN] Run artifact reader: ${warning}`);
  }

  if (input.runs.length === 0) {
    details.push("No recent run summaries found.");
    return { status: hasWarnings ? "waiting" : "disabled", details };
  }

  const statusCounts = statusHistogram(input.runs);
  details.push(`Recent status counts: ${RUN_SUMMARY_STATUSES.map((status) => `${status}=${statusCounts[status]}`).join(", ")}.`);

  const now = input.nowMs ?? Date.now();
  const staleRunning = input.runs.filter((run) => isStaleRunningRun(run, now));
  if (staleRunning.length > 0) {
    hasWarnings = true;
    details.push(
      `[WARN] Stale running runs older than ${RUNS_HEALTH_STALE_RUNNING_MS / 60_000}m: ${formatRunExamples(staleRunning)}.`,
    );
  }

  const unsuccessful = input.runs.filter((run) => FAILED_LIKE_RUN_STATUSES.has(run.status));
  if (unsuccessful.length > 0) {
    hasWarnings = true;
    details.push(`[WARN] Recent non-successful runs: ${formatRunExamples(unsuccessful)}.`);
  }

  if (statusCounts.cancelled > 0) {
    hasWarnings = true;
    details.push(`[WARN] Cancelled recent runs: ${statusCounts.cancelled}.`);
  }
  if (statusCounts.interrupted > 0) {
    hasWarnings = true;
    details.push(`[WARN] Interrupted recent runs: ${statusCounts.interrupted}.`);
  }

  const failureKindCounts = failureKindHistogram(input.runs);
  if (failureKindCounts.length > 0) {
    hasWarnings = true;
    details.push(`[WARN] Failure kinds: ${failureKindCounts.map(([kind, count]) => `${kind}=${count}`).join(", ")}.`);
    for (const [kind, count] of failureKindCounts) {
      const description = describeRunFailureKind({ failureKind: kind });
      const prefix = description.known ? description.kind : `${description.kind} (unclassified)`;
      details.push(`[WARN] ${description.label} [${prefix}, ${count} recent]: ${description.explanation} Next: ${description.nextStep}`);
    }
  } else {
    details.push("Failure kinds: none in recent window.");
  }

  return { status: hasWarnings ? "waiting" : "ok", details };
}

function statusHistogram(runs: readonly RecordedRunListItem[]): Record<RunSummaryStatus, number> {
  const counts: Record<RunSummaryStatus, number> = {
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  };
  for (const run of runs) {
    counts[run.status] += 1;
  }
  return counts;
}

function isStaleRunningRun(run: RecordedRunListItem, now: number): boolean {
  if (run.status !== "running" || run.startedAt === undefined) {
    return false;
  }
  const startedAtMs = Date.parse(run.startedAt);
  return Number.isFinite(startedAtMs) && now - startedAtMs > RUNS_HEALTH_STALE_RUNNING_MS;
}

function failureKindHistogram(runs: readonly RecordedRunListItem[]): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const failureKind = displayFailureKind(run);
    if (failureKind !== undefined) {
      counts.set(failureKind, (counts.get(failureKind) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort(([leftKind, leftCount], [rightKind, rightCount]) =>
    rightCount - leftCount || leftKind.localeCompare(rightKind),
  );
}

function displayFailureKind(run: RecordedRunListItem): string | undefined {
  const failureKind = run.failureKind?.trim();
  if (failureKind !== undefined && failureKind.length > 0) {
    return failureKind;
  }
  if (!FAILED_LIKE_RUN_STATUSES.has(run.status)) {
    return undefined;
  }
  return describeRunFailureKind({ status: run.status }).kind;
}

function formatRunExamples(runs: readonly RecordedRunListItem[]): string {
  const shown = runs.slice(0, 5).map((run) =>
    run.startedAt === undefined ? run.runId : `${run.runId} (started ${run.startedAt})`,
  );
  const remaining = runs.length - shown.length;
  return remaining > 0 ? `${shown.join(", ")} and ${remaining} more` : shown.join(", ");
}
