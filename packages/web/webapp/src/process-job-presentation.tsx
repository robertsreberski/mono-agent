import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import {
  mergeProcessJobProjection,
  processJobThreadId,
  TERMINAL_PROCESS_JOB_STATES,
} from "./components/ProcessJob";
import { shouldShowMessageRunAttribution } from "./components/RunAttribution";
import type { MessagePart, ProcessJobProjection, ToolCallStatus, WebMessage } from "./types";

export type ProcessJobPartValue = Extract<MessagePart, { type: "process-job" }>;

export interface ProcessJobPresentationEntry {
  readonly messageId: string;
  readonly part: ProcessJobPartValue;
}

export interface ProcessJobPresentation {
  readonly messages: readonly WebMessage[];
  readonly jobs: readonly ProcessJobPresentationEntry[];
  readonly eventsByMessageId: ReadonlyMap<string, readonly ProcessJobActivityEvent[]>;
  readonly jobsById: ReadonlyMap<string, ProcessJobProjection>;
  /** The parent's calls to its detached children, in transcript order. */
  readonly parentCalls: readonly ProcessJobParentCall[];
}

/**
 * The kind of child a job or a parent call belongs to. A subagent instance id
 * (Agent/AgentManage) and a peer name (PeerAgent) live in different
 * namespaces, so the shelf never groups across families.
 */
export type ProcessJobAgentFamily = "agent" | "peer";

const isPeerAgentToolName = (name: string): boolean => name === "PeerAgent" || name.endsWith("__PeerAgent");

export const processJobAgentFamily = (tool: string): ProcessJobAgentFamily | undefined =>
  isSubagentProcessJobTool(tool) ? "agent" : isPeerAgentToolName(tool) ? "peer" : undefined;

/**
 * What one parent call said to (or did to) a detached child.
 *
 * `brief` is an Agent prompt; `message` an AgentManage message or a PeerAgent
 * send; `steer`, `stop` and `close` are AgentManage controls; `answer` and
 * `decline` answer a peer's question.
 */
export type ProcessJobParentAction = "brief" | "message" | "steer" | "stop" | "close" | "answer" | "decline";

/**
 * One call from the parent agent to a detached child, read from the loaded
 * transcript. Everything here is text the transcript already carries, in the
 * shape the server already shaped it; the job projection never holds prompts.
 */
export interface ProcessJobParentCall {
  readonly messageId: string;
  readonly toolCallId: string;
  /** The tool the parent called, without any MCP server prefix. */
  readonly tool: string;
  readonly family: ProcessJobAgentFamily;
  /**
   * The subagent instance id or peer name the call addressed. A launch whose
   * arguments do not name it (a generated instance id) is joined through the
   * job it started instead.
   */
  readonly instanceId?: string;
  /** The peer thread a PeerAgent call addressed. */
  readonly thread?: string;
  readonly action: ProcessJobParentAction;
  /** The model-authored text: prompt, message, steer or a peer answer. */
  readonly text?: string;
  /** The server sent only the head of the call's arguments. */
  readonly argsTruncated?: boolean;
  /** Character length of the untruncated arguments, when truncated. */
  readonly argsBytes?: number;
  /**
   * The detached job this call started. Set only from a host receipt that is
   * the ONLY claim on that job in the loaded transcript: the canonical start
   * receipt for Agent/AgentManage, or PeerAgent's exact started JSON in a
   * detached mode. Tool result text is otherwise never trusted to link a job.
   */
  readonly launchedJobId?: string;
  /** The job a steer or stop reached, from its validated receipt. */
  readonly targetJobId?: string;
  /** A steer's or stop's validated receipt status; unknown values are dropped. */
  readonly outcome?: ProcessJobControlOutcome;
  /** A message that also asks to close the instance once its turn succeeds. */
  readonly closes?: boolean;
  /** The host's own result confirms the instance closed. */
  readonly closed?: boolean;
  /** Ran inside the parent's turn: no detached job can follow it. */
  readonly foreground?: boolean;
  /** A foreground call that completed and returned a result. */
  readonly answered?: boolean;
  /** The parent's own call: running, answered, or failed. */
  readonly status: ToolCallStatus;
  /** When the parent message holding the call started (an ordering hint only). */
  readonly at: string;
}

/** Receipt statuses the AgentManage steer and stop tools define. */
export type ProcessJobControlOutcome =
  | "applied" | "pending" | "not_applied" | "unsupported"
  | "stopped" | "stop_requested" | "already_idle";

