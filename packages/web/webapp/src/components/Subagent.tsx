import type { DataMessagePartProps } from "@assistant-ui/react";
import type { ReactNode } from "react";

import { formatUsd } from "../usage";
import {
  ActivityPayload,
  ActivityRow,
  ActivityStep,
  clusterSummary,
  failedLabel,
} from "./ActivityRow";
import { finiteDuration, formatToolDuration } from "./duration";
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
    ...(finiteDuration(record.executionMs) === undefined
      ? {}
      : { executionMs: record.executionMs as number }),
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

/**
 * A delegation's own calls fold the same way the agent's do, but one level
 * flatter: a repeated tool becomes a single step whose payload holds every
 * member, so a subagent never grows a third tier of disclosure.
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
      const durations = run.flatMap((member) => member.executionMs === undefined ? [] : [member.executionMs]);
      clustered.push({
        kind: "cluster",
        toolName: call.toolName,
        calls: run,
        failedCount: run.filter((member) => member.status === "failed").length,
        ...(durations.length === 0 ? {} : { executionMs: durations.reduce((sum, duration) => sum + duration, 0) }),
      });
    }
    index = cursor;
  }
  return clustered;
};

const joinPayloads = (values: readonly unknown[]): unknown =>
  values.length === 1 ? values[0] : values.map((value) => safeJson(value)).join("\n\n");

function SubagentStep({ call }: { readonly call: SubagentCallView }) {
  const historyFailure = toolHistoryFailure(call.history);
  return (
    <ActivityStep
      toolName={call.toolName}
      summary={toolArgumentPreview(call.args)}
      failed={failedLabel(call.status === "failed" ? 1 : 0, false)}
      duration={call.executionMs === undefined
        ? call.status === "running" ? "running" : undefined
        : formatToolDuration(call.executionMs)}
    >
      <ActivityPayload
        args={call.args}
        result={call.result}
        resultIsError={call.status === "failed"}
        error={historyFailure}
      />
    </ActivityStep>
  );
}

function SubagentClusterStep({ cluster }: { readonly cluster: SubagentCallCluster }) {
  const results = cluster.calls.flatMap((call) => call.result === undefined ? [] : [call.result]);
  const failures = cluster.calls.flatMap((call) => {
    const failure = toolHistoryFailure(call.history);
    return failure === undefined ? [] : [failure];
  });
  return (
    <ActivityStep
      toolName={`${cluster.toolName} ×${String(cluster.calls.length)}`}
      summary={clusterSummary(
        cluster.calls.flatMap((call) => {
          const preview = toolArgumentPreview(call.args);
          return preview === undefined ? [] : [preview];
        }),
      )}
      failed={failedLabel(cluster.failedCount, true)}
      duration={cluster.executionMs === undefined ? undefined : formatToolDuration(cluster.executionMs)}
    >
      <ActivityPayload
        args={joinPayloads(cluster.calls.map((call) => call.args))}
        result={results.length === 0 ? undefined : joinPayloads(results)}
        resultIsError={cluster.failedCount > 0}
        error={failures.length === 0 ? undefined : [...new Set(failures)].join("\n")}
      />
    </ActivityStep>
  );
}

/** The delegation's own prose — its task and its report — folded like every other step. */
function SubagentNote({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <ActivityStep toolName={title}>
      <div className="activity-payload">
        <pre>{children}</pre>
      </div>
    </ActivityStep>
  );
}

/**
 * One `Agent` delegation, rendered as an ordinary Activity row that **owns**
 * the calls its subagent made rather than listing them as siblings. Nesting is
 * what keeps concurrent delegations readable: subagents run in parallel and
 * their events interleave, so a flat transcript would shuffle several agents'
 * work together.
 */
export function SubagentPart({ data }: DataMessagePartProps) {
  const view = subagentView(data);
  if (view === undefined) return null;
  const historyFailure = toolHistoryFailure(view.history);
  const clusteredCalls = clusterSubagentCalls(view.calls);
  // The summary names *which* delegation this is; the meta slot carries what it
  // cost. A delegation is the one part of a turn that can quietly cost more than
  // the turn itself, and the run total it folds into cannot say which one did.
  const task = view.label ?? view.prompt?.replace(/\s+/gu, " ").trim();
  const meta = [
    `${String(view.calls.length)} tool${view.calls.length === 1 ? "" : "s"}`,
    ...(view.executionMs === undefined ? [] : [formatToolDuration(view.executionMs)]),
    ...(view.costUsd === undefined ? [] : [formatUsd(view.costUsd)]),
    // The folded row only flags that something is wrong; the note inside carries
    // the wording and the error code, so the two must not disagree.
    ...(historyFailure === undefined ? [] : ["history not saved"]),
  ].join(" · ");

  return (
    <ActivityRow
      variant="subagent"
      status={view.status}
      label="Subagent"
      summary={task === undefined ? view.name : `${view.name} — ${task}`}
      failed={failedLabel(view.status === "failed" ? 1 : 0, false)}
      duration={meta}
    >
      <div className="activity-steps">
        {view.prompt !== undefined && <SubagentNote title="Task">{view.prompt}</SubagentNote>}
        {view.calls.length === 0
          ? <p className="subagent-empty">No tool calls recorded.</p>
          : clusteredCalls.map((call) => "kind" in call
            ? <SubagentClusterStep key={call.calls[0]!.toolCallId} cluster={call} />
            : <SubagentStep key={call.toolCallId} call={call} />)}
        {view.result !== undefined && <SubagentNote title="Report">{safeJson(view.result)}</SubagentNote>}
        {historyFailure !== undefined && <SubagentNote title="History">{historyFailure}</SubagentNote>}
      </div>
    </ActivityRow>
  );
}
