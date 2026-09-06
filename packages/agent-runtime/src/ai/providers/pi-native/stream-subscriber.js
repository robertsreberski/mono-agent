// @ts-check
// Harness event → runtime-event normalization for the pi-native bridge.
//
// Pure move of the `harness.subscribe` handler out of pi-native.js: text /
// thinking delta+end dedup, tool start / update / end / timing events, and the
// turn-counting + maxTurns stop. All mutable counters and dedup keys live on the
// caller-owned `runState`; no module-level mutable state here.

import { toolResultContent } from "../pi-messages.js";
import {
  compactToolRawResult,
  eventToolArgs,
  jsonSerializable,
  streamContentKey,
} from "../pi-events.js";
import { contextUsageFromAssistantMessage } from "./result-builder.js";
import { classifyPiToolResult, toolLifecycleMetadata } from "../../tool-lifecycle.js";

function toolResultFileChange(result) {
  const fileChange = result?.details?.file_change;
  return fileChange && typeof fileChange === "object" && !Array.isArray(fileChange)
    ? jsonSerializable(fileChange, null)
    : null;
}

function toolResultOutcome(result) {
  const source = result?.details?.outcome;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const bounded = {};
  const strings = {
    status: "status",
    code: "code",
    backend: "backend",
    signal: "signal",
    contentKind: "content_kind",
    charset: "charset",
    charsetSource: "charset_source",
    extractionStage: "extraction_stage",
    renderReason: "render_reason",
  };
  const numbers = {
    attempts: "attempts",
    queueWaitMs: "queue_wait_ms",
    backendDurationMs: "backend_duration_ms",
    retryAfterMs: "retry_after_ms",
    cooldownSkipCount: "cooldown_skip_count",
    quotaSkipCount: "quota_skip_count",
    bytes: "bytes",
    exitCode: "exit_code",
    statusCode: "status_code",
    redirectCount: "redirect_count",
    parserFailureCount: "parser_failure_count",
  };
  const booleans = {
    retryable: "retryable",
    cacheHit: "cache_hit",
    truncated: "truncated",
    timedOut: "timed_out",
    rendered: "rendered",
    renderFailed: "render_failed",
    browserRecommended: "browser_recommended",
    hadDecodingReplacement: "had_decoding_replacement",
  };
  for (const [input, output] of Object.entries(strings)) {
    if (typeof source[input] === "string") bounded[output] = source[input].slice(0, 120);
  }
  for (const [input, output] of Object.entries(numbers)) {
    if (Number.isFinite(Number(source[input]))) bounded[output] = Number(source[input]);
  }
  for (const [input, output] of Object.entries(booleans)) {
    if (typeof source[input] === "boolean") bounded[output] = source[input];
  }
  return bounded;
}

/**
 * The slice of run state the stream subscriber reads and mutates. A structural
 * subset of the orchestrator's runState.
 * @typedef {object} StreamSubscriberState
 * @property {string[]} assistantTexts
 * @property {string[]} assistantThinking
 * @property {Set<unknown>} textDeltaIndexes
 * @property {Set<unknown>} thinkingDeltaIndexes
 * @property {Map<string, number>} toolStartTimes
 * @property {Map<string, any>} toolApprovals
 * @property {number} turnCount
 * @property {number} toolResultsSeen
 * @property {string|null} lastToolName
 * @property {boolean} maxTurnsHit
 */

/**
 * Build the harness subscribe handler. `harness` is passed for the maxTurns
 * abort; it is already constructed when this is wired (subscribe follows
 * AgentHarness.create()).
 * @param {StreamSubscriberState} runState
 * @param {{onEvent: (event: any) => void, options: any, toolLimits: any, harness: any, sdk: string, model: string}} deps
 * @returns {(event: any) => void}
 */
