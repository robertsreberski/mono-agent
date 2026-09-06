import { isChannelUserCancelReason, type AgentMessageSender } from "@mono-agent/agent-contracts";
import type { RuntimeEventLike } from "@mono-agent/observability";
import type {
  RuntimeToolLifecycleEvent,
  RuntimeToolLifecyclePersistence,
  RuntimeToolLifecycleSink,
  RuntimeToolLifecycleTerminalState,
} from "@mono-agent/runtime-adapter";
import { types as nodeUtilTypes } from "node:util";

import type { HistoryMessage } from "../context/index.js";
import type { AppliedLiveInput } from "../live-input.js";
import {
  boundedToolHistoryPayload,
  TOOL_HISTORY_ARGUMENT_MAX_BYTES,
  TOOL_HISTORY_RESULT_MAX_BYTES,
  utf8Prefix,
} from "../tool-history-payload.js";
import { senderLabel } from "./speaker-context.js";

export const CANCELLED_TURN_HISTORY_KEY_PREFIX = "cancelled-turn:v1:";
export const CANCELLED_TURN_MAX_BYTES = 48 * 1024;
export const CANCELLED_TURN_ASSISTANT_MAX_BYTES = 8 * 1024;

const CANCELLED_TURN_DATA_OPEN = "<cancelled_turn_data>";
const CANCELLED_TURN_DATA_CLOSE = "</cancelled_turn_data>";
const LIFECYCLE_REJECTED_AFTER_SEAL = "cancelled_turn_sealed";
const ID_MAX_BYTES = 512;
const DETAIL_MAX_BYTES = 1_024;
const LIVE_INPUT_MAX_BYTES = 4 * 1024;
const MAX_IN_FLIGHT_DETAILS = 64;

export interface CancelledTurnReason {
  readonly failureKind: "cancelled" | "cancelled_user";
  readonly code: string;
  readonly notice: string;
  readonly channel?: string;
  readonly detail?: string;
}

interface CapturedToolCall {
  readonly toolCallId: string;
  toolName: string;
  invocation?: {
    readonly arguments: unknown;
    readonly truncated: boolean;
    persistence?: RuntimeToolLifecyclePersistence;
  };
  result?: {
    readonly content: unknown;
    readonly state: RuntimeToolLifecycleTerminalState;
    readonly failureKind?: string;
    readonly detailCode?: string;
    readonly executionMs?: number;
    readonly truncated: boolean;
    persistence?: RuntimeToolLifecyclePersistence;
  };
}

interface CancelledTurnEnvelope {
  readonly version: 1;
  readonly type: "cancelled_turn";
  readonly runId: string;
  readonly cancelledAt: string;
  readonly reason: CancelledTurnReason;
  readonly partialAssistant?: {
    readonly text: string;
    readonly truncated: boolean;
  };
  readonly completedTools: readonly CancelledToolPair[];
  readonly inFlightTools: readonly InFlightTool[];
  readonly appliedLiveInputs: readonly CancelledLiveInput[];
  readonly omissions: {
    readonly completedTools: number;
    readonly inFlightTools: number;
    readonly appliedLiveInputs: number;
  };
}

interface CancelledToolPair {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly result: unknown;
  readonly state: string;
  readonly failureKind?: string;
  readonly detailCode?: string;
  readonly executionMs?: number;
  readonly recordIds: {
    readonly invocation?: string;
    readonly result?: string;
  };
  readonly persistence: {
    readonly invocation: "persisted" | "failed" | "unavailable";
    readonly result: "persisted" | "failed" | "unavailable";
  };
  readonly truncated: boolean;
}

interface InFlightTool {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly invocationRecordId?: string;
  readonly state: "in_flight_at_cancellation";
  readonly outcome: "unconfirmed";
}

interface CancelledLiveInput {
  readonly id: string;
  readonly text: string;
  readonly receivedAt: string;
}

export class CancelledTurnCollector {
  private sealed = false;
  private partialAssistant = "";
  private readonly calls = new Map<string, CapturedToolCall>();
  private readonly pendingLifecycleWrites = new Set<Promise<unknown>>();

