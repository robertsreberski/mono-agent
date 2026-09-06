import { useConsoleStore } from "../console-store";
import { formatCronSchedule } from "../cron-schedule";

export const cronRunAnchor = (runId: string): string =>
  `cron-run-${encodeURIComponent(runId)}`;

/** Require an unambiguous instant, rejecting dates JavaScript would normalize. */
const futureInstant = (value: string | undefined): Date | undefined => {
  const fields = value?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u);
  if (fields === undefined || fields === null) return undefined;
  const calendar = new Date(`${fields[1]}T00:00:00Z`);
  const instant = new Date(value!);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== fields[1]
    || Number(fields[2]) > 23 || Number(fields[3]) > 59 || Number(fields[4]) > 59
    || !Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) return undefined;
  return instant;
};

export function CronChannelHeader() {
  const { selectedAgent, selectedThread, cronOverview, cronError, connection } = useConsoleStore();
  if (selectedThread?.trigger?.kind !== "cron") return null;
  const trigger = selectedThread.trigger;
  const job = cronOverview?.jobs.find((candidate) => candidate.jobId === trigger.jobId
    && candidate.threadId === selectedThread.id);
  const removed = (job?.configured ?? selectedThread.trigger.configured) === false;
  const available = connection === "live" && selectedAgent !== null && selectedAgent !== undefined
    && selectedAgent.sourceId === selectedThread.sourceId && selectedAgent.status !== "offline"
    && selectedAgent.cron?.read === true && cronError == null && cronOverview?.degradedReason === undefined;
  const next = available ? futureInstant(job?.nextRunAt) : undefined;
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return (
    <section className="cron-channel-header" aria-label="Cron schedule">
      <span>{formatCronSchedule(job?.expression, job?.timezone)}</span>
      <span aria-hidden="true">·</span>
      <span>
        {removed ? "Job removed" : job?.effectiveEnabled === false ? "Disabled" : next === undefined
          ? "Next run unavailable"
          : <>Next <time dateTime={job?.nextRunAt} title={`Your timezone: ${formatter.resolvedOptions().timeZone}`}>
            {formatter.format(next)}
          </time></>}
      </span>
    </section>
  );
}