const STEER_OUTCOMES: ReadonlySet<string> = new Set(["applied", "pending", "not_applied", "unsupported"]);
const STOP_OUTCOMES: ReadonlySet<string> = new Set(["stopped", "stop_requested", "already_idle"]);

/**
 * Tool a process-job receipt or activity row can name.
 *
 * `"AgentSend"` is legacy history: the tool was renamed to `AgentManage` with
 * no alias, and retained transcripts still carry the old name on their stored
 * receipts and activity rows. Accepted on these read paths so old job cards
 * keep rendering identically; never emitted for new work.
 */
export type ProcessJobToolName = "Exec" | "Bash" | "Agent" | "AgentManage" | "AgentSend" | "PeerAgent";

/** Accepted process-job tool names, including the legacy `AgentSend` history value. */
export const PROCESS_JOB_TOOL_NAMES: readonly ProcessJobToolName[] = ["Exec", "Bash", "Agent", "AgentManage", "AgentSend", "PeerAgent"];

/** Whether a stored or live process-job row belongs to a subagent tool (legacy name included). */
export const isSubagentProcessJobTool = (tool: string): boolean =>
  tool === "Agent" || tool === "AgentManage" || tool === "AgentSend";

export interface ProcessJobStartReceipt {
  readonly schema: "mono-agent.process-job-start-receipt.v1";
  readonly jobId: string;
  readonly tool: ProcessJobToolName;
  readonly state: "queued" | "starting" | "running";
  readonly startedAt: string | null;
  readonly maxRuntimeMs?: number;
}

export interface ProcessJobActivityEvent {
  readonly schema: "mono-agent.process-job-activity-event.v1";
  readonly id: string;
  readonly toolCallId: string;
  readonly jobId: string;
  readonly tool: ProcessJobToolName;
  readonly summary: string;
  readonly phase: "started" | "terminal";
  readonly state: ProcessJobProjection["state"];
  readonly occurredAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  /**
   * The paired launch call's arguments, folded into the started row so the
   * launch tool-call row can stay suppressed without losing its Input.
   *
   * Only the conversion sets this, and only on the started phase that replaces
   * its launch call; the projection never carries it and the terminal row never
   * needs it. Absent on retained events that predate the fold, which still
   * render as job facts alone.
   */
  readonly launchArgs?: unknown;
  /** The launch arguments arrived as a preview; see {@link ToolCall.argsTruncated}. */
  readonly launchArgsTruncated?: boolean;
  /** Character length of the untruncated launch arguments, when truncated. */
  readonly launchArgsBytes?: number;
}

export const processJobTerminalEvent = (
  job: ProcessJobProjection,
  toolCallId: string,
): ProcessJobActivityEvent => ({
  schema: "mono-agent.process-job-activity-event.v1",
  id: `process-job:${job.jobId}:terminal`,
  toolCallId,
  jobId: job.jobId,
  tool: job.tool,
  summary: job.summary,
  phase: "terminal",
  state: job.state,
  ...(job.timestamps.completedAt === null ? {} : { occurredAt: job.timestamps.completedAt }),
  ...(job.durationMs === null ? {} : { durationMs: job.durationMs }),
  ...(job.exitCode === null ? {} : { exitCode: job.exitCode }),
  ...(job.signal === null ? {} : { signal: job.signal }),
});

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const canonicalIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

/** Parse only the canonical host receipt on its containing Exec/Bash call. */
export const parseProcessJobStartReceipt = (
  value: unknown,
  containingTool: string,
): ProcessJobStartReceipt | undefined => {
  if (!isPlainRecord(value)) return undefined;
  try {
    const keys = Object.keys(value);
    const allowed = ["schema", "jobId", "tool", "state", "startedAt", "maxRuntimeMs"];
    const required = allowed.slice(0, 5);
    if (!required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
      || keys.some((key) => !allowed.includes(key))
      || keys.length !== required.length + (Object.prototype.hasOwnProperty.call(value, "maxRuntimeMs") ? 1 : 0)
      || value.schema !== "mono-agent.process-job-start-receipt.v1"
      || !PROCESS_JOB_TOOL_NAMES.includes(String(value.tool) as ProcessJobToolName)
      || value.tool !== containingTool
      || typeof value.jobId !== "string"
      || value.jobId.trim().length === 0
      || value.jobId.length > 256
      || (value.state !== "queued" && value.state !== "starting" && value.state !== "running")
      || (value.startedAt !== null && !canonicalIsoTimestamp(value.startedAt))
      || (Object.prototype.hasOwnProperty.call(value, "maxRuntimeMs")
        && (!Number.isSafeInteger(value.maxRuntimeMs) || Number(value.maxRuntimeMs) <= 0))) return undefined;
    return value as unknown as ProcessJobStartReceipt;
  } catch {
    return undefined;
  }
};