  observeRuntimeEvent(event: RuntimeEventLike): boolean {
    if (this.sealed) return false;
    if (event.type !== "assistant") return true;
    const message = dataRecord(event.message);
    if (message === undefined || !Array.isArray(message.content)) return true;
    for (const rawBlock of message.content) {
      const block = dataRecord(rawBlock);
      if (block?.type === "text" && typeof block.text === "string") {
        this.partialAssistant += block.text;
      }
    }
    return true;
  }

  wrapToolLifecycleSink(delegate: RuntimeToolLifecycleSink | undefined): RuntimeToolLifecycleSink {
    return async (event) => {
      if (this.sealed) {
        return { persistence: "failed", errorCode: LIFECYCLE_REJECTED_AFTER_SEAL };
      }
      const call = this.observeToolLifecycle(event);
      const write = delegate?.(event) ?? Promise.resolve(undefined);
      this.pendingLifecycleWrites.add(write);
      try {
        const persistence = await write;
        if (persistence !== undefined && event.phase === "invocation" && call.invocation !== undefined) {
          call.invocation.persistence = persistence;
        } else if (persistence !== undefined && event.phase === "result" && call.result !== undefined) {
          call.result.persistence = persistence;
        }
        return persistence;
      } finally {
        this.pendingLifecycleWrites.delete(write);
      }
    };
  }

  seal(): void {
    this.sealed = true;
  }

  async settleAcceptedLifecycleWrites(): Promise<void> {
    await Promise.allSettled([...this.pendingLifecycleWrites]);
  }

  buildMessages(input: {
    readonly runId: string;
    readonly userMessage: string;
    readonly liveInputs: readonly AppliedLiveInput[];
    readonly sender?: AgentMessageSender;
    readonly reason: CancelledTurnReason;
    readonly cancelledAt: string;
  }): readonly HistoryMessage[] {
    if (!this.sealed) throw new Error("Cancelled turn must be sealed before history is built.");
    const content = this.buildContent(input.runId, input.cancelledAt, input.reason, input.liveInputs);
    const name = senderLabel(input.sender);
    return [
      {
        role: "user",
        content: input.userMessage,
        timestamp: input.cancelledAt,
        runId: input.runId,
        ...(name === undefined ? {} : { name }),
      },
      {
        role: "assistant",
        content,
        timestamp: input.cancelledAt,
        runId: input.runId,
        idempotencyKey: `${CANCELLED_TURN_HISTORY_KEY_PREFIX}${input.runId}`,
      },
    ];
  }

  private observeToolLifecycle(event: RuntimeToolLifecycleEvent): CapturedToolCall {
    const toolCallId = boundedText(event.toolCallId, ID_MAX_BYTES);
    let call = this.calls.get(event.toolCallId);
    if (call === undefined) {
      call = {
        toolCallId,
        toolName: boundedText(event.phase === "invocation" ? event.toolName : event.toolName ?? "unknown_tool", ID_MAX_BYTES),
      };
      this.calls.set(event.toolCallId, call);
    }
    if (event.phase === "invocation") {
      const payload = boundedToolHistoryPayload(event.arguments ?? null, TOOL_HISTORY_ARGUMENT_MAX_BYTES);
      call.toolName = boundedText(event.toolName, ID_MAX_BYTES);
      call.invocation = {
        arguments: parseBoundedJson(payload.json),
        truncated: payload.truncated,
      };
    } else {
      const payload = boundedToolHistoryPayload(event.content ?? null, TOOL_HISTORY_RESULT_MAX_BYTES);
      if (call.invocation === undefined) {
        const synthetic = boundedToolHistoryPayload(
          { synthetic: true, reason: "result_observed_before_invocation" },
          TOOL_HISTORY_ARGUMENT_MAX_BYTES,
        );
        call.invocation = {
          arguments: parseBoundedJson(synthetic.json),
          truncated: synthetic.truncated,
        };
      }
      if (event.toolName !== undefined) call.toolName = boundedText(event.toolName, ID_MAX_BYTES);
      call.result = {
        content: parseBoundedJson(payload.json),
        state: event.state,
        ...(event.failureKind === undefined ? {} : { failureKind: boundedText(event.failureKind, ID_MAX_BYTES) }),
        ...(event.detailCode === undefined ? {} : { detailCode: boundedText(event.detailCode, ID_MAX_BYTES) }),
        ...(event.executionMs === undefined ? {} : { executionMs: event.executionMs }),
        truncated: payload.truncated,
      };
    }
    return call;
  }

