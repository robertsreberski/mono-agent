import { useLayoutEffect, useRef } from "react";
import type { ProcessJobSubagentProgress as Progress } from "../types";
import { ActivityStep, clusterSummary, failedLabel } from "./ActivityRow";
import { formatToolDuration } from "./duration";
import { toolArgumentPreview } from "./Subagent";

type Call = Progress["recent"][number];

function clusters(calls: readonly Call[]): Call[][] {
  const groups: Call[][] = [];
  for (const call of calls) {
    const last = groups.at(-1);
    if (last?.[0]?.toolName === call.toolName) last.push(call);
    else groups.push([call]);
  }
  return groups;
}

/** UI-only evidence. The parent wake continues to read the job's separate output tail. */
export function ProcessJobSubagentProgress({ progress, open }: {
  readonly progress?: Progress;
  readonly open: boolean;
}) {
  const region = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    if (open && follow.current && region.current) region.current.scrollTop = region.current.scrollHeight;
  }, [open, progress?.revision]);
  return (
    <div ref={region} className="process-job-subagent-progress" role="region" aria-label="Subagent progress" tabIndex={0}
      onScroll={(event) => {
        const target = event.currentTarget;
        follow.current = target.scrollHeight - target.scrollTop - target.clientHeight <= 24;
      }}>
      {progress === undefined ? <p>Progress is unavailable for this retained job.</p> : <>
        <p className="process-job-subagent-summary">{progress.profile}{progress.label ? ` · ${progress.label}` : ""}
          {` · ${progress.toolCalls} tools`}{progress.failedCalls > 0 ? ` · ${progress.failedCalls} failed` : ""}</p>
        {progress.toolCalls > progress.recent.length && <p>Showing the latest {progress.recent.length} of {progress.toolCalls} calls.</p>}
        {clusters(progress.recent).map((calls) => {
          const first = calls[0]!;
          const failed = calls.filter((call) => call.status === "failed").length;
          const running = calls.some((call) => call.status === "running");
          const durations = calls.flatMap((call) => call.executionMs === undefined ? [] : [call.executionMs]);
          const duration = durations.length ? formatToolDuration(durations.reduce((a, b) => a + b, 0)) : undefined;
          const previews = calls.flatMap((call) => {
            const preview = toolArgumentPreview(call.argsSummary);
            return preview === undefined ? [] : [preview];
          });
          return <ActivityStep key={first.id} toolName={calls.length > 1 ? `${first.toolName} ×${calls.length}` : first.toolName}
            summary={clusterSummary(previews)} failed={failedLabel(failed, calls.length > 1)}
            duration={running ? "running" : `${failed ? "failed" : "complete"}${duration ? ` · ${duration}` : ""}`}>
            <ul className="process-job-subagent-calls">
              {calls.map((call) => <li key={call.id}>
                <span>{call.argsSummary ?? call.toolName}</span><span>{call.status}</span>
              </li>)}
            </ul>
          </ActivityStep>;
        })}
        {progress.answerHead !== undefined && <section className="process-job-subagent-report" aria-label="Subagent report">
          <strong>Report{progress.answerTruncated ? " (truncated)" : ""}</strong>
          <pre>{progress.answerHead}</pre>
        </section>}
      </>}
    </div>
  );
}