export function createStreamSubscriber(runState, { onEvent, options, toolLimits, harness, sdk, model }) {
  return (event) => {
    if (event.type === "message_update") {
      const streamEvent = event.assistantMessageEvent;
      if (streamEvent?.type === "text_delta" && streamEvent.delta) {
        runState.textDeltaIndexes.add(streamContentKey(streamEvent, "text"));
        runState.assistantTexts.push(streamEvent.delta);
        onEvent({ type: "assistant", message: { content: [{ type: "text", text: streamEvent.delta }] } });
      } else if (streamEvent?.type === "text_end" && streamEvent.content) {
        const key = streamContentKey(streamEvent, "text");
        if (!runState.textDeltaIndexes.has(key)) {
          runState.assistantTexts.push(streamEvent.content);
          onEvent({ type: "assistant", message: { content: [{ type: "text", text: streamEvent.content }] } });
        }
      } else if (streamEvent?.type === "thinking_delta" && streamEvent.delta) {
        runState.thinkingDeltaIndexes.add(streamContentKey(streamEvent, "thinking"));
        runState.assistantThinking.push(streamEvent.delta);
        onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: streamEvent.delta }] } });
      } else if (streamEvent?.type === "thinking_end" && streamEvent.content) {
        const key = streamContentKey(streamEvent, "thinking");
        if (!runState.thinkingDeltaIndexes.has(key)) {
          runState.assistantThinking.push(streamEvent.content);
          onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: streamEvent.content }] } });
        }
      }
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const contextUsage = contextUsageFromAssistantMessage(event.message);
      if (contextUsage) {
        const contextWindow = Number(harness?.getModel?.()?.contextWindow) || 0;
        const measurementId = typeof event.message?.id === "string" && event.message.id.trim().length > 0
          ? event.message.id
          : undefined;
        onEvent({
          type: "context_usage",
          sdk,
          model,
          timestamp: Date.now(),
          ...(measurementId === undefined ? {} : { measurementId }),
          ...(contextWindow > 0 ? { contextWindow } : {}),
          tokens: contextUsage,
        });
      }
      const hasVisibleContent = Array.isArray(event.message?.content)
        && event.message.content.some((block) => block
          && typeof block === "object"
          && ((block.type === "text"
            && typeof block.text === "string"
            && block.text.length > 0)
            || (block.type === "thinking"
              && ((typeof block.thinking === "string" && block.thinking.length > 0)
                || (typeof block.text === "string" && block.text.length > 0)))));
      if (hasVisibleContent) {
        const messageId = typeof event.message?.id === "string" && event.message.id.trim().length > 0
          ? event.message.id
          : undefined;
        onEvent({
          type: "assistant_message_boundary",
          ...(messageId === undefined ? {} : { messageId }),
        });
      }
    } else if (event.type === "tool_execution_start") {
      if (event.toolName) runState.lastToolName = event.toolName;
      if (event.toolCallId) runState.toolStartTimes.set(event.toolCallId, Date.now());
      const input = eventToolArgs(event.toolName, event.args, { cwd: options.cwd, toolLimits });
      onEvent({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: event.toolCallId,
            name: event.toolName,
            input,
          }],
        },
      });
    } else if (event.type === "tool_execution_update") {
      const input = eventToolArgs(event.toolName, event.args, { cwd: options.cwd, toolLimits });
      onEvent({
        type: "tool_update",
        tool_use_id: event.toolCallId,
        name: event.toolName,
        input,
        partial_result: jsonSerializable(event.partialResult, String(event.partialResult ?? "")),
      });
    } else if (event.type === "tool_execution_end") {
      const resultContent = toolResultContent(event.result);
      const fileChange = toolResultFileChange(event.result);
      const outcome = toolResultOutcome(event.result);
      const classification = classifyPiToolResult({
        result: event.result,
        isError: !!event.isError,
        aborted: options.abortSignal?.aborted === true,
        approval: runState.toolApprovals.get(event.toolCallId),
      });
      if (!event.isError) runState.toolResultsSeen += 1;
      const startedAt = runState.toolStartTimes.get(event.toolCallId);
      if (startedAt !== undefined) {
        runState.toolStartTimes.delete(event.toolCallId);
        onEvent({
          type: "tool_timing",
          tool_use_id: event.toolCallId,
          name: event.toolName,
          execution_ms: Date.now() - startedAt,
          is_error: !!event.isError,
          ...(outcome || {}),
          tool_lifecycle: toolLifecycleMetadata({
            state: classification.state,
            failure_kind: classification.failureKind,
            detail_code: classification.detailCode,
          }),
        });
      }
      runState.toolApprovals.delete(event.toolCallId);
      const rawResult = compactToolRawResult(jsonSerializable(event.result, resultContent), resultContent);
      onEvent({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: event.toolCallId,
            content: resultContent,
            raw_result: rawResult,
            ...(fileChange === null ? {} : { file_change: fileChange }),
            is_error: !!event.isError,
            tool_lifecycle: toolLifecycleMetadata({
              state: classification.state,
              failure_kind: classification.failureKind,
              detail_code: classification.detailCode,
            }),
          }],
        },
      });
    } else if (event.type === "turn_end") {
      runState.turnCount += 1;
      // NON-DELEGABLE (verified against @earendil-works/pi-agent-core 0.85.1).
      // pi's only after-turn stop hook is `shouldStopAfterTurn` on the LOW-LEVEL
      // `AgentLoopConfig` (dist/types.d.ts) — the config passed to the raw
      // `agentLoop`. It is NOT surfaced on `AgentHarnessOptions`
      // (dist/harness/types.d.ts) and `AgentHarness` (dist/harness/agent-harness.d.ts)
      // exposes no maxTurns / maxSteps / loop-config passthrough. This bridge is
      // built on AgentHarness (for its session tree, compaction, steering, and
      // event stream); reaching `shouldStopAfterTurn` would mean abandoning the
      // harness for the low-level loop and reimplementing all of that. So the
      // maxTurns ceiling stays enforced HERE: we count `turn_end`s and abort on
      // the one that crosses the ceiling, but only when the turn ended to run
      // MORE tools (stopReason "toolUse") — a turn that already produced a final
      // answer must not be clipped. Delegate to a harness-native option only if
      // pi lifts shouldStopAfterTurn (or an equivalent) onto AgentHarnessOptions.
      if (Number.isFinite(Number(options.maxTurns))
        && Number(options.maxTurns) > 0
        && runState.turnCount >= Number(options.maxTurns)
        && event.message?.stopReason === "toolUse") {
        runState.maxTurnsHit = true;
        void Promise.resolve(harness.abort()).catch(() => {});
      }
    }
  };
}