  private buildContent(
    runId: string,
    cancelledAt: string,
    reason: CancelledTurnReason,
    liveInputs: readonly AppliedLiveInput[],
  ): string {
    const assistantPayload = boundedToolHistoryPayload(
      this.partialAssistant,
      CANCELLED_TURN_ASSISTANT_MAX_BYTES,
      { maxStringBytes: CANCELLED_TURN_ASSISTANT_MAX_BYTES },
    );
    const assistantText = boundedPayloadString(assistantPayload.json);
    const partialAssistant = this.partialAssistant.length === 0
      ? undefined
      : {
        text: assistantText,
        truncated: assistantPayload.truncated,
      };
    const completed = [...this.calls.values()]
      .filter((call): call is CapturedToolCall & Required<Pick<CapturedToolCall, "invocation" | "result">> =>
        call.invocation !== undefined && call.result !== undefined)
      .map(toolPair);
    const inFlightAll = [...this.calls.values()]
      .filter((call) => call.invocation !== undefined && call.result === undefined)
      .map(inFlightTool);
    const humanLiveInputs = liveInputs.filter((input) => !input.deliveryKey?.startsWith("monitor:"));
    const retainedInFlight = inFlightAll.slice(-MAX_IN_FLIGHT_DETAILS);
    const retainedLiveInputs = humanLiveInputs.slice(-MAX_IN_FLIGHT_DETAILS).map(liveInput);
    let envelope: CancelledTurnEnvelope = {
      version: 1,
      type: "cancelled_turn",
      runId,
      cancelledAt,
      reason,
      ...(partialAssistant === undefined ? {} : { partialAssistant }),
      completedTools: [],
      inFlightTools: retainedInFlight,
      appliedLiveInputs: retainedLiveInputs,
      omissions: {
        completedTools: completed.length,
        inFlightTools: inFlightAll.length - retainedInFlight.length,
        appliedLiveInputs: humanLiveInputs.length - retainedLiveInputs.length,
      },
    };
    envelope = fitNonToolDetails(envelope);
    const selectedNewestFirst: CancelledToolPair[] = [];
    for (const pair of completed.slice().reverse()) {
      const candidateNewestFirst = [...selectedNewestFirst, pair];
      const candidate = candidateNewestFirst.slice().reverse();
      const next: CancelledTurnEnvelope = {
        ...envelope,
        completedTools: candidate,
        omissions: { ...envelope.omissions, completedTools: completed.length - candidate.length },
      };
      if (contentBytes(renderContent(reason.notice, next)) > CANCELLED_TURN_MAX_BYTES) break;
      selectedNewestFirst.push(pair);
    }
    const selected = selectedNewestFirst.slice().reverse();
    envelope = {
      ...envelope,
      completedTools: selected,
      omissions: { ...envelope.omissions, completedTools: completed.length - selected.length },
    };
    const content = renderContent(reason.notice, envelope);
    if (contentBytes(content) > CANCELLED_TURN_MAX_BYTES) {
      throw new Error("Cancelled turn history exceeded its UTF-8 byte limit.");
    }
    return content;
  }
}