const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** The host mints peer job ids with `randomUUID`. */
const JOB_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const nonEmptyText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/** A tool result's text: a string, or its text content blocks joined. */
const resultText = (result: unknown): string | undefined =>
  typeof result === "string" ? result
    : Array.isArray(result) ? result.map((block) => isPlainRecord(block) && typeof block.text === "string" ? block.text : "").join("")
      : isPlainRecord(result) && typeof result.text === "string" ? result.text : undefined;

/**
 * The JSON record a host control receipt is, when the WHOLE result is one.
 * Anything else (prose, a trailing line, a quoted receipt) is no receipt.
 */
const wholeResultRecord = (result: unknown): Record<string, unknown> | undefined => {
  const text = resultText(result)?.trim();
  if (text === undefined || !text.startsWith("{") || !text.endsWith("}")) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return isPlainRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const hasExactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
};

/**
 * PeerAgent's started receipt, `{peer, thread, jobId, state: "started"}` and
 * nothing else, for exactly the addressed peer and thread. Only a DETACHED
 * send or answer returns it; in the foreground the result is the peer's own
 * reply, which may be any text, so it is never read as a receipt.
 */
const peerStartedJobId = (result: unknown, peer: string, thread: string | undefined): string | undefined => {
  const record = wholeResultRecord(result);
  if (record === undefined || thread === undefined || !hasExactKeys(record, ["peer", "thread", "jobId", "state"])) return undefined;
  return record.state === "started" && record.peer === peer && record.thread === thread
    && typeof record.jobId === "string" && JOB_UUID.test(record.jobId) ? record.jobId : undefined;
};

/** A steer or stop receipt for exactly this instance, with a status its tool defines. */
const controlReceipt = (
  result: unknown,
  instanceId: string,
  outcomes: ReadonlySet<string>,
): { readonly outcome?: ProcessJobControlOutcome; readonly targetJobId?: string } => {
  const record = wholeResultRecord(result);
  if (record === undefined || record.instanceId !== instanceId) return {};
  return {
    ...(typeof record.status === "string" && outcomes.has(record.status) ? { outcome: record.status as ProcessJobControlOutcome } : {}),
    ...(typeof record.jobId === "string" && record.jobId.length > 0 ? { targetJobId: record.jobId } : {}),
  };
};

/**
 * The host's result header says this instance is closed: a close-only call
 * answers exactly `<subagent: NAME · instance ID · turn N · closed>`, and a
 * foreground turn that closed after it opens its result with the same header.
 */
const confirmsClosed = (result: unknown, instanceId: string, exact: boolean): boolean => {
  const text = resultText(result)?.trim();
  if (text === undefined) return false;
  const header = new RegExp(`^<subagent: [^<>\\n]+ · instance ${instanceId} · turn \\d+ · closed${exact ? ">$" : "(?: · [^<>\\n]*)?>"}`, "u");
  return header.test(text);
};

