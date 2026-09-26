import { classifyNotifySuppression, type AgentMessageSender, type MemoryCaptureSpeakerKind, type MemoryCaptureEvidence } from "@mono-agent/agent-contracts";
import { createHash } from "node:crypto";
import type { RuntimeEventLike } from "@mono-agent/observability";

import type { HistoryMessage } from "../context/index.js";
import type { AgentHarnessOptions } from "../types.js";
import type { AppliedLiveInput } from "../live-input.js";
import { senderLabel } from "./speaker-context.js";
import { compactOneLine } from "./value-utils.js";

const MEMORY_PERSISTENCE_WARNING = "Memory persistence was not confirmed after the provider answer; the provider response was preserved.";

export async function buildSuccessfulTurn(
  options: AgentHarnessOptions,
  conversationId: string,
  userMessage: string,
  liveInputs: readonly AppliedLiveInput[],
  assistantText: string,
  runId: string,
  sender?: AgentMessageSender,
): Promise<{
  readonly capturedAt: string;
  readonly messages: readonly HistoryMessage[];
  readonly userMemoryText: string;
}> {
    const userLiveInputs = liveInputs;
    const capturedAt = options.now?.().toISOString() ?? new Date().toISOString();
    let assistantHistoryText = assistantText;
    try {
      assistantHistoryText = await options.turnHistoryEnricher?.enrichAssistantHistory({
        runId,
        conversationId,
        assistantText,
      }) ?? assistantText;
    } catch {
      // Enrichment is additive. A successful provider answer still commits its
      // original bytes when the optional app-owned enrichment fails.
    }
    const senderName = senderLabel(sender);
    return {
      capturedAt,
      userMemoryText: composeUserMemoryText(userMessage, userLiveInputs),
      messages: [
        {
          role: "user",
          content: userMessage,
          timestamp: capturedAt,
          runId,
          ...(senderName === undefined ? {} : { name: senderName }),
        },
        // Live follow-ups deliberately carry NO name: AppliedLiveInput has no
        // identity of its own, and assuming "same speaker" is wrong in a group.
        ...userLiveInputs.map((input) => ({
          role: "user" as const,
          content: input.text,
          timestamp: input.receivedAt,
          runId,
        })),
        { role: "assistant", content: assistantHistoryText, timestamp: capturedAt, runId },
      ],
    };
}

function composeUserMemoryText(initial: string, liveInputs: readonly AppliedLiveInput[]): string {
  if (liveInputs.length === 0) return initial;
  return [
    initial,
    ...liveInputs.map((input, index) => `Live follow-up ${index + 1}:\n${input.text}`),
  ].join("\n\n");
}

/**
 * Persists additive memory after durable conversation history commits.
 * userMessage is the redacted persistence text, never the provider-expanded
 * attachment prompt.
 */
export async function persistSuccessfulMemory(
  harnessOptions: AgentHarnessOptions,
  conversationId: string,
  userMessage: string,
  assistantText: string,
  persistenceOptions: {
    readonly runId: string;
    readonly source?: string;
    readonly captureSpeakerKind?: MemoryCaptureSpeakerKind;
    readonly sender?: AgentMessageSender;
    readonly ownerTurn?: true;
    readonly trustedUserText?: string;
    readonly toolOutcomes?: MemoryCaptureEvidence["toolOutcomes"];
    readonly emit?: (event: RuntimeEventLike) => void;
  },
): Promise<void> {
    const mode = harnessOptions.memoryWriteMode;
    if (harnessOptions.memory !== undefined && (mode === "append-host-summary" || mode === "capture")) {
      if (shouldSkipMemoryPersistence(assistantText)) {
        return;
      }
      const memory = harnessOptions.memory;
      const summary = deterministicHostSummary(userMessage, assistantText, persistenceOptions);
      const evidence = mode === "capture" ? captureEvidence(persistenceOptions) : undefined;
      try {
        // Harness construction guarantees write capability. Await the stable-run
        // admission boundary before returning the already-successful provider answer.
        await memory.persistCompletedTurn!({
          runId: persistenceOptions.runId,
          conversationId,
          summary,
          ...(persistenceOptions.captureSpeakerKind === undefined || persistenceOptions.captureSpeakerKind === "unknown"
            ? {} : { captureSpeakerKind: persistenceOptions.captureSpeakerKind }),
          ...(mode === "capture"
            ? { captureText: captureTurnText(userMessage, assistantText, persistenceOptions),
              ...(evidence === undefined ? {} : { captureEvidence: evidence }) }
            : {}),
        });
      } catch {
        // The provider answer already succeeded. Memory is additive and must
        // never retroactively turn that answer into a failed turn. Keep this
        // diagnostic constant: backend errors can contain secrets, paths,
        // model content, hostile accessors, or control characters.
        const message = MEMORY_PERSISTENCE_WARNING;
        try {
          persistenceOptions.emit?.({
            type: "runtime_warning",
            warning_kind: "memory_persistence_degraded",
            message,
          });
        } catch {
          // User event callbacks are untrusted and cannot fail the turn.
        }
        try {
          harnessOptions.onMemoryWarning?.(message);
        } catch {
          // Host diagnostics are best-effort.
        }
      }
    }
}

