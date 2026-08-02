import { readFileSync, statSync } from "node:fs";

// Claude Code runs a native subagent as a background task: the parent's `Agent`
// tool returns "launched" immediately and the child streams nothing into the
// parent's stdout. Its lifecycle arrives as three `system` events keyed by the
// originating `tool_use_id`:
//
//   task_started       subagent_type, description, prompt
//   task_updated       {status, end_time}
//   task_notification  status, summary, usage, output_file
//
// `output_file` points at the child's own transcript JSONL (usually a symlink
// into ~/.claude/projects/<project>/<session>/subagents/). Replaying it is the
// only way to see what the child actually did — its thinking and tool calls are
// absent from every event the parent receives.
//
// The replay is projected onto the same `subagent_activity` contract the
// in-process `Agent` built-in emits (agent/tools/agent-tool.js), so a host
// renders native and in-process subagents through one code path.

/** Refuse to load a runaway transcript into memory; a capped read beats an OOM. */
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
/** Matches the in-process collector's cap so one delegation cannot flood the wire. */
const WIRE_CONTENT_MAX_CHARS = 2_000;

/** @param {unknown} value */
function boundedText(value) {
  if (typeof value !== "string") return undefined;
  return value.length > WIRE_CONTENT_MAX_CHARS ? `${value.slice(0, WIRE_CONTENT_MAX_CHARS)}…` : value;
}

/**
 * Read the child transcript named by a task_notification.
 * Returns [] for anything unreadable: the transcript is additive telemetry and
 * must never fail the parent run. Callers cannot distinguish "no file" from
 * "unreadable file", which is deliberate — neither changes what they do.
 * @param {string} path
 * @param {{maxBytes?: number, readFile?: (p: string) => string, statFile?: (p: string) => {size: number}}} [io]
 * @returns {Array<Record<string, unknown>>}
 */
export function readSubagentTranscript(path, io = {}) {
  const maxBytes = io.maxBytes ?? MAX_TRANSCRIPT_BYTES;
  const readFile = io.readFile ?? ((p) => readFileSync(p, "utf8"));
  const statFile = io.statFile ?? ((p) => statSync(p));
  try {
    // statSync follows the symlink, so this bounds the real transcript.
    if (statFile(path).size > maxBytes) return [];
    return readFile(path)
      .split("\n")
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Project one child transcript onto ordered `subagent_activity` payloads.
 *
 * Tool ids are namespaced `agent:<taskId>:<toolUseId>` for the same reason the
 * in-process collector does it: hosts key tool state flatly on the id, so two
 * subagents both running Read would otherwise collapse into one panel.
 *
 * Unlike the in-process collector this DOES forward the child's thinking and
 * text, as `phase: "message"`. That collector drops them because its caller
 * splices assistant text straight into the parent's answer; here the child has
 * already finished and its text reached the parent through the tool result, so
 * forwarding is safe and is the only way a host can show what the child thought.
 * Hosts that switch on the known phases ignore `message` without change.
 *
 * @param {Array<Record<string, any>>} entries Parsed transcript lines.
 * @param {{taskId: string, subagentType: string}} context
 * @returns {Array<Record<string, unknown>>}
 */
export function subagentActivityFromTranscript(entries, { taskId, subagentType }) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  /** @type {Map<string, {name: string, startedAt: number|undefined}>} */
  const open = new Map();
  const prefix = `agent:${taskId}`;

  for (const entry of entries) {
    const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    const at = Date.parse(entry?.timestamp ?? "");
    for (const block of blocks) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        const name = String(block.name ?? "?");
        open.set(block.id, { name, startedAt: Number.isNaN(at) ? undefined : at });
        out.push({
          phase: "started",
          id: `${prefix}:${block.id}`,
          name: `${subagentType}▸${name}`,
          arguments: block.input,
        });
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        const entryInfo = open.get(block.tool_use_id);
        open.delete(block.tool_use_id);
        const ms = entryInfo?.startedAt !== undefined && !Number.isNaN(at)
          ? at - entryInfo.startedAt
          : undefined;
        out.push({
          phase: "completed",
          id: `${prefix}:${block.tool_use_id}`,
          name: `${subagentType}▸${entryInfo?.name ?? "?"}`,
          isError: block.is_error === true,
          ...(ms === undefined ? {} : { executionMs: ms }),
          content: boundedText(typeof block.content === "string" ? block.content : JSON.stringify(block.content)),
        });
      } else if (block?.type === "thinking" || block?.type === "text") {
        const text = boundedText(block.type === "thinking" ? block.thinking : block.text);
        if (!text) continue;
        out.push({
          phase: "message",
          id: `${prefix}:${entry.uuid ?? out.length}`,
          kind: block.type,
          role: entry?.type === "assistant" ? "assistant" : "user",
          content: text,
        });
      }
    }
  }

  // A child killed mid-tool leaves an open entry; close it so a host is not left
  // rendering a spinner forever.
  for (const [id, info] of open) {
    out.push({
      phase: "completed",
      id: `${prefix}:${id}`,
      name: `${subagentType}▸${info.name}`,
      isError: true,
      content: "subagent ended before this tool returned",
    });
  }
  return out;
}