/** A peer answer as readable lines: `field: value`, one per answered field. */
const peerAnswerText = (answers: unknown): string | undefined => {
  if (!isPlainRecord(answers)) return undefined;
  const lines = Object.entries(answers).flatMap(([key, value]) => {
    const text = Array.isArray(value) ? value.filter((item) => typeof item === "string").join(", ")
      : typeof value === "string" ? value : "";
    return text.length > 0 ? [`${key}: ${text}`] : [];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
};

type ToolCallValue = Extract<MessagePart, { type: "tool-call" }>;

/**
 * Every call the parent made to its detached children, in transcript order:
 * Agent/AgentManage launches and PeerAgent sends and answers confirmed to have
 * detached (each paired with the job it started only through a host receipt
 * that is the one claim on that job), foreground continuations, and controls
 * addressed by instance id or peer.
 *
 * Read-only presentation data: nothing here is fetched or stored, and only the
 * prompt, message, steer and answer texts are read from the arguments. Result
 * text is read only where it is the host's own receipt or header.
 */
export const collectProcessJobParentCalls = (
  messages: readonly WebMessage[],
  threadId: string,
): readonly ProcessJobParentCall[] => {
  const inThread = messages.filter((message) => message.role === "assistant" && message.threadId === threadId);
  const parts = inThread.flatMap((message) => message.parts.flatMap((part) =>
    part.type === "tool-call" || part.type === "subagent" ? [{ message, part }] : []));

  // How each PeerAgent call ran, as far as the transcript CONFIRMS it.
  // - A send states its own mode (`background: true` detaches it). A thread's
  //   mode is set only by a send that completed: detached when its result is
  //   the host's exact started receipt, foreground otherwise. A failed,
  //   running or unconfirmed send never sets or overwrites it.
  // - An answer or decline runs in the mode of the relay its thread's last
  //   confirmed send opened. With no such send loaded its mode is unknown: it
  //   pairs no job and makes no claim about how it ended.
  // Only a detached call's result is host text; a foreground result is the
  // peer's own reply, which may look like anything, so it is never read.
  const threadModes = new Map<string, "detached" | "foreground">();
  const peerModes = new Map<ToolCallValue, "detached" | "foreground">();
  const peerJobByCall = new Map<ToolCallValue, string>();
  for (const { part } of parts) {
    if (part.type !== "tool-call" || !isPeerAgentToolName(part.toolName)) continue;
    const args = isPlainRecord(part.args) ? part.args : undefined;
    const peer = nonEmptyText(args?.peer);
    const thread = nonEmptyText(args?.thread);
    if (peer === undefined || thread === undefined) continue;
    const key = `${peer}\0${thread}`;
    if (args?.action === "send") {
      if (args.background === true) {
        peerModes.set(part, "detached");
        const jobId = part.status === "complete" ? peerStartedJobId(part.result, peer, thread) : undefined;
        if (jobId === undefined) continue;
        peerJobByCall.set(part, jobId);
        threadModes.set(key, "detached");
      } else {
        peerModes.set(part, "foreground");
        if (part.status === "complete") threadModes.set(key, "foreground");
      }
    } else if (args?.action === "answer" || args?.action === "decline") {
      const mode = threadModes.get(key);
      if (mode === undefined) continue;
      peerModes.set(part, mode);
      if (mode !== "detached" || part.status !== "complete") continue;
      const jobId = peerStartedJobId(part.result, peer, thread);
      if (jobId !== undefined) peerJobByCall.set(part, jobId);
    }
  }

  // Every claim on a job id, from either receipt kind. A job claimed twice is
  // paired with neither: the rows stay, the turn is placed by time.
  const claims = new Map<string, number>();
  const claim = (jobId: string) => claims.set(jobId, (claims.get(jobId) ?? 0) + 1);
  for (const { part } of parts) {
    if (part.type !== "tool-call") continue;
    if (isSubagentProcessJobTool(part.toolName)) {
      const receipt = parseProcessJobStartReceipt(part.structuredResult, part.toolName);
      if (receipt !== undefined) claim(receipt.jobId);
    }
  }
  for (const jobId of peerJobByCall.values()) claim(jobId);
  const unique = (jobId: string | undefined) =>
    jobId !== undefined && claims.get(jobId) === 1 ? { launchedJobId: jobId } : {};

  const calls: ProcessJobParentCall[] = [];
  for (const { message, part } of parts) {
    const args = isPlainRecord(part.args) ? part.args : undefined;
    const id = typeof args?.id === "string" && INSTANCE_ID.test(args.id) ? args.id : undefined;
    const answered = part.status === "complete" && nonEmptyText(resultText(part.result)) !== undefined;
    const base = {
      messageId: message.id,
      toolCallId: part.toolCallId,
      status: part.status,
      at: message.createdAt,
      ...(part.argsTruncated === true ? { argsTruncated: true } : {}),
      ...(part.argsBytes === undefined ? {} : { argsBytes: part.argsBytes }),
    };
    const foregroundTurn = { foreground: true, ...(answered ? { answered: true } : {}) };

    // A foreground delegation streams its child's calls, so the store keeps
    // it as a subagent part without its tool name; its arguments say which.
    if (part.type === "subagent") {
      if (id === undefined) continue;
      const message_ = nonEmptyText(args?.message);
      const prompt = nonEmptyText(args?.prompt);
      if (message_ !== undefined && prompt === undefined) {
        calls.push({ ...base, ...foregroundTurn, tool: "AgentManage", family: "agent", instanceId: id, action: "message", text: message_,
          ...(args?.close === true ? { closes: true } : {}),
          ...(args?.close === true && part.status === "complete" && confirmsClosed(part.result, id, false) ? { closed: true } : {}) });
      } else if (prompt !== undefined && args?.persist === true) {
        calls.push({ ...base, ...foregroundTurn, tool: "Agent", family: "agent", instanceId: id, action: "brief", text: prompt });
      }
      continue;
    }

    if (isSubagentProcessJobTool(part.toolName)) {
      const receipt = parseProcessJobStartReceipt(part.structuredResult, part.toolName);
      const brief = part.toolName === "Agent";
      const text = nonEmptyText(brief ? args?.prompt : args?.message)
        ?? (typeof part.args === "string" ? nonEmptyText(part.args) : undefined);
      if (receipt !== undefined) {
        // Without an addressed id, an unpaired launch has no group to show in.
        if (id === undefined && claims.get(receipt.jobId) !== 1) continue;
        calls.push({ ...base, tool: part.toolName, family: "agent", action: brief ? "brief" : "message",
          ...unique(receipt.jobId),
          ...(id === undefined ? {} : { instanceId: id }),
          ...(text === undefined ? {} : { text }),
          ...(!brief && args?.close === true ? { closes: true } : {}) });
        continue;
      }
      if (id === undefined) continue;
      // A call asked to detach but brought back no receipt started nothing.
      const turnInConversation = args?.background === true ? {} : foregroundTurn;
      if (brief) {
        // Only a persistent child named by the call can be placed.
        if (text !== undefined && args?.persist === true) {
          calls.push({ ...base, ...turnInConversation, tool: "Agent", family: "agent", instanceId: id, action: "brief", text });
        }
        continue;
      }
      const steer = nonEmptyText(args?.steer);
      if (steer !== undefined) {
        calls.push({ ...base, tool: part.toolName, family: "agent", instanceId: id, action: "steer", text: steer,
          ...controlReceipt(part.result, id, STEER_OUTCOMES) });
      } else if (args?.stop === true) {
        calls.push({ ...base, tool: part.toolName, family: "agent", instanceId: id, action: "stop",
          ...controlReceipt(part.result, id, STOP_OUTCOMES) });
      } else if (text !== undefined) {
        calls.push({ ...base, ...turnInConversation, tool: part.toolName, family: "agent", instanceId: id, action: "message", text,
          ...(args?.close === true ? { closes: true } : {}),
          ...(args?.close === true && args.background !== true && part.status === "complete" && confirmsClosed(part.result, id, false) ? { closed: true } : {}) });
      } else if (args?.close === true) {
        calls.push({ ...base, tool: part.toolName, family: "agent", instanceId: id, action: "close",
          ...(part.status === "complete" && confirmsClosed(part.result, id, true) ? { closed: true } : {}) });
      }
      continue;
    }

    if (isPeerAgentToolName(part.toolName)) {
      const peer = nonEmptyText(args?.peer);
      if (peer === undefined) continue;
      const thread = nonEmptyText(args?.thread);
      const started = unique(peerJobByCall.get(part));
      // Only a call confirmed to run in the conversation says how it ended there.
      const inConversation = peerModes.get(part) === "foreground" ? foregroundTurn : {};
      const peerCall = { ...base, tool: "PeerAgent", family: "peer" as const, instanceId: peer, ...(thread === undefined ? {} : { thread }) };
      if (args?.action === "send") {
        const text = nonEmptyText(args.message);
        calls.push({ ...peerCall, ...inConversation, action: "message", ...(text === undefined ? {} : { text }), ...started });
      } else if (args?.action === "answer") {
        const text = peerAnswerText(args.answers);
        calls.push({ ...peerCall, ...inConversation, action: "answer", ...(text === undefined ? {} : { text }), ...started });
      } else if (args?.action === "decline") {
        calls.push({ ...peerCall, ...inConversation, action: "decline", ...started });
      } else if (args?.action === "stop") {
        calls.push({ ...peerCall, action: "stop" });
      }
    }
  }
  return calls;
};

export const isContextCompactionPart = (
  part: Extract<MessagePart, { type: "telemetry" }>,
): boolean => {
  if (part.event === "context_compaction") return true;
  let current = part.data;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || seen.has(current)) {
      return false;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.kind === "context_compaction" || record.type === "context_compaction") return true;
    current = record.data;
  }
  return false;
};

