import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { useProcessJobPresentation } from "../process-job-presentation";
import type { ProcessJobProjection } from "../types";
import {
  ProcessJobCard,
  processJobSupersedes,
  TERMINAL_PROCESS_JOB_STATES,
} from "./ProcessJob";

const isActive = (job: ProcessJobProjection): boolean =>
  !TERMINAL_PROCESS_JOB_STATES.has(job.state);

const needsAttention = (job: ProcessJobProjection): boolean =>
  TERMINAL_PROCESS_JOB_STATES.has(job.state) && job.state !== "succeeded";

export function ProcessJobStack() {
  const {
    threadId,
    jobs,
    historyIsBounded,
    stackOpen,
    setStackOpen,
  } = useProcessJobPresentation();
  const bodyId = useId();
  const [liveByJobId, setLiveByJobId] = useState<ReadonlyMap<string, ProcessJobProjection>>(
    () => new Map(jobs.map(({ part }) => [part.job.jobId, part.job])),
  );

  useEffect(() => {
    setLiveByJobId((current) => {
      const next = new Map<string, ProcessJobProjection>();
      for (const { part } of jobs) {
        const live = current.get(part.job.jobId);
        next.set(
          part.job.jobId,
          live === undefined || processJobSupersedes(live, part.job) ? part.job : live,
        );
      }
      return next;
    });
  }, [jobs]);

  const onProjectionChange = useCallback((projection: ProcessJobProjection) => {
    setLiveByJobId((current) => {
      const previous = current.get(projection.jobId);
      if (previous !== undefined && !processJobSupersedes(previous, projection)) return current;
      const next = new Map(current);
      next.set(projection.jobId, projection);
      return next;
    });
  }, []);

  const projections = useMemo(
    () => jobs.map(({ part }) => liveByJobId.get(part.job.jobId) ?? part.job),
    [jobs, liveByJobId],
  );
  const activeCount = projections.filter(isActive).length;
  const attentionCount = projections.filter(needsAttention).length;
  const totalLabel = historyIsBounded
    ? `${String(jobs.length)} loaded`
    : `${String(jobs.length)} ${jobs.length === 1 ? "job" : "jobs"}`;
  const countLabel = `${totalLabel} · ${String(activeCount)} active · ${String(attentionCount)} needs attention`;

  if (threadId === null || jobs.length === 0) return null;

  return (
    <section className="process-job-stack" aria-labelledby={`${bodyId}-label`}>
      <button
        type="button"
        className="process-job-stack-toggle"
        aria-expanded={stackOpen}
        aria-controls={bodyId}
        onClick={() => setStackOpen(!stackOpen)}
      >
        <span id={`${bodyId}-label`} className="process-job-stack-title">Background jobs</span>
        <span className="process-job-stack-counts" aria-live="polite" aria-atomic="true">
          {countLabel}
        </span>
        <span className="process-job-stack-chevron" aria-hidden="true">⌄</span>
      </button>
      <div id={bodyId} className="process-job-stack-body" hidden={!stackOpen}>
        {historyIsBounded && (
          <p className="process-job-stack-history">
            Showing jobs in loaded messages. Load earlier messages to reveal older jobs.
          </p>
        )}
        <div className="process-job-stack-list">
          {jobs.map(({ part }) => (
            <ProcessJobCard
              key={`${threadId}:${part.job.jobId}`}
              part={part}
              onProjectionChange={onProjectionChange}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
