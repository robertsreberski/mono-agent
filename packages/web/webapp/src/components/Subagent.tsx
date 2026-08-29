import type { DataMessagePartProps } from "@assistant-ui/react";
import type { ReactNode } from "react";

import { formatUsd } from "../usage";
import { finiteDuration, formatToolDuration } from "./duration";
import { Icon } from "./Icon";
import { safeJson } from "./json";
import { toolHistoryFailure } from "./tool-history";

type ToolCallStatus = "running" | "complete" | "failed";

interface SubagentCallView {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly executionMs?: number;
  readonly history?: Record<string, unknown>;
  readonly status: ToolCallStatus;
}

/** A run of adjacent same-tool calls the subagent made, folded into one row. */
interface SubagentCallCluster {
  readonly kind: "cluster";
  readonly toolName: string;
  readonly calls: readonly SubagentCallView[];
  readonly failedCount: number;
  readonly executionMs?: number;
}

interface SubagentView {
  readonly name: string;
  readonly label?: string;
  readonly prompt?: string;
  readonly result?: unknown;
  readonly executionMs?: number;
  readonly costUsd?: number;
  readonly history?: Record<string, unknown>;
  readonly status: ToolCallStatus;
  readonly calls: readonly SubagentCallView[];
}

const toolCallStatus = (value: unknown): ToolCallStatus =>
  value === "complete" || value === "failed" ? value : "running";

const nonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length === 0 ? undefined : text;
};

/** The task the delegation was given, which the store keeps on the `Agent` call's arguments. */
const delegationPrompt = (args: unknown): string | undefined => {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const prompt = (args as Record<string, unknown>).prompt;
  return typeof prompt === "string" && prompt.trim().length > 0 ? prompt.trim() : undefined;
};

const PREVIEW_MAX = 72;

/**
 * The argument keys tools use to name what they are acting on, most specific
 * first. A path beats a pattern so `Grep` reads as the directory it searched
 * rather than the regex, which is the part an operator scans for.
 */
const PREVIEW_KEYS = [
  "file_path",
  "path",
  "filePath",
  "pattern",
  "command",
  "query",
  "url",
  "prompt",
  "description",
  "name",
] as const;

/**
 * A one-line stand-in for a tool call's arguments, so a column of `Read` rows
 * says which files were read instead of repeating the tool's name.
 */
export function toolArgumentPreview(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const named = PREVIEW_KEYS.map((key) => nonEmptyString(record[key])).find((value) => value !== undefined);
  const value = named ?? Object.values(record).map(nonEmptyString).find((entry) => entry !== undefined);
  if (value === undefined || value.length <= PREVIEW_MAX) return value;
  // A path's tail identifies it, so keep the end; anything else reads forwards.
  return value.includes("/")
    ? `…${value.slice(value.length - (PREVIEW_MAX - 1))}`
    : `${value.slice(0, PREVIEW_MAX - 1)}…`;
}

/**
 * Read a delegation out of its data part. Deliberately defensive: the part
 * round-trips through JSON normalization, and a newer agent can send fields
 * this console does not know yet.
 */
const subagentView = (data: unknown): SubagentView | undefined => {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.name !== "string") return undefined;
  const calls = Array.isArray(record.calls) ? record.calls : [];
  const prompt = delegationPrompt(record.args);
  return {
    name: record.name,
    ...(typeof record.label === "string" && record.label.length > 0 ? { label: record.label } : {}),
    ...(prompt === undefined ? {} : { prompt }),
    ...(record.result === undefined || record.result === null ? {} : { result: record.result }),
    ...(typeof record.executionMs === "number" && Number.isFinite(record.executionMs)
      ? { executionMs: record.executionMs }
      : {}),
    ...(typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costUsd > 0
      ? { costUsd: record.costUsd }
      : {}),
    ...(record.history !== null && typeof record.history === "object" && !Array.isArray(record.history)
      ? { history: record.history as Record<string, unknown> }
      : {}),
    status: toolCallStatus(record.status),
    calls: calls.flatMap((entry): SubagentCallView[] => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
      const call = entry as Record<string, unknown>;
      if (typeof call.toolCallId !== "string" || typeof call.toolName !== "string") return [];
      return [{
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        ...(call.args === undefined || call.args === null ? {} : { args: call.args }),
        ...(call.result === undefined || call.result === null ? {} : { result: call.result }),
        ...(finiteDuration(call.executionMs) === undefined
          ? {}
          : { executionMs: call.executionMs as number }),
        ...(call.history !== null && typeof call.history === "object" && !Array.isArray(call.history)
          ? { history: call.history as Record<string, unknown> }
          : {}),
        status: toolCallStatus(call.status),
      }];
    }),
  };
};

const toolStateLabel = (status: ToolCallStatus, result: unknown): string =>
  status === "running" ? "running" : status === "failed" ? "failed" : result === undefined ? "called" : "done";

/** The delegation's own prose — its task and its report — folded like every other row. */
function SubagentNote({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <details className="tool-call subagent-note">
      <summary>
        <Icon name="chevron" size={14} />
        <span className="tool-name">{title}</span>
      </summary>
      <div className="tool-payload">
        <pre>{children}</pre>
      </div>
    </details>
  );
}