export const isAssistantMessageBoundaryPart = (
  part: Extract<MessagePart, { type: "telemetry" }>,
): boolean => {
  let current = part.data;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || seen.has(current)) {
      return false;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    // context_usage was the only reliable message-end marker retained by older
    // Pi runs. Keep it as a read-time compatibility boundary; new runs carry
    // the explicit content-free marker even when usage is unavailable.
    if (record.kind === "assistant_message_boundary" || record.kind === "context_usage") return true;
    current = record.data;
  }
  return false;
};

const partHasTranscriptPresentation = (part: MessagePart): boolean => {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text.trim().length > 0;
    case "telemetry":
      return part.event === "cron_run" || isContextCompactionPart(part);
    case "process-job":
      return false;
    case "process-job-wake":
    case "scheduled-wake":
      return true;
    case "steer":
      return true;
    case "conversation-marker":
    case "cron-reply-context":
      return true;
    case "tool-call":
    case "subagent":
    case "error":
    case "attachment":
    case "mcp_app":
    case "restart_proposal":
    case "failure":
      return true;
  }
};

const messageHasTranscriptPresentation = (message: WebMessage): boolean => {
  if (message.role !== "assistant") return true;
  if (message.attachments.length > 0) return true;
  if (message.status === "failed" || message.status === "interrupted") {
    return true;
  }
  if (shouldShowMessageRunAttribution(message.attribution, message.status)) return true;
  return message.parts.some(partHasTranscriptPresentation);
};

