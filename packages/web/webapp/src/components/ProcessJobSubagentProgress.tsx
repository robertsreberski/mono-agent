import { type ReactNode, useLayoutEffect, useRef } from "react";
import type { ProcessJobSubagentProgress as Progress, ToolCallStatus } from "../types";
import { ActivityStep, clusterSummary, failedLabel } from "./ActivityRow";
import { formatToolDuration } from "./duration";
import { resolveSubagentRoute } from "./route-label";
import { useRouteCapabilities } from "./route-capabilities";
import { RouteBadge } from "./RouteBadge";
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

/** One quiet, unlabelled line for child route/calls plus exceptional host facts. */
export function ProcessJobMetaLine({ progress, status, supplements = [] }: {
  readonly progress?: Progress;
  readonly status: ToolCallStatus;
  readonly supplements?: readonly ReactNode[];
}) {
  const capabilities = useRouteCapabilities();
  const route = progress?.route === undefined ? undefined : resolveSubagentRoute({
    requested: progress.route.requested,
    ...(progress.route.executed === undefined ? {} : { executed: progress.route.executed }),
    disposition: progress.route.disposition ?? "unknown",
    transitions: [],
    retries: [],
  }, status, capabilities.agent, capabilities.catalogModels);
  const items: ReactNode[] = [
    ...(progress === undefined ? [] : [<span key="profile" className="process-job-child-profile">{progress.profile}</span>]),
    ...(route === undefined ? [] : [<RouteBadge
      key="route"
      modelShort={route.modelShort}
      effortShort={route.effortShort}
      effortSignal={route.effortSignal}
      label={route.label}
      title={route.title}
      compact
      fallback={route.isFallback}
      requestedOnly={route.isRequestedOnly}
    />]),
    ...(progress === undefined ? [] : [<span key="tools">{progress.toolCalls} {progress.toolCalls === 1 ? "tool" : "tools"}{progress.failedCalls > 0
      ? `, ${progress.failedCalls} failed` : ""}</span>]),
    ...supplements,
  ];
  if (items.length === 0) return null;
  return <div className="process-job-live-meta">{items.flatMap((item, index) => index === 0
    ? [item]
    : [<span key={`separator-${String(index)}`} className="process-job-meta-separator" aria-hidden="true">·</span>, item])}</div>;
}

/**
 * UI-only evidence of a detached child's work, built from the same step and
 * payload primitives as a foreground subagent block so the card reads like the
 * transcript. The parent wake continues to read the job's separate output tail.
 */
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
      {progress === undefined
        ? <p className="process-job-subagent-note">Progress is unavailable for this retained job.</p>
        : <div className="activity-steps">
          {progress.recent.length === 0 && <p className="subagent-empty">No tool calls yet.</p>}
          {progress.toolCalls > progress.recent.length && (
            <p className="process-job-subagent-note">Showing the latest {progress.recent.length} of {progress.toolCalls} calls.</p>
          )}
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
              duration={running ? "running" : duration ?? (failed ? "failed" : "complete")}>
              <div className="activity-payload">
                <ul className="process-job-subagent-calls">
                  {calls.map((call) => <li key={call.id} data-status={call.status}>
                    <span className="process-job-subagent-call">{call.argsSummary ?? call.toolName}</span>
                    <span className="process-job-subagent-status">{call.status}</span>
                  </li>)}
                </ul>
              </div>
            </ActivityStep>;
          })}
          {progress.answerHead !== undefined && (
            <section className="process-job-subagent-report" aria-label="Subagent report">
              <ActivityStep toolName={`Report${progress.answerTruncated ? " (truncated)" : ""}`} defaultOpen>
                <div className="activity-payload"><pre>{progress.answerHead}</pre></div>
              </ActivityStep>
            </section>
          )}
        </div>}
    </div>
  );
}