export function cancelledTurnReason(
  rawReason: unknown,
  failureKind: "cancelled" | "cancelled_user",
): CancelledTurnReason {
  if (isChannelUserCancelReason(rawReason)) {
    const channel = ownDataString(rawReason, "channel");
    return {
      failureKind,
      code: "operator",
      notice: "Run stopped by the operator.",
      ...(channel === undefined ? {} : { channel: boundedText(channel, ID_MAX_BYTES) }),
    };
  }

  const rawCode = firstOwnDataString(rawReason, ["cancelInitiator", "code", "kind", "name"]);
  const directCode = rawCode === undefined ? undefined : boundedText(rawCode, ID_MAX_BYTES);
  const rawDetail = firstOwnDataString(rawReason, ["message", "reason", "detail"])
    ?? (typeof rawReason === "string" ? rawReason : undefined);
  const detail = rawDetail === undefined ? undefined : boundedText(rawDetail, DETAIL_MAX_BYTES);
  const normalized = `${directCode ?? ""} ${detail ?? ""}`.toLowerCase();
  if (/coordinator_shutdown|\bshutdown\b|is stopping|adapter stopped|service is stopping/u.test(normalized)) {
    return { failureKind, code: directCode ?? "shutdown", notice: "Run cancelled by agent shutdown.", ...(detail === undefined ? {} : { detail }) };
  }
  if (/stale_reconcile|stale[-_ ]session|\bstale\b/u.test(normalized)) {
    return { failureKind, code: directCode ?? "stale_reconcile", notice: "Run cancelled during stale-session reconciliation.", ...(detail === undefined ? {} : { detail }) };
  }
  if (/worker_signal|\bsig(?:term|int|quit|hup|kill)\b|process signal/u.test(normalized)) {
    return { failureKind, code: directCode ?? "worker_signal", notice: "Run cancelled by a process signal.", ...(detail === undefined ? {} : { detail }) };
  }
  if (/timeout|timed out|time limit/u.test(normalized)) {
    return { failureKind, code: directCode ?? "timeout", notice: "Run cancelled after a timeout.", ...(detail === undefined ? {} : { detail }) };
  }
  if (detail !== undefined && detail.trim().length > 0) {
    return { failureKind, code: directCode ?? "reason", notice: `Run cancelled: ${detail}`, detail };
  }
  return { failureKind, code: directCode ?? "unrecorded", notice: "Run cancelled; reason not recorded." };
}

export function representedCancellationToolRecordIds(
  history: readonly HistoryMessage[],
): ReadonlySet<string> {
  const represented = new Set<string>();
  for (const message of history) {
    if (!message.idempotencyKey?.startsWith(CANCELLED_TURN_HISTORY_KEY_PREFIX)) continue;
    const envelope = parseCancelledTurnEnvelope(message.content);
    if (envelope === undefined) continue;
    for (const rawTool of envelope.completedTools) {
      const tool = dataRecord(rawTool);
      const recordIds = dataRecord(tool?.recordIds);
      if (typeof recordIds?.invocation === "string") represented.add(recordIds.invocation);
      if (typeof recordIds?.result === "string") represented.add(recordIds.result);
    }
    for (const rawTool of envelope.inFlightTools) {
      const tool = dataRecord(rawTool);
      if (typeof tool?.invocationRecordId === "string") represented.add(tool.invocationRecordId);
    }
  }
  return represented;
}

function parseCancelledTurnEnvelope(content: string): CancelledTurnEnvelope | undefined {
  const start = content.indexOf(CANCELLED_TURN_DATA_OPEN);
  const end = content.indexOf(CANCELLED_TURN_DATA_CLOSE);
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(content.slice(start + CANCELLED_TURN_DATA_OPEN.length, end)) as unknown;
    const record = dataRecord(value);
    if (
      record?.version !== 1
      || record.type !== "cancelled_turn"
      || !Array.isArray(record.completedTools)
      || !Array.isArray(record.inFlightTools)
    ) return undefined;
    return value as CancelledTurnEnvelope;
  } catch {
    return undefined;
  }
}