const nonEmptyResponse = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value : undefined;

/**
 * Drop the standalone bubble of an applied steer while its inline marker is
 * loaded. Presentation-only: the rows, the search index, counts and quotes
 * keep resolving the user message. When the marker's assistant message is
 * paged out the standalone bubble stays, so the transcript degrades to
 * today's rendering rather than a hole. Marker presence alone decides: the
 * marker exists only for an applied steer, and the user row's `applied` flip
 * can arrive one write after the marker without briefly showing both.
 */
export const suppressInlineSteers = (
  messages: readonly WebMessage[],
): readonly WebMessage[] => {
  const steeredMessageIds = new Set(messages.flatMap((message) => message.parts.flatMap((part) =>
    part.type === "steer" ? [part.messageId] : [])));
  if (steeredMessageIds.size === 0) return messages;
  return messages.filter(
    (message) => message.role !== "user" || !steeredMessageIds.has(message.id),
  );
};

/**
 * A follow-up sent into a running turn is stored INSIDE that turn, and the
 * store orders every turn-bound user row before that turn's assistant row. So
 * the composer shows the new bubble at the bottom of the transcript, where it
 * was written, and the reconciled list then jumps it up to sit under the
 * message that opened the turn — above all the work it is steering, which
 * reads as if the operator had said it first.
 *
 * Keep it where it was sent: after the last loaded message of the turn it is
 * aimed at, which is the bottom of the transcript exactly while that turn is
 * the running one. Applied steers are rendered in place by their inline marker
 * instead (see {@link suppressInlineSteers}); the bubble that survives here is
 * the one still waiting, or one whose marker is not loaded, and it holds this
 * same position through every status change rather than jumping again.
 *
 * A live input whose turn has no other loaded message — paged out, or an
 * unparented row — keeps its server position, so the transcript degrades to
 * today's rendering rather than to a bubble floated somewhere arbitrary.
 */
export const orderLiveInputsAfterTheirTurn = (
  messages: readonly WebMessage[],
): readonly WebMessage[] => {
  /** The turn a still-standalone follow-up bubble belongs below, if any. */
  const steeredTurnId = (message: WebMessage): string | undefined =>
    message.role === "user" && message.liveInputStatus !== undefined ? message.turnId : undefined;
  if (!messages.some((message) => steeredTurnId(message) !== undefined)) return messages;

  const anchorByTurn = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.turnId === undefined || steeredTurnId(message) !== undefined) return;
    anchorByTurn.set(message.turnId, index);
  });

  const anchored = new Map<number, WebMessage[]>();
  const moved = new Set<string>();
  for (const message of messages) {
    const turnId = steeredTurnId(message);
    if (turnId === undefined) continue;
    const anchor = anchorByTurn.get(turnId);
    if (anchor === undefined) continue;
    anchored.set(anchor, [...(anchored.get(anchor) ?? []), message]);
    moved.add(message.id);
  }
  if (anchored.size === 0) return messages;

  const ordered: WebMessage[] = [];
  messages.forEach((message, index) => {
    if (!moved.has(message.id)) ordered.push(message);
    for (const live of anchored.get(index) ?? []) ordered.push(live);
  });
  return ordered;
};

/**
 * Split the currently loaded conversation into assistant-ui messages and one
 * stable chronological set of background jobs.
 */
