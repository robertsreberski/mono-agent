import { hasUpkeepTelemetry, messageUsageRollup } from "../../src/message-cost.js";
import { sumThreadUsage } from "../../src/thread-usage.js";
import { isLegacySilentCronMessage } from "./cron-visibility";
import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type CompleteAttachment,
  type ExternalThreadQueueAdapter,
  type QuoteInfo,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RecordedAudioContext } from "./recorded-audio-context";
import { loadRecordedDrafts, recordedStorageUnavailable, removeRecordedDraft, saveRecordedDraft, type RecordedDraft } from "./recorded-draft-store";
import { canRenewRecordedSubmission, recordedSubmissionOutcome, withRecordedSendLock } from "./recorded-send-guard";
import type { AttachmentSubmissionSession } from "./console-store";
import { RecordedSubmissionAttempt } from "./recorded-submission";
import { WebUploadAttachmentAdapter } from "./attachment-adapter";
import { ReplyAccessProvider } from "./components/reply-access";
import { shouldShowMessageRunAttribution } from "./components/RunAttribution";
import { RouteCapabilitiesProvider } from "./components/route-capabilities";
import { ToolCallRepairProvider } from "./components/tool-call-repair";
import { canSendInConsole, canUploadInConsole } from "./capabilities";
import { clusterToolCalls } from "./activity-clustering";
import { hasReadableThoughtContent } from "./components/assistant-ui/Reasoning";
import { useConsoleStore, useUploadLimits } from "./console-store";
import { noteComposerAttachments } from "./composer-draft";
import { runningManualCompaction } from "./manual-compaction";
import {
  isAssistantMessageBoundaryPart,
  isContextCompactionPart,
  processJobTerminalEvent,
  ProcessJobPresentationProvider,
  projectProcessJobPresentation,
  type ProcessJobActivityEvent,
} from "./process-job-presentation";
import type {
  MessagePart,
  ProcessJobProjection,
  ToolCall,
  ToolCallArtifact,
  WebAttachment,
  WebMessage,
  WebQuote,
} from "./types";

export { canSendInConsole, canUploadInConsole } from "./capabilities";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue };

interface ComposerRecovery {
  readonly id: number;
  readonly text: string;
  readonly attachments: readonly CompleteAttachment[];
  readonly quote?: WebQuote;
  readonly agentId: string | null;
  readonly threadId: string | null;
}

type SubmissionOptions = Parameters<ExternalThreadQueueAdapter["enqueue"]>[1];

const mergeComposerText = (recovered: string, current: string): string => {
  if (!recovered) return current;
  if (!current || current === recovered) return recovered;
  return `${recovered}\n\n${current}`;
};

const canRestoreRecovery = (
  recovery: ComposerRecovery,
  selection: { readonly agentId: string | null; readonly threadId: string | null },
): boolean =>
  recovery.agentId === selection.agentId &&
  recovery.threadId === selection.threadId;

const quoteFromMetadata = (value: unknown): WebQuote | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const quote = value as Partial<QuoteInfo>;
  return typeof quote.text === "string" && quote.text.trim().length > 0 &&
    typeof quote.messageId === "string" && quote.messageId.trim().length > 0
    ? { text: quote.text, messageId: quote.messageId }
    : undefined;
};

const jsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return value === undefined ? null : String(value);
};

const jsonObject = (value: unknown): JsonObject => {
  const normalized = jsonValue(value);
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    return normalized;
  }
  return value === undefined ? {} : { value: normalized };
};

type ConvertedPart = Exclude<ThreadMessageLike["content"], string>[number];

/**
 * Per-tool-call metadata the console renders but assistant-ui cannot type: the durable
 * history record, and a bounded machine-readable tool result. Both ride in the part's single
 * `artifact` slot, so they are wrapped rather than fighting over it. Returns undefined
 * when neither is present, keeping ordinary tool calls unchanged.
 */
const toolCallArtifact = (part: ToolCall): ToolCallArtifact | undefined => {
  const artifact: ToolCallArtifact = {
    ...(part.history === undefined ? {} : { history: part.history }),
    ...(part.structuredResult === undefined ? {} : { structuredResult: part.structuredResult }),
    ...(part.executionMs === undefined ? {} : { executionMs: part.executionMs }),
    // Whether the row is showing a preview rides here too: a row that cannot
    // say so would present 4 KB of a 20 KB result as the whole output.
    ...(part.resultTruncated === true ? { resultTruncated: true } : {}),
    ...(part.resultBytes === undefined ? {} : { resultBytes: part.resultBytes }),
    ...(part.argsTruncated === true ? { argsTruncated: true } : {}),
    ...(part.argsBytes === undefined ? {} : { argsBytes: part.argsBytes }),
  };
  return Object.keys(artifact).length === 0 ? undefined : artifact;
};

