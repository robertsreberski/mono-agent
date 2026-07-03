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

/**
 * The tool-start progress line surfaced as a thinking block, or null for a
 * blank/invalid tool name.
 * @param {unknown} toolName
 * @returns {string|null}
 */
export function toolStartProgressText(toolName) {
  if (typeof toolName !== "string" || toolName.trim().length === 0) return null;
  return `Running ${toolName}...`;
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
 * @property {number} turnCount
 * @property {number} toolResultsSeen
 * @property {string|null} lastToolName
 * @property {boolean} maxTurnsHit
 */

/**
 * Build the harness subscribe handler. `harness` is passed for the maxTurns
 * abort; it is already constructed when this is wired (subscribe follows the
 * AgentHarness constructor).
 * @param {StreamSubscriberState} runState
 * @param {{onEvent: (event: any) => void, options: any, toolLimits: any, harness: any}} deps
 * @returns {(event: any) => void}
 */
export function createStreamSubscriber(runState, { onEvent, options, toolLimits, harness }) {
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
    } else if (event.type === "tool_execution_start") {
      if (event.toolName) runState.lastToolName = event.toolName;
      if (event.toolCallId) runState.toolStartTimes.set(event.toolCallId, Date.now());
      const input = eventToolArgs(event.toolName, event.args, { cwd: options.cwd, toolLimits });
      const progressText = toolStartProgressText(event.toolName);
      if (progressText) {
        onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: progressText }] } });
      }
      onEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: event.toolCallId, name: event.toolName, input }] },
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
        });
      }
      onEvent({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: event.toolCallId,
            content: resultContent,
            raw_result: compactToolRawResult(jsonSerializable(event.result, resultContent), resultContent),
            is_error: !!event.isError,
          }],
        },
      });
    } else if (event.type === "turn_end") {
      runState.turnCount += 1;
      // DELEGATE-TO-PI-WHEN-AVAILABLE: pi-agent-core owns the agent loop and
      // exposes no native max-turns stop, so the ceiling is enforced here by
      // aborting on the turn_end that crosses it (only when the turn ended to
      // run more tools). Replace with a harness-native option if pi grows one.
      if (Number.isFinite(Number(options.maxTurns))
        && Number(options.maxTurns) > 0
        && runState.turnCount >= Number(options.maxTurns)
        && event.message?.stopReason === "toolUse") {
        runState.maxTurnsHit = true;
        harness.abort();
      }
    }
  };
}