export const projectProcessJobPresentation = (
  messages: readonly WebMessage[],
  options: { readonly threadId?: string | null } = {},
): ProcessJobPresentation => {
  // The inline steer duplicates its user message; shape the transcript without
  // the duplicate before cards, events and visibility are derived from it, and
  // leave every surviving follow-up bubble below the turn it was sent into.
  const shaped = orderLiveInputsAfterTheirTurn(suppressInlineSteers(messages));
  const projectedMessages: WebMessage[] = [];
  const jobs: ProcessJobPresentationEntry[] = [];
  const jobIndexes = new Map<string, number>();
  const receiptCandidates = new Map<string, Map<string, {
    readonly messageId: string;
    readonly toolCallId: string;
    readonly receipt: ProcessJobStartReceipt;
  }>>();
  const ambiguousReceipts = new Set<string>();
  const wakeJobIds = new Set(shaped.flatMap((message) => message.parts.flatMap((part) =>
    part.type === "process-job-wake" ? [part.jobId] : [])));

  if (options.threadId !== undefined && options.threadId !== null) {
    for (const message of shaped) {
      if (message.role !== "assistant" || message.threadId !== options.threadId) continue;
      for (const part of message.parts) {
        if (part.type !== "tool-call") continue;
        const receipt = parseProcessJobStartReceipt(part.structuredResult, part.toolName);
        if (receipt === undefined) continue;
        const key = `${message.id}\0${part.toolCallId}\0${receipt.jobId}`;
        const candidates = receiptCandidates.get(receipt.jobId) ?? new Map();
        const existing = candidates.get(key);
        if (existing !== undefined && JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) {
          ambiguousReceipts.add(receipt.jobId);
        } else if (existing === undefined) {
          candidates.set(key, { messageId: message.id, toolCallId: part.toolCallId, receipt });
          receiptCandidates.set(receipt.jobId, candidates);
        }
      }
    }
  }

  for (const message of shaped) {
    let containedJob = false;
    const remainingParts: MessagePart[] = [];

    for (const part of message.parts) {
      if (part.type !== "process-job") {
        remainingParts.push(part);
        continue;
      }
      containedJob = true;
      const existingIndex = jobIndexes.get(part.job.jobId);
      if (existingIndex === undefined) {
        jobIndexes.set(part.job.jobId, jobs.length);
        jobs.push({ messageId: message.id, part });
        continue;
      }

      const existing = jobs[existingIndex]!;
      const job = mergeProcessJobProjection(existing.part.job, part.job);
      const responseText = nonEmptyResponse(part.responseText)
        ?? nonEmptyResponse(existing.part.responseText);
      jobs[existingIndex] = {
        ...existing,
        part: {
          type: "process-job",
          job,
          ...(responseText === undefined ? {} : { responseText }),
        },
      };
    }

    if (!containedJob) {
      projectedMessages.push(message);
      continue;
    }

    const projected = { ...message, parts: remainingParts };
    if (messageHasTranscriptPresentation(projected)) {
      projectedMessages.push(projected);
    }
  }

  const eventsByMessageId = new Map<string, ProcessJobActivityEvent[]>();
  if (options.threadId !== undefined && options.threadId !== null) {
    for (const { part } of jobs) {
      const job = part.job;
      const candidates = receiptCandidates.get(job.jobId);
      if (ambiguousReceipts.has(job.jobId)
        || candidates === undefined
        || candidates.size !== 1
        || processJobThreadId(job) !== options.threadId) continue;
      const candidate = [...candidates.values()][0]!;
      if (candidate.receipt.tool !== job.tool) continue;

      const receiptStart = candidate.receipt.startedAt;
      const projectionStart = job.timestamps.startedAt;
      const startConflicts = receiptStart !== null && projectionStart !== null && receiptStart !== projectionStart;
      const startedAt = startConflicts ? undefined : receiptStart ?? projectionStart ?? undefined;
      const admittedAtMs = Date.parse(job.timestamps.admittedAt);
      const validStartedAt = startedAt !== undefined
        && canonicalIsoTimestamp(startedAt)
        && Date.parse(startedAt) >= admittedAtMs
        ? startedAt
        : undefined;
      const events: ProcessJobActivityEvent[] = [];
      if (validStartedAt !== undefined) {
        events.push({
          schema: "mono-agent.process-job-activity-event.v1",
          id: `process-job:${job.jobId}:started`,
          toolCallId: candidate.toolCallId,
          jobId: job.jobId,
          tool: job.tool,
          summary: job.summary,
          phase: "started",
          state: job.state,
          occurredAt: validStartedAt,
        });
      }
      if (TERMINAL_PROCESS_JOB_STATES.has(job.state) && !wakeJobIds.has(job.jobId)) {
        const completedAt = job.timestamps.completedAt;
        const completedAtMs = completedAt === null ? Number.NaN : Date.parse(completedAt);
        const validCompletedAt = completedAt !== null
          && canonicalIsoTimestamp(completedAt)
          && completedAtMs >= admittedAtMs
          && (validStartedAt === undefined || completedAtMs >= Date.parse(validStartedAt))
          ? completedAt
          : undefined;
        events.push({
          ...processJobTerminalEvent({
            ...job,
            timestamps: { ...job.timestamps, completedAt: validCompletedAt ?? null },
          }, candidate.toolCallId),
        });
      }
      if (events.length > 0) {
        const current = eventsByMessageId.get(candidate.messageId) ?? [];
        current.push(...events);
        eventsByMessageId.set(candidate.messageId, current);
      }
    }
  }

  return {
    messages: projectedMessages,
    jobs,
    eventsByMessageId,
    jobsById: new Map(jobs.map(({ part }) => [part.job.jobId, part.job])),
    parentCalls: options.threadId === undefined || options.threadId === null
      ? []
      : collectProcessJobParentCalls(shaped, options.threadId),
  };
};