const convertPart = (
  part: MessagePart,
  processJobs?: ReadonlyMap<string, ProcessJobProjection>,
): ConvertedPart | null => {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning":
      return { type: "reasoning", text: part.text };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: jsonObject(part.args),
        // No `argsText`: assistant-ui derives it from `args` when it is absent
        // (`fromThreadMessageLike`), so supplying one only made the console hold
        // a second, pretty-printed copy of every tool call's arguments.
        result: part.result,
        isError: part.status === "failed",
        // assistant-ui's tool-call part types no slot for our own per-call metadata,
        // so `artifact` carries an envelope of it. Omitted entirely when empty so a
        // plain tool call stays byte-identical to what it was before.
        ...(toolCallArtifact(part) === undefined ? {} : { artifact: toolCallArtifact(part) }),
      };
    case "subagent":
      // A delegation owns its children, so it cannot be an assistant-ui
      // tool-call part (those carry no nested calls). A named data part keeps
      // the whole group intact and lets it render as one disclosure.
      return { type: "data-subagent", data: jsonObject(part) };
    case "process-job":
      return { type: "data-process-job", data: jsonObject(part) };
    case "scheduled-wake":
      return { type: "data-scheduled-wake", data: jsonObject(part) };
    case "process-job-wake": {
      const job = processJobs?.get(part.jobId);
      return job === undefined ? null : {
        type: "data-process-job-event",
        data: jsonObject(processJobTerminalEvent(job, part.deliveryKey)),
      };
    }
    case "conversation-marker":
      return { type: "data-conversation-marker", data: jsonObject(part) };
    case "steer":
      // A consumed steer renders as the operator's own message in place, so
      // it converts to a named data part that deliberately belongs to neither
      // the activity set nor the answer: it breaks the Activity band instead.
      return { type: "data-steer", data: jsonObject(part) };
    case "cron-reply-context":
      return { type: "data-cron-reply-context", data: jsonObject(part) };
    case "telemetry":
      // Most telemetry remains store-only for chrome such as ContextDisplay.
      // Only the cold-context downgrade is a visible warning note; every other
      // runtime warning stays store-only. Compaction also exposes its canonical
      // kind without leaking raw provider diagnostics into the transcript.
      if (part.event === "runtime_warning" && part.data !== null && typeof part.data === "object" && !Array.isArray(part.data)) {
        const warning = part.data as Record<string, unknown>;
        if (warning.warningKind === "degraded_native_context" && typeof warning.message === "string" && warning.message.trim().length > 0) {
          return { type: "data-note", data: { text: warning.message } };
        }
      }
      if (isContextCompactionPart(part)) {
        return { type: "data-context-compaction", data: jsonObject(part.data) };
      }
      if (isAssistantMessageBoundaryPart(part)) {
        return { type: "data-assistant-message-boundary", data: {} };
      }
      return part.event === "cron_run"
        ? { type: "data-cron-run", data: jsonObject(part.data) }
        : null;
    case "error":
      return { type: "data-error", data: { code: part.code, message: part.message } };
    case "attachment":
      return { type: "data-reply-attachment", data: jsonObject(part) };
    case "mcp_app":
      return { type: "data-mcp-app", data: jsonObject(part) };
    case "reply_options":
      return { type: "data-reply-options", data: jsonObject(part) };
    case "restart_proposal":
      return { type: "data-restart-proposal", data: jsonObject(part) };
    case "failure":
      return { type: "data-reply-failure", data: jsonObject(part) };
  }
};

const completeAttachment = (attachment: WebAttachment): CompleteAttachment => {
  // A guard, not a correction: the store already answers with exactly this path
  // for an uploaded attachment. It keeps the address a picture renders from out
  // of the payload's reach, because that address is the browser's cache key for
  // bytes the service marks immutable for a year — anything token-bearing or
  // off-origin arriving in an <img src> would turn every projection of the
  // message into a fresh download of bytes the browser already has.
  const storedUrl = `/api/v1/uploads/${encodeURIComponent(attachment.id)}/content`;
  const contentUrl = attachment.kind === "image" ? storedUrl : attachment.contentUrl ?? storedUrl;
  return {
    id: attachment.id,
    type: attachment.kind,
    name: attachment.name,
    contentType: attachment.contentType,
    status: { type: "complete" },
    content:
      attachment.kind === "image"
        ? [{ type: "image", image: contentUrl, filename: attachment.name }]
        : [
            {
              type: "file",
              data: contentUrl,
              mimeType: attachment.contentType,
              filename: attachment.name,
            },
          ],
  };
};

/**
 * Join runs of adjacent text into one part, because each one renders as its own
 * markdown root and would otherwise read as a paragraph break.
 *
 * Every message stored before the runtime stopped splitting text across
 * invisible telemetry carries those splits — frequently mid-word — and so does
 * every message stored before the store stopped splitting text across
 * thoughts, so this also repairs history rather than only protecting new
 * turns. Concatenation is verbatim: the parts were one continuous stream of
 * deltas.
 */
const joinAdjacentText = (parts: readonly ConvertedPart[], joinReasoning = false): ConvertedPart[] =>
  parts.reduce<ConvertedPart[]>((joined, part) => {
    if (part.type === "text") {
      let previousIndex = joined.length - 1;
      // Reasoning can split a single answer even mid-word. Joining pulls the
      // later text into the earlier part, so the reader sees the whole
      // sentence and then the thought row; every other visible part remains a
      // barrier.
      while (joinReasoning && joined[previousIndex]?.type === "reasoning") previousIndex -= 1;
      const previous = joined[previousIndex];
      if (previous?.type === "text") {
        joined[previousIndex] = { ...previous, text: `${previous.text}${part.text}` };
        return joined;
      }
    }
    joined.push(part);
    return joined;
  }, []);

/** The part types the transcript presents as activity rather than as the answer. */
const ACTIVITY_PART_TYPES: ReadonlySet<string> = new Set([
  "reasoning",
  "tool-call",
  "data-note",
  "data-subagent",
  "data-process-job",
  "data-process-job-event",
]);

const isBlankText = (part: ConvertedPart): boolean =>
  part.type === "text" && part.text.trim().length === 0;

/** A consumed steer, which splits settled activity instead of joining it. */
const isSteerPart = (part: ConvertedPart): boolean => part.type === "data-steer";

/**
 * Keep response prose and activity in source order, including after settlement.
 * Earlier text is still a response, not a thought or an activity note. The text
 * join above repairs split sentences without crossing tools or message boundaries.
 *
 * Only reply adornments move: choices, restart cards, files and errors retain
 * their existing placement below the last response text. Steers, scheduled wakes
 * and pre-answer compactions stay inline; manual after-answer compactions stay
 * below the reply. A turn without response text keeps its original order.
 */