function SubagentCall({ call }: { readonly call: SubagentCallView }) {
  const preview = toolArgumentPreview(call.args);
  const historyFailure = toolHistoryFailure(call.history);
  // A settled call whose preview already says what it did needs no status word;
  // anything else still has to say where it stands.
  const state = call.status === "complete" && preview !== undefined
    ? undefined
    : toolStateLabel(call.status, call.result);

  return (
    <details className={`tool-call is-nested${call.status === "failed" ? " is-error" : ""}`}>
      <summary>
        <Icon name="chevron" size={14} />
        <span className={`tool-status${call.status === "running" ? " is-running" : ""}`} />
        <span className="tool-name">{call.toolName}</span>
        {preview !== undefined && <span className="subagent-call-preview">{preview}</span>}
        {state !== undefined && <span className="tool-state">{state}</span>}
        {call.executionMs !== undefined && (
          <time className="tool-duration">{formatToolDuration(call.executionMs)}</time>
        )}
      </summary>
      <div className="tool-payload">
        <span>Input</span>
        <pre>{safeJson(call.args)}</pre>
        {call.result !== undefined && (
          <>
            <span>{call.status === "failed" ? "Error" : "Output"}</span>
            <pre>{safeJson(call.result)}</pre>
          </>
        )}
        {historyFailure !== undefined && (
          <>
            <span>History</span>
            <pre>{historyFailure}</pre>
          </>
        )}
      </div>
    </details>
  );
}

/**
 * The same run-folding the agent's own activity log uses, applied to a
 * subagent's calls. A delegation that reads forty files is one row here too.
 */
const clusterSubagentCalls = (
  calls: readonly SubagentCallView[],
): readonly (SubagentCallView | SubagentCallCluster)[] => {
  const clustered: Array<SubagentCallView | SubagentCallCluster> = [];
  for (let index = 0; index < calls.length;) {
    const call = calls[index]!;
    if (call.toolName === "AskUser") {
      clustered.push(call);
      index += 1;
      continue;
    }
    const run = [call];
    let cursor = index + 1;
    while (cursor < calls.length && calls[cursor]!.toolName === call.toolName) {
      run.push(calls[cursor]!);
      cursor += 1;
    }
    if (run.length === 1) clustered.push(call);
    else {
      const durations = run.flatMap((member) =>
        member.executionMs === undefined ? [] : [member.executionMs]);
      clustered.push({
        kind: "cluster",
        toolName: call.toolName,
        calls: run,
        failedCount: run.filter((member) => member.status === "failed").length,
        ...(durations.length === 0
          ? {}
          : { executionMs: durations.reduce((sum, duration) => sum + duration, 0) }),
      });
    }
    index = cursor;
  }
  return clustered;
};

function SubagentCluster({ cluster }: { readonly cluster: SubagentCallCluster }) {
  return (
    <details className={`tool-call subagent-cluster${cluster.failedCount > 0 ? " is-error" : ""}`}>
      <summary>
        <Icon name="chevron" size={14} />
        <span className="tool-status" />
        <span className="tool-name">{`${cluster.toolName} \u00d7${String(cluster.calls.length)}`}</span>
        {cluster.failedCount > 0 && (
          <span className="failed-tag">{`${String(cluster.failedCount)} failed`}</span>
        )}
        {cluster.executionMs !== undefined && (
          <time className="tool-duration">{formatToolDuration(cluster.executionMs)}</time>
        )}
      </summary>
      <div className="subagent-cluster-calls">
        {cluster.calls.map((call) => <SubagentCall key={call.toolCallId} call={call} />)}
      </div>
    </details>
  );
}

/**
 * One `Agent` delegation: a folded header that summarizes the run, over a
 * rail-mounted list of the subagent's own calls. The rail is what separates a
 * subagent's work from the agent's own in a busy activity log.
 */
export function SubagentPart({ data }: DataMessagePartProps) {
  const view = subagentView(data);
  if (view === undefined) return null;
  const historyFailure = toolHistoryFailure(view.history);
  // The block stays folded, so the header carries the whole outcome.
  const summary = [
    `${view.calls.length} tool${view.calls.length === 1 ? "" : "s"}`,
    ...(view.status === "complete" ? [] : [view.status]),
    ...(view.executionMs === undefined ? [] : [formatToolDuration(view.executionMs)]),
    // A delegation is the one part of a turn that can quietly cost more than
    // the turn itself, and the run total it folds into cannot say which one did.
    ...(view.costUsd === undefined ? [] : [formatUsd(view.costUsd)]),
    // The folded header only flags that something is wrong; the note inside
    // carries the wording and the error code, so the two must not disagree.
    ...(historyFailure === undefined ? [] : ["history not saved"]),
  ].join(" · ");

  return (
    <details className={`tool-call subagent${view.status === "failed" ? " is-error" : ""}`}>
      <summary>
        <Icon name="chevron" size={14} />
        <span className={`tool-status${view.status === "running" ? " is-running" : ""}`} />
        <span className="subagent-mark" aria-hidden="true"><Icon name="agent" size={12} /></span>
        <span className="tool-name">{view.name}</span>
        {view.label !== undefined && <span className="subagent-label">{view.label}</span>}
        <span className="tool-state">{summary}</span>
      </summary>
      <div className="subagent-payload">
        {view.prompt !== undefined && <SubagentNote title="Task">{view.prompt}</SubagentNote>}
        {view.calls.length === 0
          ? <p className="subagent-empty">No tool calls recorded.</p>
          : clusterSubagentCalls(view.calls).map((entry) => "kind" in entry
            ? <SubagentCluster key={entry.calls[0]!.toolCallId} cluster={entry} />
            : <SubagentCall key={entry.toolCallId} call={entry} />)}
        {view.result !== undefined && <SubagentNote title="Report">{safeJson(view.result)}</SubagentNote>}
        {historyFailure !== undefined && <SubagentNote title="History">{historyFailure}</SubagentNote>}
      </div>
    </details>
  );
}