/**
 * Correlates Claude Code's per-task `system` events into `subagent_activity`.
 *
 * State is required because the events are split: only `task_started` names the
 * profile and only `task_notification` reports the outcome, and they are keyed
 * to each other by `task_id`. A notification for a task we never saw start is
 * still reported, using the task id as the name, so a resumed session does not
 * silently drop a delegation.
 *
 * @param {{maxBytes?: number, readFile?: (p: string) => string, statFile?: (p: string) => {size: number}}} [io]
 */
export function createClaudeSubagentTracker(io = {}) {
  /** @type {Map<string, {subagentType: string, description?: string, callIndex: number, toolUseId?: string}>} */
  const tasks = new Map();
  let callIndex = 0;

  return {
    /**
     * @param {Record<string, any>} raw One decoded CLI stdout line.
     * @returns {Array<Record<string, unknown>>} Events to emit, in order.
     */
    observe(raw) {
      if (raw?.type !== "system" || typeof raw.task_id !== "string") return [];
      const taskId = raw.task_id;

      if (raw.subtype === "task_started") {
        const subagentType = String(raw.subagent_type ?? "subagent");
        const description = typeof raw.description === "string" ? raw.description : undefined;
        // The parent's own Agent tool_use id. Without it a host cannot attach
        // this delegation to the tool call that started it, and the child's rows
        // would float loose in the parent's timeline.
        const toolUseId = typeof raw.tool_use_id === "string" ? raw.tool_use_id : undefined;
        const entry = { subagentType, description, callIndex: callIndex++, toolUseId };
        tasks.set(taskId, entry);
        return [{
          type: "subagent_activity",
          subagent: {
            id: taskId,
            name: subagentType,
            callIndex: entry.callIndex,
            ...(toolUseId === undefined ? {} : { toolUseId }),
            ...(description === undefined ? {} : { label: description }),
          },
          phase: "agent_started",
          id: `agent:${taskId}`,
          name: `Agent(${subagentType})`,
          arguments: {
            name: subagentType,
            ...(description === undefined ? {} : { description }),
            ...(typeof raw.prompt === "string" ? { prompt: boundedText(raw.prompt) } : {}),
          },
        }];
      }

      if (raw.subtype !== "task_notification") return [];
      const entry = tasks.get(taskId);
      tasks.delete(taskId);
      const subagentType = entry?.subagentType ?? taskId;
      const notificationToolUseId = typeof raw.tool_use_id === "string" ? raw.tool_use_id : undefined;
      const toolUseId = entry?.toolUseId ?? notificationToolUseId;
      const subagent = {
        id: taskId,
        name: subagentType,
        callIndex: entry?.callIndex ?? callIndex++,
        ...(toolUseId === undefined ? {} : { toolUseId }),
        ...(entry?.description === undefined ? {} : { label: entry.description }),
      };
      const wrap = (payload) => ({ type: "subagent_activity", subagent, ...payload });

      const replay = typeof raw.output_file === "string"
        ? subagentActivityFromTranscript(readSubagentTranscript(raw.output_file, io), { taskId, subagentType })
        : [];

      const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
      const toolUses = Number.isFinite(Number(usage.tool_uses)) ? Number(usage.tool_uses) : replay.filter((e) => e.phase === "started").length;
      return [
        ...replay.map(wrap),
        wrap({
          phase: "agent_completed",
          id: `agent:${taskId}`,
          name: `Agent(${subagentType})`,
          isError: raw.status !== "completed",
          ...(Number.isFinite(Number(usage.duration_ms)) ? { executionMs: Number(usage.duration_ms) } : {}),
          content: boundedText(typeof raw.summary === "string" && raw.summary
            ? raw.summary
            : `${raw.status ?? "ended"} · ${toolUses} tool call${toolUses === 1 ? "" : "s"}`),
          ...(Number.isFinite(Number(usage.total_tokens)) ? { totalTokens: Number(usage.total_tokens) } : {}),
        }),
      ];
    },
  };
}