const layoutSettledReply = (parts: readonly ConvertedPart[]): ConvertedPart[] => {
  const visible = parts.filter((part) => !isBlankText(part));
  let answerIndex = -1;
  visible.forEach((part, index) => {
    if (part.type === "text") answerIndex = index;
  });
  if (answerIndex < 0) return visible;

  const chronological: ConvertedPart[] = [];
  const afterAnswer: ConvertedPart[] = [];
  visible.forEach((part, index) => {
    if (part.type === "text" || ACTIVITY_PART_TYPES.has(part.type)
      || isSteerPart(part) || part.type === "data-scheduled-wake"
      || (part.type === "data-context-compaction" && index < answerIndex)) {
      chronological.push(part);
    } else {
      afterAnswer.push(part);
    }
  });
  // Answer actions belong beneath the reply, not in Activity or after files.
  const choices = afterAnswer.filter((part) => part.type === "data-reply-options");
  const proposals = afterAnswer.filter((part) => part.type === "data-restart-proposal");
  return [...chronological, ...choices, ...proposals,
    ...afterAnswer.filter((part) => part.type !== "data-restart-proposal" && part.type !== "data-reply-options")];
};

interface ConvertWebMessageOptions {
  readonly processJobEvents?: readonly ProcessJobActivityEvent[];
  readonly processJobs?: ReadonlyMap<string, ProcessJobProjection>;
  readonly compactionMarkerIds?: ReadonlySet<string>;
}

/**
 * Fold a background launch's arguments into the started row that replaces it.
 *
 * The started event is the single chronological anchor for the launch; the
 * launch tool-call row disappears with it, so its Input must move. Only the
 * preview the server shaped is carried — the row's repair control fetches the
 * whole body by the same toolCallId the tool row used.
 */
const withLaunchArgs = (
  event: ProcessJobActivityEvent,
  launch: ToolCall,
): ProcessJobActivityEvent => {
  if (event.phase !== "started" || launch.args === undefined) return event;
  return {
    ...event,
    launchArgs: jsonValue(launch.args),
    ...(launch.argsTruncated === true ? { launchArgsTruncated: true as const } : {}),
    ...(launch.argsBytes === undefined ? {} : { launchArgsBytes: launch.argsBytes }),
  };
};

/** Manual results use the after-answer marker; automatic results keep their inline telemetry. */
export const compactionMarkerIdsForMessages = (messages: readonly WebMessage[]): ReadonlySet<string> =>
  new Set(messages.flatMap((message) => message.parts.flatMap((part) =>
    part.type === "conversation-marker" && part.kind === "compaction" && part.trigger === "manual"
      ? [part.operationId] : [])));

const inlineCompactionId = (part: WebMessage["parts"][number]): string | undefined => {
  if (part.type !== "telemetry" || !isContextCompactionPart(part)) return undefined;
  const outer = part.data as { data?: unknown; operationId?: unknown; status?: unknown; trigger?: unknown } | undefined;
  const payload = outer?.data !== null && typeof outer?.data === "object"
    ? outer.data as { operationId?: unknown; status?: unknown; trigger?: unknown } : outer;
  return typeof payload?.operationId === "string" && payload.trigger !== "manual"
    && ["succeeded", "skipped", "failed"].includes(String(payload.status)) ? payload.operationId : undefined;
};

/** Drop only automatic rows whose terminal event is visible in a loaded assistant. */
export const visibleCompactionMessages = (messages: readonly WebMessage[]): readonly WebMessage[] => {
  const inline = new Set(messages.flatMap((message) => message.role === "assistant"
    ? message.parts.flatMap((part) => inlineCompactionId(part) ?? []) : []));
  if (inline.size === 0) return messages;
  return messages.filter((message) => !message.parts.some((part) =>
    part.type === "conversation-marker" && part.kind === "compaction"
    && part.trigger === "automatic" && inline.has(part.operationId)));
};