interface ProcessJobPresentationContextValue {
  readonly threadId: string | null;
  readonly messages: readonly WebMessage[];
  readonly jobs: readonly ProcessJobPresentationEntry[];
  /** The parent's calls to its detached children; they head each agent group's timeline rows. */
  readonly parentCalls: readonly ProcessJobParentCall[];
  readonly historyIsBounded: boolean;
  readonly historyOpen: boolean;
  readonly setHistoryOpen: (open: boolean) => void;
  /** Whether the jobs shelf is open for this thread; closed until the operator opens it. */
  readonly shelfOpen: boolean;
  readonly setShelfOpen: (open: boolean) => void;
}

const EMPTY_PRESENTATION: ProcessJobPresentationContextValue = {
  threadId: null,
  messages: [],
  jobs: [],
  parentCalls: [],
  historyIsBounded: false,
  historyOpen: false,
  setHistoryOpen: () => undefined,
  shelfOpen: false,
  setShelfOpen: () => undefined,
};

const NO_PARENT_CALLS: readonly ProcessJobParentCall[] = [];

const ProcessJobPresentationContext = createContext<ProcessJobPresentationContextValue>(EMPTY_PRESENTATION);

export function ProcessJobPresentationProvider({
  children,
  threadId,
  messages,
  jobs,
  parentCalls = NO_PARENT_CALLS,
  historyIsBounded,
}: Pick<ProcessJobPresentation, "messages" | "jobs"> & {
  readonly children: ReactNode;
  readonly threadId: string | null;
  readonly historyIsBounded: boolean;
  readonly parentCalls?: readonly ProcessJobParentCall[];
}) {
  // This provider sits above Chat's thread-keyed viewport. Only these two
  // disclosure preferences (the shelf and its history) survive A -> B -> A;
  // every card and poller still remounts with the selected viewport and
  // therefore keeps thread/job lifecycle isolation.
  const [disclosures, setDisclosures] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const [shelves, setShelves] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const historyOpen = threadId === null ? false : disclosures.get(threadId) ?? false;
  const shelfOpen = threadId === null ? false : shelves.get(threadId) ?? false;

  const setHistoryOpen = useCallback((open: boolean) => {
    if (threadId === null) return;
    setDisclosures((current) => {
      const next = new Map(current);
      next.set(threadId, open);
      return next;
    });
  }, [threadId]);

  const setShelfOpen = useCallback((open: boolean) => {
    if (threadId === null) return;
    setShelves((current) => {
      const next = new Map(current);
      next.set(threadId, open);
      return next;
    });
  }, [threadId]);

  const value = useMemo<ProcessJobPresentationContextValue>(() => ({
    threadId,
    messages,
    jobs,
    parentCalls,
    historyIsBounded,
    historyOpen,
    setHistoryOpen,
    shelfOpen,
    setShelfOpen,
  }), [historyIsBounded, historyOpen, jobs, messages, parentCalls, setHistoryOpen, setShelfOpen, shelfOpen, threadId]);

  return (
    <ProcessJobPresentationContext.Provider value={value}>
      {children}
    </ProcessJobPresentationContext.Provider>
  );
}

export const useProcessJobPresentation = (): ProcessJobPresentationContextValue =>
  useContext(ProcessJobPresentationContext);