function toolPair(
  call: CapturedToolCall & Required<Pick<CapturedToolCall, "invocation" | "result">>,
): CancelledToolPair {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    arguments: call.invocation.arguments,
    result: call.result.content,
    state: call.result.state,
    ...(call.result.failureKind === undefined ? {} : { failureKind: call.result.failureKind }),
    ...(call.result.detailCode === undefined ? {} : { detailCode: call.result.detailCode }),
    ...(call.result.executionMs === undefined ? {} : { executionMs: call.result.executionMs }),
    recordIds: {
      ...(call.invocation.persistence?.recordId === undefined ? {} : { invocation: call.invocation.persistence.recordId }),
      ...(call.result.persistence?.recordId === undefined ? {} : { result: call.result.persistence.recordId }),
    },
    persistence: {
      invocation: call.invocation.persistence?.persistence ?? "unavailable",
      result: call.result.persistence?.persistence ?? "unavailable",
    },
    truncated: call.invocation.truncated || call.result.truncated,
  };
}

function inFlightTool(call: CapturedToolCall): InFlightTool {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    ...(call.invocation?.persistence?.recordId === undefined ? {} : { invocationRecordId: call.invocation.persistence.recordId }),
    state: "in_flight_at_cancellation",
    outcome: "unconfirmed",
  };
}

function liveInput(input: AppliedLiveInput): CancelledLiveInput {
  return {
    id: boundedText(input.id, ID_MAX_BYTES),
    text: boundedText(input.text, LIVE_INPUT_MAX_BYTES),
    receivedAt: boundedText(input.receivedAt, ID_MAX_BYTES),
  };
}

function fitNonToolDetails(envelope: CancelledTurnEnvelope): CancelledTurnEnvelope {
  let current = envelope;
  while (contentBytes(renderContent(current.reason.notice, current)) > CANCELLED_TURN_MAX_BYTES) {
    if (current.appliedLiveInputs.length > 0) {
      current = {
        ...current,
        appliedLiveInputs: current.appliedLiveInputs.slice(1),
        omissions: { ...current.omissions, appliedLiveInputs: current.omissions.appliedLiveInputs + 1 },
      };
      continue;
    }
    if (current.inFlightTools.length > 0) {
      current = {
        ...current,
        inFlightTools: current.inFlightTools.slice(1),
        omissions: { ...current.omissions, inFlightTools: current.omissions.inFlightTools + 1 },
      };
      continue;
    }
    if (current.partialAssistant !== undefined) {
      const { partialAssistant: _omitted, ...withoutPartialAssistant } = current;
      current = withoutPartialAssistant;
      continue;
    }
    throw new Error("Cancelled turn metadata exceeded its UTF-8 byte limit.");
  }
  return current;
}

function renderContent(notice: string, envelope: CancelledTurnEnvelope): string {
  const unfinished = envelope.inFlightTools.length + envelope.omissions.inFlightTools;
  const warning = unfinished === 0
    ? "The following account contains only work observed before cancellation; do not present partial assistant output as a completed answer."
    : `${String(unfinished)} tool call${unfinished === 1 ? " was" : "s were"} in flight at cancellation; outcomes are unconfirmed and must not be assumed complete.`;
  return [
    '<cancelled_turn_history version="1">',
    `Host notice: ${notice} ${warning}`,
    CANCELLED_TURN_DATA_OPEN,
    JSON.stringify(envelope),
    CANCELLED_TURN_DATA_CLOSE,
    "</cancelled_turn_history>",
  ].join("\n");
}

function boundedText(value: string, maxBytes: number): string {
  const payload = boundedToolHistoryPayload(value, maxBytes);
  return utf8Prefix(boundedPayloadString(payload.json), maxBytes);
}

function boundedPayloadString(json: string): string {
  const parsed = parseBoundedJson(json);
  if (typeof parsed === "string") return parsed;
  const record = dataRecord(parsed);
  return typeof record?.preview === "string" ? record.preview : JSON.stringify(parsed);
}

function parseBoundedJson(value: string): unknown {
  try { return JSON.parse(value); }
  catch { return "[unserializable]"; }
}

function ownDataString(value: unknown, key: string): string | undefined {
  if (
    ((typeof value !== "object" || value === null) && typeof value !== "function")
    || nodeUtilTypes.isProxy(value)
  ) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function firstOwnDataString(value: unknown, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = ownDataString(value, key);
    if (candidate !== undefined && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return undefined;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function contentBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