export const convertWebMessage = (
  message: WebMessage,
  options: ConvertWebMessageOptions = {},
): ThreadMessageLike => {
  const hasCronReplyContext = message.parts.some((part) => part.type === "cron-reply-context");
  const processJobEvents = new Map<string, readonly ProcessJobActivityEvent[]>();
  for (const event of options.processJobEvents ?? []) {
    const current = processJobEvents.get(event.toolCallId) ?? [];
    processJobEvents.set(event.toolCallId, [...current, event]);
  }
  const joined = joinAdjacentText(message.parts.flatMap((part) => {
    if (part.type === "telemetry" && isContextCompactionPart(part)) {
      const outer = part.data as { data?: { operationId?: unknown; status?: unknown } } | undefined;
      const { operationId, status } = outer?.data ?? {};
      if (status !== "running" && typeof operationId === "string" && options.compactionMarkerIds?.has(operationId)) return [];
    }
    if (part.type === "cron-reply-context") {
      const data = jsonObject(part);
      return [
        { type: "data-cron-reply-context" as const, data },
        { type: "text" as const, text: part.result.text },
        { type: "data-cron-reply-context-details" as const, data },
      ];
    }
    // A thought with no readable content — empty, whitespace, or only
    // punctuation/markdown decoration such as "." — is not a step. Dropping
    // it before the join keeps it out of the activity count and out of the
    // band, so it can neither render a "." row nor leave an empty card
    // behind. History needs no migration because every read converts again,
    // and a thought still streaming grows into the same stored part until it
    // reads as prose and appears normally.
    if (part.type === "reasoning" && !hasReadableThoughtContent(part.text)) return [];
    // The service worker precaches this bundle, so a console left open across a
    // server upgrade can be handed a part type it does not know yet. `== null`
    // covers that `undefined` too: pushing it into content breaks the whole
    // transcript over one unrecognized row.
    const convertedPart = convertPart(part.type === "telemetry" && part.event === "cron_run"
      ? { ...part, data: { ...(part.data as Record<string, unknown>), hasVisibleContent: !isLegacySilentCronMessage(message) } }
      : part, options.processJobs);
    if (convertedPart == null) return [];
    if (part.type !== "tool-call") return [convertedPart];
    const launchEvents = processJobEvents.get(part.toolCallId) ?? [];
    if (launchEvents.length === 0) return [convertedPart];
    // The started event is the established pairing's single anchor: the launch
    // call folds into it and its own row disappears. Anything without a started
    // event — a failed launch, a terminal-only fallback, an ambiguous receipt —
    // keeps the ordinary tool-call row so no launch evidence is lost.
    const foldsLaunch = part.status === "complete" && launchEvents.some((event) => event.phase === "started");
    if (!foldsLaunch) {
      return [
        convertedPart,
        ...launchEvents.map((event) => ({
          type: "data-process-job-event" as const,
          data: jsonObject(event),
        })),
      ];
    }
    return launchEvents.map((event) => ({
      type: "data-process-job-event" as const,
      data: jsonObject(event.phase === "started" ? withLaunchArgs(event, part) : event),
    }));
  }), message.role === "assistant" && !hasCronReplyContext);
  const converted = joined.filter((part) => part.type !== "data-assistant-message-boundary");
  // Preserve the same prose/activity chronology for live and completed turns.
  // Settlement only arranges reply adornments below the response.
  const ordered = message.role === "assistant" && message.status === "complete" && !hasCronReplyContext
    ? layoutSettledReply(converted)
    : converted;
  // Cluster only adjacent calls after laying out the reply; prose and visible
  // ordering barriers must continue to split the activity bands.
  const content = clusterToolCalls(ordered) as typeof ordered;
  const status: ThreadMessageLike["status"] =
    message.status === "running"
      ? { type: "running" }
      : message.status === "complete"
        ? { type: "complete", reason: "stop" }
        : message.status === "cancelled"
          ? { type: "incomplete", reason: "cancelled" }
          : message.status === "failed"
            ? { type: "incomplete", reason: "error", error: "Agent run failed" }
            : { type: "incomplete", reason: "other", error: "Agent run was interrupted" };
  const usage = message.role === "assistant" && hasUpkeepTelemetry(message.parts) ? messageUsageRollup(message) : undefined;
  return {
    id: message.id,
    role: message.role,
    // assistant-ui restricts system content to one text part. Keep the named
    // data projection on THIS row's metadata, not on a neighbouring message.
    content: message.role === "system" && content[0]?.type === "data-conversation-marker"
      ? [{ type: "text", text: "" }] : content,
    createdAt: new Date(message.createdAt),
    ...(message.role === "assistant" ? { status } : {}),
    attachments:
      message.role === "user" ? message.attachments.map(completeAttachment) : undefined,
    metadata: {
      custom: {
        ...(message.role === "system" && content[0]?.type === "data-conversation-marker"
          ? { conversationMarker: content[0] } : {}),
        ...(usage?.upkeep ? { upkeepUsage: sumThreadUsage([usage]) } : {}),
        turnId: message.turnId,
        threadId: message.threadId,
        updatedAt: message.updatedAt,
        ...(message.finishedAt === undefined ? {} : { finishedAt: message.finishedAt }),
        ...(message.liveInputStatus === undefined ? {} : { liveInputStatus: message.liveInputStatus }),
        ...(message.quote === undefined ? {} : { quote: message.quote }),
        ...(message.attribution === undefined ? {} : { attribution: message.attribution }),
        showRunAttribution: shouldShowMessageRunAttribution(message.attribution, message.status),
        runStatus: message.status,
      },
    },
  };
};

