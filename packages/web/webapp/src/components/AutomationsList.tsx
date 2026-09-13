import { useMemo } from "react";
import { useConsoleStore } from "../console-store";
import { formatCronSchedule } from "../cron-schedule";
import type { CronJob, CronRunStatus } from "../types";
import { Icon } from "./Icon";
import { relativeTime } from "./time";

const RUN_STATUS: Readonly<Record<CronRunStatus, string>> = {
  admitted: "Admitted",
  running: "Running",
  queued: "Queued",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped_overlap: "Skipped overlap",
  dropped: "Dropped",
};

/** Most recent invocation instant, newest first. Untrusted wire values parse or lose. */
function lastInvocationTimeMs(job: CronJob): number | undefined {
  const stamp = job.lastRun?.completedAt ?? job.lastRun?.startedAt ?? job.lastRun?.orderedAt;
  if (stamp === undefined) return undefined;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareAutomations(left: CronJob, right: CronJob): number {
  const leftAt = lastInvocationTimeMs(left);
  const rightAt = lastInvocationTimeMs(right);
  if (leftAt !== undefined || rightAt !== undefined) {
    if (leftAt === undefined) return 1;
    if (rightAt === undefined) return -1;
    if (rightAt !== leftAt) return rightAt - leftAt;
  }
  return left.jobId < right.jobId ? -1 : left.jobId > right.jobId ? 1 : 0;
}

/** Require an unambiguous future instant, rejecting dates JavaScript normalizes. */
const futureInstant = (value: string | undefined): Date | undefined => {
  const fields = value?.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
  );
  if (fields === undefined || fields === null) return undefined;
  const calendar = new Date(`${fields[1]}T00:00:00Z`);
  const instant = new Date(value!);
  if (
    !Number.isFinite(calendar.getTime())
    || calendar.toISOString().slice(0, 10) !== fields[1]
    || Number(fields[2]) > 23
    || Number(fields[3]) > 59
    || Number(fields[4]) > 59
    || !Number.isFinite(instant.getTime())
    || instant.getTime() <= Date.now()
  ) return undefined;
  return instant;
};

const formatSnapshotTime = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "an earlier refresh";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

function AutomationRow({
  job,
  live,
  active,
  onOpen,
}: {
  readonly job: CronJob;
  readonly live: boolean;
  readonly active: boolean;
  readonly onOpen: () => void;
}) {
  const next = live ? futureInstant(job.nextRunAt) : undefined;
  const nextFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const enabled = job.configured && job.effectiveEnabled;
  const enabledLabel = !job.configured
    ? "Removed"
    : live
      ? job.effectiveEnabled ? "Enabled" : "Disabled"
      : "Snapshot";
  const lastRun = job.lastRun;
  const lastRunAt = lastRun?.completedAt ?? lastRun?.startedAt ?? lastRun?.orderedAt;
  // Untrusted wire values parse or lose: an unparseable stamp sorts with the
  // never-run jobs and draws no relative time rather than crashing the list.
  const lastRunAtMs = lastRunAt === undefined ? undefined : Date.parse(lastRunAt);
  // The row's stamp carries WHEN the job last ran, the way a conversation row
  // carries when it last moved, so the line below only has to say how it went.
  const lastRunLabel = job.activeRunId !== undefined
    ? "Run in progress"
    : lastRun === undefined
      ? "No runs yet"
      : RUN_STATUS[lastRun.status];
  const schedule = formatCronSchedule(job.expression, job.timezone);

  return (
    <div className={`thread-item${active ? " is-active" : ""}`}>
      <button
        type="button"
        className="thread-trigger"
        aria-label={`Open run history for ${job.jobId}`}
        onClick={onOpen}
      >
        <span className="thread-kind is-cron" role="img" aria-label="Scheduled" title="Scheduled">
          <Icon name="clock" size={16} />
        </span>
        <span className="thread-copy">
          <span className="thread-title-line">
            <span className="thread-title" title={job.jobId}>{job.jobId}</span>
            <span className={`automation-enabled${enabled ? " is-enabled" : ""}`}>
              {enabledLabel}
            </span>
            {lastRunAt !== undefined && lastRunAtMs !== undefined && Number.isFinite(lastRunAtMs) && (
              <time dateTime={lastRunAt}>{relativeTime(lastRunAt)}</time>
            )}
          </span>
          <span className="thread-preview">
            <i className={`automation-health is-${job.health}`} aria-hidden="true" />
            {/* How it went, what is next, and only then the recurrence: on a
                phone the line ellipsizes, and the recurrence is the part a job
                id usually already says. */}
            <span className="thread-preview-text">
              {lastRunLabel}
              {" · "}
              {!job.configured
                ? "No longer scheduled"
                : !job.effectiveEnabled
                  ? "No next run while disabled"
                  : next === undefined
                    ? "Next run unavailable"
                    : <>
                        Next <time
                          dateTime={job.nextRunAt}
                          title={`Your timezone: ${nextFormatter.resolvedOptions().timeZone}`}
                        >
                          {nextFormatter.format(next)}
                        </time>
                      </>}
              {" · "}
              {schedule}
            </span>
          </span>
        </span>
      </button>
    </div>
  );
}

