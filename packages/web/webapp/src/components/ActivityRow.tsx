import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { safeJson } from "./json";

export { formatToolDuration } from "./duration";

export type ActivityStatus = "complete" | "running" | "failed";

/**
 * Tool display names come from a table, not from a heuristic on the wire name:
 * substring-matching turned `memory_search` into "Search", which is a different
 * tool. Anything absent from the table is de-underscored rather than guessed at,
 * so an unknown tool reads as itself instead of as the wrong verb.
 */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  read_file: "Read",
  edit_file: "Edit",
  write_file: "Write",
  memory_search: "Memory search",
};

export const toolVerb = (toolName: string): string =>
  TOOL_VERBS[toolName]
  ?? toolName.replaceAll(/[_-]+/gu, " ").replace(/^./u, (character) => character.toLocaleUpperCase());

/**
 * Slash-separated segments of ordinary filename characters, and nothing else.
 * A preview is whatever argument the tool was given, so the shortening below has
 * to recognise a path rather than assume one: a shell command, a URL and a regex
 * all contain slashes, and treating them as paths would render
 * `git clone https://host/org/repo` as `repo`, `.*∕src∕.*` as `.*`, and the
 * date `2026/08/30` as `30`.
 */
const PATH_LIKE = /^(?:\.{0,2}\/|~\/|\/)?[\p{L}\p{N}._@+-]+(?:\/[\p{L}\p{N}._@+-]+)+$/u;
/** `2026/08/30` and `1/2` are slash-separated too, and neither has a leaf. */
const ALL_NUMERIC_SEGMENTS = /^[\d/]+$/u;

/** `blog/outline.md` reads as `outline.md`: a row shows the leaf, not the path. */
const summaryLeaf = (summary: string): string => {
  if (!PATH_LIKE.test(summary) || ALL_NUMERIC_SEGMENTS.test(summary)) return summary;
  const leaf = summary.split("/").filter(Boolean).pop();
  return leaf === undefined || leaf.length === 0 ? summary : leaf;
};

/** Deduped leaves, two shown and the rest counted: `outline.md, voice.md +2`. */
export const clusterSummary = (summaries: readonly string[]): string | undefined => {
  const unique = [...new Set(summaries.filter((value) => value.length > 0).map(summaryLeaf))];
  if (unique.length === 0) return undefined;
  const overflow = unique.length - 2;
  return `${unique.slice(0, 2).join(", ")}${overflow > 0 ? ` +${String(overflow)}` : ""}`;
};

/** One failure says "failed"; a cluster counts them. Zero says nothing at all. */
export const failedLabel = (failedCount: number, clustered: boolean): string | undefined =>
  failedCount === 0 ? undefined : clustered ? `${String(failedCount)} failed` : "failed";

/**
 * One row for every activity entry. A single call, a `Read ×4` cluster, a
 * thought, and a subagent delegation are the same shape — only the leading
 * glyph and what expanding reveals differ. Keeping them identical is what
 * makes a long Activity log scannable.
 */
export function ActivityRow({
  variant = "tool",
  status = "complete",
  label,
  summary,
  failed,
  duration,
  open,
  children,
}: {
  readonly variant?: "tool" | "thinking" | "subagent";
  readonly status?: ActivityStatus;
  readonly label?: string;
  readonly summary?: string;
  readonly failed?: string;
  readonly duration?: string;
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <details className={`activity-row is-${variant} is-${status}`} open={open}>
      <summary>
        <span className="activity-row-glyph">
          {variant === "tool" && <i className="activity-dot" />}
          {variant === "thinking" && <Icon name="bulb" size={14} />}
          {variant === "subagent" && <Icon name="agent" size={14} />}
        </span>
        {label !== undefined && <strong className="activity-row-label">{label}</strong>}
        {summary !== undefined && <span className="activity-row-summary">{summary}</span>}
        {failed !== undefined && <span className="failed-tag">{failed}</span>}
        {duration !== undefined && <span className="activity-row-time">{duration}</span>}
        <Icon className="activity-row-chevron" name="chevron-down" size={13} />
      </summary>
      {children}
    </details>
  );
}

/** Input / Output / Error panels, shared by every expandable activity row. */
export function ActivityPayload({
  args,
  result,
  resultIsError = false,
  error,
  indented = false,
}: {
  readonly args?: unknown;
  readonly result?: unknown;
  /** A failed call returns its error as the result; it is still worth reading as JSON. */
  readonly resultIsError?: boolean;
  /** Prose failures — a history-writer error, an aborted fetch — read better tinted. */
  readonly error?: string;
  readonly indented?: boolean;
}) {
  return (
    <div className={`activity-payload${indented ? " is-indented" : ""}`}>
      <span>Input</span>
      <pre>{safeJson(args)}</pre>
      {result !== undefined && (
        <>
          <span>{resultIsError ? "Error" : "Output"}</span>
          <pre>{safeJson(result)}</pre>
        </>
      )}
      {error !== undefined && <p className="activity-error">{error}</p>}
    </div>
  );
}

/**
 * A member of an expanded cluster. Deliberately flatter than the row that owns
 * it: no status dot, no chevron, and no state word, because at this depth a
 * failure is the only thing worth calling out.
 */
export function ActivityStep({
  toolName,
  summary,
  failed,
  duration,
  children,
}: {
  readonly toolName: string;
  readonly summary?: string;
  readonly failed?: string;
  readonly duration?: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="activity-step">
      <summary>
        <span className="activity-step-tool">{toolName}</span>
        <span className="activity-step-summary">{summary}</span>
        {failed === undefined ? <span /> : <span className="failed-tag">{failed}</span>}
        <span className="activity-step-time">{duration}</span>
      </summary>
      {children}
    </details>
  );
}