export function WebRuntimeProvider({ children }: { readonly children: ReactNode }) {
  const store = useConsoleStore();
  const limits = useUploadLimits();
  const [turnStarting, setTurnStarting] = useState(false);
  const [recoveries, setRecoveries] = useState<readonly ComposerRecovery[]>([]);
  const turnStartingRef = useRef(false);
  const recoveryIdRef = useRef(0);
  const selectionRef = useRef({
    agentId: store.selectedAgentId,
    threadId: store.selectedThreadId,
  });
  selectionRef.current = {
    agentId: store.selectedAgentId,
    threadId: store.selectedThreadId,
  };
  // An outbox can span bootstrap/limit refreshes. Replacing this adapter would
  // strand attempts holding its files and could delete their staged uploads.
  const [attachmentAdapter] = useState(() => new WebUploadAttachmentAdapter(limits));
  attachmentAdapter.updateLimits(limits);
  const attachmentContext = `${store.selectedAgentId ?? "none"}:${store.selectedThreadId ?? "new"}`;
  const previousAttachmentContext = useRef<string | null>(null);
  useEffect(() => {
    if (
      previousAttachmentContext.current !== null &&
      previousAttachmentContext.current !== attachmentContext
    ) {
      attachmentAdapter.disposeUnsent();
      noteComposerAttachments(false);
    }
    previousAttachmentContext.current = attachmentContext;
  }, [attachmentAdapter, attachmentContext]);
  useEffect(
    () => () => {
      // Frozen recorded recoveries also have durable device bytes. Do not
      // delete their staged server IDs during a provider unmount/reload.
      attachmentAdapter.disposeUnsent();
      noteComposerAttachments(false);
    },
    [attachmentAdapter],
  );

  const queueRecovery = useCallback(
    (
      text: string,
      attachments: readonly CompleteAttachment[],
      quote: WebQuote | undefined,
      context: { readonly agentId: string | null; readonly threadId: string | null },
    ) => {
      attachmentAdapter.retainForRecovery(attachments);
      setRecoveries((current) => [
        ...current,
        {
          id: ++recoveryIdRef.current,
          text,
          attachments,
          ...(quote === undefined ? {} : { quote }),
          ...context,
        },
      ]);
    },
    [attachmentAdapter],
  );

  type RecordedState = { saved?: boolean; memoryOnly?: boolean; attempt: RecordedSubmissionAttempt; agentId: string | null; busy: boolean; checking?: boolean; removed?: boolean; error?: string; uncertain: boolean };
  const recordedRef = useRef<RecordedState[]>([]);
  const [recordedStates, setRecordedStates] = useState<RecordedState[]>([]);
  const [recordedLoaded, setRecordedLoaded] = useState(false);
  const [recordedNotice, setRecordedNotice] = useState<string>();
  const memoryNotice = "Recording storage unavailable. Recordings stay in this window, but cannot be kept across reloads.";
  const otherWindow = "This recorded message is in progress in another window. Retry here after it finishes.";
  const publishRecorded = useCallback(() => setRecordedStates([...recordedRef.current]), []);
  const recordedState = recordedStates.find(state => state.agentId === store.selectedAgentId
    && state.attempt.threadId === store.selectedThreadId);
  const attemptFromDraft = useCallback((draft: RecordedDraft) => {
    attachmentAdapter.restoreFiles(draft.files.map(entry => ({ ...entry, file: new File([entry.file], entry.name, { type: entry.file.type }) })));
    let session: AttachmentSubmissionSession | undefined;
    const get = () => session ??= storeRef.current.captureAttachmentSubmission(draft.owner);
    const owner: AttachmentSubmissionSession = {
      submissionId: draft.owner.submissionId, snapshot: () => session?.snapshot() ?? draft.owner,
      isCurrent: () => true, prepare: signal => get().prepare(signal),
      assertCanSendAttachments: () => get().assertCanSendAttachments(), submit: (...args) => get().submit(...args),
    };
    const attempt = new RecordedSubmissionAttempt(owner, attachmentAdapter, { ...draft, threadId: draft.owner.threadId });
    attempt.restore(draft); return attempt;
  }, [attachmentAdapter]);
  const persistRecorded = async (state: RecordedState, draft: RecordedDraft) => {
    if (state.memoryOnly) return;
    try { await saveRecordedDraft(draft); state.saved = true; }
    catch (error) {
      // Never leave an older durable copy marked unsent while dispatching a
      // different in-memory payload. Fallback is safe only before any save.
      if (recordedStorageUnavailable(error) && !state.saved) { state.memoryOnly = true; setRecordedNotice(memoryNotice); }
      else throw error;
    }
  };
  const retireRecorded = async (state: RecordedState) => {
    if (state.saved) await removeRecordedDraft(state.attempt.owner.submissionId);
    recordedRef.current = recordedRef.current.filter(item => item !== state);
    attachmentAdapter.completeSend(state.attempt.attachments);
  };
  const replaceUnaccepted = async (state: RecordedState) => {
    const previous = state.attempt.snapshot();
    const draft = { ...previous, owner: { ...previous.owner, submissionId: crypto.randomUUID() }, dispatched: false, composed: undefined };
    if (state.saved) await saveRecordedDraft(draft, previous.owner.submissionId);
    state.attempt = attemptFromDraft(draft); state.uncertain = false;
  };
  const pendingSubmission = "Send is still in progress. Retry waits for the same request; no duplicate will be sent.";
  const markMemoryOnly = (state: RecordedState) => {
    state.saved = false; state.memoryOnly = true; setRecordedNotice(memoryNotice);
  };
  const adoptLatest = (state: RecordedState, latest: RecordedDraft) => {
    const local = state.attempt.snapshot();
    if (latest.dispatched !== local.dispatched || latest.composed !== local.composed || latest.owner.threadId !== local.owner.threadId
      || latest.attachments.map(item => item.id).join() !== local.attachments.map(item => item.id).join()) {
      attachmentAdapter.completeSend(state.attempt.attachments);
      state.attempt = attemptFromDraft(latest); state.uncertain = latest.dispatched;
    }
  };
  const runRecorded = async (state: RecordedState): Promise<void> => {
    if (state.attempt.submissionPending) { state.error = pendingSubmission; publishRecorded(); return; }
    if (state.busy || state.checking) return;
    state.busy = true; delete state.error; publishRecorded();
    try {
      const acquired = await withRecordedSendLock(state.attempt.owner.submissionId, async () => {
        let receiptChecked = false;
        if (state.saved) {
          const latest = (await loadRecordedDrafts()).find(draft => draft.owner.submissionId === state.attempt.owner.submissionId);
          // Absence may be OS eviction, not successful submission. Keep browser
          // bytes unless this dispatched identity has an accepted receipt.
          if (!latest) {
            if (state.attempt.dispatched) {
              receiptChecked = true;
              if (await recordedSubmissionOutcome(state.attempt.threadId, state.attempt.owner.submissionId) === "accepted") {
                state.saved = false; await retireRecorded(state); return;
              }
            }
            markMemoryOnly(state);
          } else adoptLatest(state, latest);
        }
        if (!receiptChecked && state.attempt.dispatched && await recordedSubmissionOutcome(state.attempt.threadId, state.attempt.owner.submissionId) === "accepted") {
          await retireRecorded(state); return;
        }
        try {
          await state.attempt.send(draft => persistRecorded(state, draft));
          await retireRecorded(state);
        } catch (failure) {
          let settledFailure = failure;
          if (state.attempt.submissionPending) {
            state.uncertain = true; state.busy = false; state.error = pendingSubmission; publishRecorded();
            // The wrapper deadline cannot release the cross-window lock while
            // the underlying HTTP submission is still capable of arriving.
            try {
              await state.attempt.waitForSubmission();
              if (!state.removed) await retireRecorded(state);
              return;
            } catch (underlyingFailure) {
              if (state.removed) return;
              settledFailure = underlyingFailure;
            }
            state.busy = true; publishRecorded();
          }
          if (state.attempt.dispatched) {
            if (canRenewRecordedSubmission(settledFailure, state.attempt.reposted)) {
              try { await replaceUnaccepted(state); }
              catch { /* Keep the old uncertain identity if atomic replacement fails. */ }
            } else if (await recordedSubmissionOutcome(state.attempt.threadId, state.attempt.owner.submissionId) === "accepted") {
              await retireRecorded(state); return;
            }
          }
          if (state.saved && !state.attempt.dispatched) {
            try { await saveRecordedDraft(state.attempt.snapshot()); }
            catch { /* The previous durable copy stays conservative and recoverable. */ }
          }
          state.uncertain = state.attempt.dispatched;
          state.error = state.uncertain ? "Send not confirmed. Retry checks the same message without sending a duplicate."
            : settledFailure instanceof DOMException && settledFailure.name === "AbortError" ? "Audio preparation interrupted. Your recording is kept. Retry to transcribe and send."
            : settledFailure instanceof Error ? settledFailure.message : "Audio preparation interrupted. Retry to transcribe and send again.";
          attachmentAdapter.retainForRecovery(state.attempt.attachments);
        }
      });
      if (!acquired) state.error = otherWindow;
    } catch (failure) {
      state.error = state.saved && recordedStorageUnavailable(failure)
        ? "Saved recording storage is unavailable. Sending is paused to avoid duplicates. Remove still clears this window's recovery."
        : failure instanceof Error ? failure.message : "Recording recovery unavailable. Retry or Remove.";
    } finally { state.busy = false; publishRecorded(); }
  };
  useEffect(() => {
    let active = true;
    void loadRecordedDrafts().then(drafts => {
      if (!active) return;
      const states: RecordedState[] = drafts.map(draft => ({ saved: true, attempt: attemptFromDraft(draft), agentId: draft.owner.sourceId,
        busy: false, checking: draft.dispatched, uncertain: draft.dispatched,
        error: draft.dispatched ? undefined : "Recording recovered on this device. Retry to send, or Remove." }));
      recordedRef.current.push(...states);
      // Reading bytes is the readiness boundary. Slow receipt checks belong only
      // to their own drafts, never to another conversation's new Send.
      setRecordedLoaded(true); publishRecorded();
      for (const state of states.filter(item => item.checking)) void (async () => {
        try {
          const acquired = await withRecordedSendLock(state.attempt.owner.submissionId, async () => {
            const latest = (await loadRecordedDrafts()).find(draft => draft.owner.submissionId === state.attempt.owner.submissionId);
            if (latest) adoptLatest(state, latest);
            if (state.attempt.dispatched && await recordedSubmissionOutcome(state.attempt.threadId, state.attempt.owner.submissionId) === "accepted") {
              if (!latest) state.saved = false;
              await retireRecorded(state);
            } else {
              if (!latest) markMemoryOnly(state);
              state.error = "Recording recovered on this device. Retry checks the same send, or Remove.";
            }
          });
          if (!acquired) state.error = otherWindow;
        } catch { state.error = "Could not reconcile the saved message. Retry to check its receipt, or Remove."; }
        finally { state.checking = false; if (active) publishRecorded(); }
      })();
    }).catch(error => {
      if (active) {
        setRecordedNotice(recordedStorageUnavailable(error) ? memoryNotice : "Saved recordings could not be read. Try reloading to recover them.");
        setRecordedLoaded(true);
      }
    });
    return () => { active = false; };
  }, [attemptFromDraft, publishRecorded]);
  const forgetRecorded = async (state: RecordedState, pending = false) => {
    state.removed = true;
    recordedRef.current = recordedRef.current.filter(item => item !== state);
    attachmentAdapter.completeSend(state.attempt.attachments); publishRecorded();
    if (pending) setRecordedNotice("Recovery removed from this window. The original send may still arrive.");
    if (state.saved) {
      try { await removeRecordedDraft(state.attempt.owner.submissionId); }
      catch { setRecordedNotice(`Recovery removed from this window. ${pending ? "The original send may still arrive. " : ""}Its saved copy could not be deleted and may return after reload.`); }
    }
  };
  const removeRecorded = async (state: RecordedState) => {
    if (state.attempt.submissionPending) {
      // This window already owns the send's lock. Forget local recovery without
      // releasing that lease or pretending to cancel the underlying request.
      await forgetRecorded(state, true); return;
    }
    if (state.busy || state.checking) return;
    state.busy = true; publishRecorded();
    try {
      const acquired = await withRecordedSendLock(state.attempt.owner.submissionId, () => forgetRecorded(state));
      if (!acquired) state.error = otherWindow;
    } catch { state.error = "Could not remove the saved recording. Retry Remove."; }
    finally { state.busy = false; publishRecorded(); }
  };

  const onNew = useCallback(
    async (message: AppendMessage, _options?: SubmissionOptions) => {
      const text = message.content
        .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
          part.type === "text",
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
      const attachments: readonly CompleteAttachment[] = message.attachments ?? [];
      const quote = quoteFromMetadata(message.metadata?.custom?.quote);
      if (!text && attachments.length === 0) return;

      const submissionContext = {
        agentId: store.selectedAgentId,
        threadId: store.selectedThreadId,
      };
      if (store.selectionLoading || store.selectionError !== null) {
        queueRecovery(text, attachments, quote, submissionContext);
        return;
      }
      const activeRecorded = recordedRef.current.find(state => state.agentId === submissionContext.agentId && state.attempt.threadId === submissionContext.threadId);
      if (activeRecorded && (activeRecorded.busy || attachments.some(item => activeRecorded.attempt.attachments.some(original => original.id === item.id)) || attachmentAdapter.hasRecordings(attachments))) {
        const original = activeRecorded.attempt;
        const duplicate = text === original.text && quote?.messageId === original.quote?.messageId && quote?.text === original.quote?.text
          && attachments.length === original.attachments.length && attachments.every((item, index) => item.id === original.attachments[index]?.id);
        if (!activeRecorded.busy && attachmentAdapter.hasRecordings(attachments)) {
          activeRecorded.error = "Retry or remove the pending recording before sending another recorded message.";
          publishRecorded();
        }
        if (!duplicate) {
          // A newer queued draft is recoverable, but never lend it files already
          // owned by the admitted attempt or merge an uncertain attempt into it.
          const admittedIds = new Set(original.attachments.map(({ id }) => id));
          queueRecovery(text, attachments.filter(({ id }) => !admittedIds.has(id)), quote, submissionContext);
        }
        return;
      }
      if (turnStartingRef.current) {
        queueRecovery(text, attachments, quote, submissionContext);
        return;
      }
      if (attachmentAdapter.hasRecordings(attachments)) {
        if (!recordedLoaded) { queueRecovery(text, attachments, quote, submissionContext); return; }
        const attempt = new RecordedSubmissionAttempt(store.captureAttachmentSubmission(), attachmentAdapter,
          { text, attachments, quote, threadId: store.selectedThreadId });
        attachmentAdapter.beginSend(attachments);
        const state = { attempt, agentId: store.selectedAgentId, busy: false, uncertain: false };
        recordedRef.current.push(state);
        void runRecorded(state);
        return;
      }
      // The ref closes the gap before React publishes isSendDisabled. This must
      // happen before the first await so two same-tick composer sends are atomic.
      turnStartingRef.current = true;
      setTurnStarting(true);
      const attachmentIds = attachmentAdapter.beginSend(attachments);
      void (async () => {
        let resolvedThreadId = submissionContext.threadId;
        try {
          await store.sendSubmission(
            {
              text: text || undefined,
              quote,
              attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
              model: store.model || undefined,
              effort: store.effort || undefined,
            },
            (threadId) => {
              resolvedThreadId = threadId;
              if (submissionContext.threadId === null) {
                setRecoveries((current) =>
                  current.map((recovery) =>
                    recovery.agentId === submissionContext.agentId && recovery.threadId === null
                      ? { ...recovery, threadId }
                      : recovery,
                  ),
                );
              }
            },
          );
          attachmentAdapter.completeSend(attachments);
        } catch {
          const recoveryContext = {
            agentId: submissionContext.agentId,
            threadId: resolvedThreadId,
          };
          // Selection state may not have committed yet after createThread.
          // Queue first, then let the post-render recovery effect compare the
          // exact resolved context and either rehydrate or clean it up.
          attachmentAdapter.recoverSend(attachments);
          queueRecovery(text, attachments, quote, recoveryContext);
          // sendSubmission owns the visible action error. assistant-ui does not await
          // onNew, so containing the rejection here prevents an unhandled task.
        } finally {
          turnStartingRef.current = false;
          setTurnStarting(false);
        }
      })();
    },
    [attachmentAdapter, publishRecorded, queueRecovery, recordedLoaded, runRecorded, store],
  );

  /**
   * The store as it is RIGHT NOW, for handlers that must not be rebuilt.
   *
   * The sidebar adapter below is memoized on the listing it renders rather than
   * on the whole store, so its callbacks outlive the store value they were
   * created under. Reading through this ref is what keeps them calling the
   * current `createThread`, `selectThread` and the rest instead of a closure
   * from whichever commit last changed the listing.
   */
  const storeRef = useRef(store);
  storeRef.current = store;
  // Deliberately stable: the adapter is rebuilt only when the listing it shows
  // moves, and these never change.
  const threadListActions = useMemo(() => ({
    onSwitchToNewThread: async () => {
      if (!storeRef.current.selectedAgent
        || storeRef.current.selectionLoading
        || storeRef.current.selectionError !== null) return;
      await storeRef.current.createThread().catch(() => undefined);
    },
    onSwitchToThread: (threadId: string) => storeRef.current.selectThread(threadId),
    onRename: async (threadId: string, title: string) => {
      await storeRef.current.renameThread(threadId, title).catch(() => undefined);
    },
    onArchive: async (threadId: string) => {
      await storeRef.current.archiveThread(threadId).catch(() => undefined);
    },
    onUnarchive: async (threadId: string) => {
      await storeRef.current.unarchiveThread(threadId).catch(() => undefined);
    },
  }), []);
  // Memoized on what it actually renders, NOT on the store. The store value
  // changes on every streamed token -- a new `detail`, a new run state -- and
  // rebuilding both sidebar arrays for each of them re-rendered every row in
  // the list for the whole of a running turn.
  const threadList = useMemo(
    () => ({
      threadId: store.selectedThreadId ?? undefined,
      isLoading: store.loading || store.selectionLoading,
      threads: store.threads
        .filter(
          (thread) => thread.sourceId === store.selectedAgentId && !thread.archivedAt,
        )
        .map((thread) => ({
          id: thread.id,
          remoteId: thread.id,
          status: "regular" as const,
          title: thread.title,
          custom: { runStatus: thread.runState.status, updatedAt: thread.updatedAt },
        })),
      archivedThreads: store.threads
        .filter(
          (thread) => thread.sourceId === store.selectedAgentId && Boolean(thread.archivedAt),
        )
        .map((thread) => ({
          id: thread.id,
          remoteId: thread.id,
          status: "archived" as const,
          title: thread.title,
          custom: { runStatus: thread.runState.status, updatedAt: thread.updatedAt },
        })),
      ...threadListActions,
    }),
    [
      store.loading,
      store.selectedAgentId,
      store.selectedThreadId,
      store.selectionLoading,
      store.threads,
      threadListActions,
    ],
  );

  const selectedCanSend = store.selectionError === null && !store.selectionLoading && canSendInConsole(
    store.connection,
    store.selectedAgent,
    store.selectedThread,
  );
  const selectedCanUpload = store.selectionError === null && !store.selectionLoading && canUploadInConsole(
    store.connection,
    store.selectedAgent,
    store.selectedThread,
  );
  const isRunning = store.selectedThread?.runState.status === "running";
  const submissionQueue = useMemo<ExternalThreadQueueAdapter | undefined>(
    () => store.selectedThread !== null && store.selectedThread.trigger?.kind !== "cron"
      ? {
          // The web service owns the one server-authoritative submission path.
          // Browser run state affects presentation only; every composer action
          // enters through `onNew` and the server chooses live input or a turn.
          items: [],
          enqueue: (message, options) => { void onNew(message, options); },
          steer: () => undefined,
          remove: () => undefined,
          clear: () => undefined,
        }
      : undefined,
    [onNew, store.selectedThread],
  );

  const presentation = useMemo(
    () => projectProcessJobPresentation(
        visibleCompactionMessages(store.detail?.messages ?? []).filter((message) =>
          !isLegacySilentCronMessage(message)
          && !(message.role === "assistant" && message.status === "complete"
            && message.attachments.length === 0
            && !message.parts.some((part) => part.type === "process-job-wake" || part.type === "scheduled-wake" || part.type === "steer")
            && convertWebMessage(message).content?.length === 0)),
      { threadId: store.selectedThreadId },
    ),
    [
      store.detail?.messages,
      store.selectedThreadId,
    ],
  );
  const compactionMarkerIds = useMemo(() => compactionMarkerIdsForMessages(store.detail?.messages ?? []), [store.detail?.messages]);
  // Manual markers hide their telemetry; automatic markers with inline telemetry
  // are removed from presentation while their stored rows still reach the agent.
  const convertMessage = useCallback(
    (message: WebMessage) => convertWebMessage(message, {
      compactionMarkerIds,
      processJobEvents: presentation.eventsByMessageId.get(message.id),
      processJobs: presentation.jobsById,
    }),
    [presentation.eventsByMessageId, presentation.jobsById, compactionMarkerIds],
  );
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: presentation.messages,
    // Travels with the messages, including unlisted cron/deep-link threads.
    extras: { selectedThreadId: store.selectedThreadId },
    convertMessage,
    isLoading: store.selectionLoading || store.detailLoading,
    isRunning,
    isSendDisabled: !selectedCanSend || turnStarting || Boolean(recordedState?.busy) || runningManualCompaction(store.selectedThread),
    onNew,
    onCancel: () => store.cancelTurn("api"),
    queue: submissionQueue,
    unstable_capabilities: { copy: true },
    adapters: {
      threadList,
      attachments: selectedCanUpload ? attachmentAdapter : undefined,
    },
  });

  const previousQuoteContext = useRef<string | null>(null);
  useEffect(() => {
    if (
      previousQuoteContext.current !== null &&
      previousQuoteContext.current !== attachmentContext
    ) {
      runtime.thread.composer.setQuote(undefined);
    }
    previousQuoteContext.current = attachmentContext;
  }, [attachmentContext, runtime]);

  useEffect(() => {
    // Keep queued drafts protected until the admitted request resolves. For a
    // new conversation, sendTurn binds them to the exact created thread before
    // this effect rehydrates them, so the context transition cannot dispose the
    // upload or restore it into a different same-agent conversation.
    if (turnStarting) return;
    const recovery = recoveries[0];
    if (!recovery) return;

    if (!canRestoreRecovery(recovery, selectionRef.current)) {
      setRecoveries((current) => current.filter(({ id }) => id !== recovery.id));
      void attachmentAdapter.failSend(recovery.attachments);
      return;
    }

    const composer = runtime.thread.composer;
    const current = composer.getState();
    if (recovery.text) {
      composer.setText(mergeComposerText(recovery.text, current.text));
    }
    if (recovery.quote && !current.quote) {
      composer.setQuote(recovery.quote);
    }
    if (recovery.attachments.length > 0 && !selectedCanUpload) {
      // Reconnecting/offline stores deliberately remove the runtime adapter.
      // Restore text now, but keep staged files protected until this exact
      // conversation exposes attachment support again.
      if (recovery.text) {
        setRecoveries((items) =>
          items.map((item) => item.id === recovery.id ? { ...item, text: "" } : item),
        );
      }
      return;
    }
    setRecoveries((items) => items.filter(({ id }) => id !== recovery.id));
    const existingIds = new Set(current.attachments.map(({ id }) => id));
    void (async () => {
      try {
        await Promise.all(
          recovery.attachments
            .filter(({ id }) => !existingIds.has(id))
            .map((attachment) =>
              composer.addAttachment(
                attachmentAdapter.prepareRecoveryAttachment(attachment),
              ),
            ),
        );
        attachmentAdapter.releaseRecovery(recovery.attachments);
      } catch {
        await attachmentAdapter.failSend(recovery.attachments);
      }
    })();
  }, [attachmentAdapter, recoveries, runtime, selectedCanUpload, turnStarting]);

  // A detail can lag behind a selection during navigation. Never lend its
  // transcript another agent's model scale, including a same-ID local model.
  const transcriptThread = store.detail?.thread;
  const routeOwner = transcriptThread && transcriptThread.id === store.selectedThreadId
    ? store.agents.find((agent) => agent.sourceId === transcriptThread.sourceId) ?? null
    : null;

  return (
    <ProcessJobPresentationProvider
      threadId={store.selectedThreadId}
      messages={presentation.messages}
      jobs={presentation.jobs}
      parentCalls={presentation.parentCalls}
      historyIsBounded={store.hasOlderMessages}
    >
      <AssistantRuntimeProvider runtime={runtime}>
        <ToolCallRepairProvider repair={store.loadFullToolCall}>
          <RouteCapabilitiesProvider
            agent={routeOwner}
            catalogByProvider={routeOwner?.sourceId === store.selectedAgentId ? store.catalogByProvider : undefined}
          >
            <ReplyAccessProvider refreshAttachment={store.refreshReplyAttachmentAccess}>
              <RecordedAudioContext.Provider value={{ adapter: attachmentAdapter, busy: Boolean(recordedState?.busy), checking: Boolean(recordedState?.checking),
                error: recordedState?.error, notice: recordedNotice, uncertain: Boolean(recordedState?.uncertain),
                pending: Boolean(recordedState), text: recordedState?.attempt.text,
                files: recordedState ? attachmentAdapter.snapshotFiles(recordedState.attempt.attachments) : [],
                retry: () => { if (recordedState) void runRecorded(recordedState); },
                remove: () => { if (recordedState) void removeRecorded(recordedState); } }}>
                {children}
              </RecordedAudioContext.Provider>
            </ReplyAccessProvider>
          </RouteCapabilitiesProvider>
        </ToolCallRepairProvider>
      </AssistantRuntimeProvider>
    </ProcessJobPresentationProvider>
  );
}
