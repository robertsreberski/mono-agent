import type { DataMessagePartProps } from "@assistant-ui/react";
import type { ReactNode } from "react";

import { Icon } from "./Icon";
import { safeJson } from "./json";

type ToolCallStatus = "running" | "complete" | "failed";

interface SubagentCallView {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly status: ToolCallStatus;
}

interface SubagentView {
  readonly name: string;
  readonly label?: string;
  readonly prompt?: string;
  readonly result?: unknown;
  readonly executionMs?: number;
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
        status: toolCallStatus(call.status),
      }];
    }),
  };
};

const toolStateLabel = (status: ToolCallStatus, result: unknown): string =>
  status === "running" ? "running" : status === "failed" ? "failed" : result === undefined ? "called" : "done";

const formatSeconds = (ms: number): string =>
  ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;

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
      </summary>
      <div className="tool-payload">
        <span>Input</span>
        <pre>{safeJson(call.args)}</pre>
        {call.result !== undefined && (
          <>
            <span>Output</span>
            <pre>{safeJson(call.result)}</pre>
          </>
        )}
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
  // The block stays folded, so the header carries the whole outcome.
  const summary = [
    `${view.calls.length} tool${view.calls.length === 1 ? "" : "s"}`,
    ...(view.status === "complete" ? [] : [view.status]),
    ...(view.executionMs === undefined ? [] : [formatSeconds(view.executionMs)]),
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
          : view.calls.map((call) => <SubagentCall key={call.toolCallId} call={call} />)}
        {view.result !== undefined && <SubagentNote title="Report">{safeJson(view.result)}</SubagentNote>}
      </div>
    </details>
  );
}