function deterministicHostSummary(
  userMessage: string,
  assistantText: string,
  options: MemoryTurnOptions = {},
): string {
  if (isTriggerSource(options.source) || options.captureSpeakerKind === "trigger") {
    return [
      "Host-observed completed trigger turn.",
      `Assistant: ${compactOneLine(assistantText, 240)}`,
    ].join("\n");
  }
  return [
    "Host-observed completed turn.",
    `User${speakerSuffix(options.sender)}: ${compactOneLine(userMessage, 240)}`,
    `Assistant: ${compactOneLine(assistantText, 240)}`,
  ].join("\n");
}

function captureTurnText(
  userMessage: string,
  assistantText: string,
  options: MemoryTurnOptions = {},
): string {
  // Richer than the compacted host summary: the distiller wants the real turn content.
  if (isTriggerSource(options.source) || options.captureSpeakerKind === "trigger") {
    // Do not include the untrusted trigger body (especially webhook payloads).
    // The source label gives the extractor the missing speaker context without
    // pretending that a scheduled instruction was a human statement.
    const trigger = options.source === "cron" ? "Scheduled task trigger"
      : options.source === "webhook" ? "Webhook trigger" : "Automated trigger";
    return `${trigger} (not a user message; trigger text omitted):\nAssistant: ${assistantText}${toolOutcomeBlock(options)}`;
  }
  return `User${speakerSuffix(options.sender)}: ${userMessage}\nAssistant: ${assistantText}${toolOutcomeBlock(options)}`;
}

function toolOutcomeBlock(options: MemoryTurnOptions): string {
  const outcomes = options.toolOutcomes ?? [];
  if (!outcomes.some((item) => item.outcome === "failed")) return "";
  return `\nHOST-OBSERVED TOOL OUTCOMES (categories only; not user text):\n${outcomes.slice(0, 16)
    .map(({ category, outcome }) => `${category}: ${outcome}`).join("\n")}`;
}

export function memorySenderToken(source: string | undefined, sender: AgentMessageSender | undefined): string | undefined {
  const id = sender?.id;
  return typeof id === "string" && id.length > 0 && Buffer.byteLength(id, "utf8") <= 256
    ? createHash("sha256").update(`${source ?? "unknown"}\0${id}`).digest("hex").slice(0, 32)
    : undefined;
}

function captureEvidence(options: MemoryTurnOptions): MemoryCaptureEvidence | undefined {
  // Only a host-stamped human turn may retain its outer message as evidence.
  // Automated/webhook bodies never enter the intake, even when supplied by a caller.
  const userText = options.captureSpeakerKind === "human-turn" && !isTriggerSource(options.source)
    ? options.trustedUserText : "";
  if (userText === undefined || Buffer.byteLength(userText, "utf8") > 16 * 1024
    || /[\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(userText)) return undefined;
  const senderToken = options.captureSpeakerKind === "human-turn"
    ? memorySenderToken(options.source, options.sender)
    : undefined;
  return { userText, ...(senderToken === undefined ? {} : { senderToken }),
    ...(options.ownerTurn === true ? { ownerTurn: true as const } : {}),
    toolOutcomes: [...(options.toolOutcomes ?? [])] };
}

/**
 * Attributes the captured turn to a named person so that what the agent learns
 * in a group chat is recallable in that person's DM -- recall is global, so the
 * attribution is the only missing link. Purely additive: an unattributed turn
 * still produces the exact `User: ` stem the distiller has always seen.
 */
function speakerSuffix(sender: AgentMessageSender | undefined): string {
  const label = senderLabel(sender);
  return label === undefined ? "" : ` (${label})`;
}

interface MemoryTurnOptions {
  readonly source?: string;
  readonly captureSpeakerKind?: MemoryCaptureSpeakerKind;
  readonly sender?: AgentMessageSender;
  readonly ownerTurn?: true;
  readonly trustedUserText?: string;
  readonly toolOutcomes?: MemoryCaptureEvidence["toolOutcomes"];
}

function isTriggerSource(source: string | undefined): boolean {
  return source === "cron" || source === "webhook";
}

// No word lists: a probe or filler turn goes to extraction, which may return empty.
function shouldSkipMemoryPersistence(assistantText: string): boolean {
  return isNothingToReportSentinel(assistantText);
}

// Deliberately not `suppressesNotification`, which also treats empty text as
// suppressed: an empty assistant turn was never skipped here and changing that
// is a separate decision. This adds only the narrated-sentinel case.
function isNothingToReportSentinel(assistantText: string): boolean {
  const suppression = classifyNotifySuppression(assistantText);
  return suppression === "sentinel" || suppression === "narrated-sentinel";
}