function AutomationEmptyState({
  title,
  detail,
  retry,
}: {
  readonly title: string;
  readonly detail: string;
  readonly retry?: () => void;
}) {
  return (
    <div className="automation-empty">
      <Icon name="clock" size={21} />
      <strong>{title}</strong>
      <span>{detail}</span>
      {retry && <button type="button" onClick={retry}>Try again</button>}
    </div>
  );
}

export function AutomationsList({
  query,
  onSelect,
  highlightSelected = true,
}: {
  readonly query: string;
  readonly onSelect?: () => void;
  /** The selected conversation is on screen; see `RecentSection`. */
  readonly highlightSelected?: boolean;
}) {
  const {
    selectedAgent,
    selectedAgentId,
    selectedThreadId,
    connection,
    cronOverview,
    cronLoading,
    cronError,
    refreshCron,
    selectCronJob,
  } = useConsoleStore();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleJobs = useMemo(() => cronOverview?.jobs.filter((job) => {
    if (normalizedQuery.length === 0) return true;
    const state = !job.configured
      ? "removed historical"
      : job.effectiveEnabled
        ? "enabled"
        : "disabled";
    return [
      job.jobId,
      job.expression ?? "",
      formatCronSchedule(job.expression, job.timezone),
      job.timezone ?? "",
      state,
      job.health,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  }).sort(compareAutomations) ?? [], [cronOverview?.jobs, normalizedQuery]);

  if (selectedAgent === null || selectedAgentId === null) {
    return (
      <AutomationEmptyState
        title="Choose an agent"
        detail="Automations belong to one agent."
      />
    );
  }

  if (cronOverview === null) {
    if (cronLoading || cronError === null) {
      return (
        <div className="automation-empty" role="status">
          <span className="automation-spinner" aria-hidden="true" />
          <strong>Loading automations…</strong>
        </div>
      );
    }
    const offline = connection !== "live" || selectedAgent.status === "offline";
    const unsupported = !offline && selectedAgent.cron?.read !== true;
    return (
      <AutomationEmptyState
        title={offline
          ? "Automations unavailable offline"
          : unsupported
            ? "Automations not supported"
            : "Automations unavailable"}
        detail={offline
          ? "No saved automation snapshot is available for this agent."
          : unsupported
            ? "This agent has no readable automation overview."
            : cronError}
        retry={() => { void refreshCron().catch(() => undefined); }}
      />
    );
  }

  const live = connection === "live"
    && selectedAgent.status !== "offline"
    && selectedAgent.cron?.read === true
    && cronOverview.degradedReason === undefined
    && cronError === null;
  const snapshotTime = formatSnapshotTime(cronOverview.generatedAt);

  return (
    <div className="automation-list-scroll">
      {!live && (
        <div className="automation-notice" role="status">
          <Icon name="clock" size={15} />
          <span>
            {cronError !== null
              ? `Couldn’t refresh automations. Showing the saved snapshot from ${snapshotTime}.`
              : cronOverview.degradedReason !== undefined
                ? `Live schedule state is unavailable: ${cronOverview.degradedReason}`
                : `Saved automation data from ${snapshotTime}. Live schedule status is unavailable.`}
          </span>
          {cronError !== null && (
            <button type="button" onClick={() => { void refreshCron().catch(() => undefined); }}>
              Retry
            </button>
          )}
        </div>
      )}
      {cronOverview.jobsTruncated && (
        <div className="automation-notice is-warning" role="note">
          <Icon name="archive" size={15} />
          <span>This overview is truncated. Some removed historical jobs may not be shown.</span>
        </div>
      )}
      {cronOverview.jobs.length === 0 ? (
        <AutomationEmptyState
          title={cronOverview.jobsTruncated ? "No jobs in this overview" : "No automations configured"}
          detail={cronOverview.jobsTruncated
            ? "The saved overview is incomplete. Retry when the agent is available."
            : "Scheduled jobs configured for this agent will appear here before their first run."}
        />
      ) : visibleJobs.length === 0 ? (
        <AutomationEmptyState
          title="No matching automations"
          detail={`No automation matches “${query.trim()}”.`}
        />
      ) : (
        <div className="thread-list" aria-label="Automation jobs">
          {visibleJobs.map((job) => (
            <AutomationRow
              key={job.jobId}
              job={job}
              live={live}
              active={highlightSelected && selectedThreadId === job.threadId}
              onOpen={() => {
                selectCronJob(selectedAgentId, job.jobId, job.threadId);
                onSelect?.();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
