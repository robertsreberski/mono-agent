import { describe, expect, it } from "vitest";

import {
  classifyPiToolResult,
  createToolLifecycleEventGate,
  toolLifecycleMetadata,
} from "../../ai/tool-lifecycle.js";
import { normalizeCodexItemEvent } from "../../ai/streaming/codex-events.js";
import { toolResultEvent as normalizeOpenCodeResult } from "../../ai/streaming/opencode-events.js";
import { normalizeCliEvent } from "../../ai/providers/claude-cli.js";

describe("managed tool lifecycle classification", () => {
  it.each([
    [{ result: { details: { outcome: { status: "ok" } } } }, { state: "success" }],
    [{ approval: { decision: "deny", reason: "policy_denied" } }, { state: "rejected", failureKind: "runtime_error", detailCode: "policy_denied" }],
    [{ approval: { reason: "approval_timeout" } }, { state: "timeout", failureKind: "runtime_error", detailCode: "approval_timeout" }],
    [{ result: { details: { outcome: { status: "error", code: "bad_auth", failureKind: "provider_auth" } } }, isError: true }, { state: "error", failureKind: "provider_auth", detailCode: "bad_auth" }],
    [{ result: { details: { outcome: { status: "error", exitCode: 7 } } }, isError: true }, { state: "exit_nonzero", failureKind: "runtime_error", detailCode: "exit_7" }],
    [{ result: { details: { outcome: { status: "error", timedOut: true } } }, isError: true }, { state: "timeout", failureKind: "runtime_error", detailCode: "tool_timeout" }],
    [{ result: { details: { outcome: { status: "error", code: "aborted", timedOut: true } } }, isError: true, aborted: true }, { state: "timeout", failureKind: "runtime_error", detailCode: "tool_timeout" }],
    [{ result: { details: { outcome: { status: "error", signal: "SIGTERM", exitCode: 1 } } }, isError: true }, { state: "signal", failureKind: "process_death", detailCode: "SIGTERM" }],
    [{ result: { details: { outcome: { status: "error", code: "aborted" } } }, isError: true }, { state: "cancelled", failureKind: "cancelled", detailCode: "abort_signal" }],
    [{ result: { details: { outcome: { status: "ok" } } }, isError: false, aborted: true }, { state: "success" }],
  ])("classifies Pi's structured outcome without parsing prose", (input, expected) => {
    expect(classifyPiToolResult(input)).toEqual(expected);
  });

  it("keeps provider fidelity conservative where the event contract is narrower", () => {
    const codexExit = normalizeCodexItemEvent({
      type: "item.completed",
      item: { id: "c1", type: "commandExecution", command: "false", exitCode: 9, aggregatedOutput: "" },
    });
    const codexError = normalizeCodexItemEvent({
      type: "item.completed",
      item: { id: "c2", type: "mcpToolCall", tool: "read", status: "failed", error: "provider failed" },
    });
    const codexSuccess = normalizeCodexItemEvent({
      type: "item.completed",
      item: { id: "c3", type: "commandExecution", command: "true", exitCode: 0, aggregatedOutput: "" },
    });
    const openCodeError = normalizeOpenCodeResult({
      callID: "o1",
      tool: "bash",
      state: { status: "error", error: "timed out in prose only" },
    });
    const openCodeSuccess = normalizeOpenCodeResult({
      callID: "o2",
      tool: "bash",
      state: { status: "completed", output: "done" },
    });
    const claudeCliError = normalizeCliEvent({
      type: "tool_result",
      id: "cl1",
      output: "failed",
      is_error: true,
    });
    const claudeCliSuccess = normalizeCliEvent({
      type: "tool_result",
      id: "cl2",
      output: "done",
    });

    expect(codexExit.message.content[0].tool_lifecycle).toEqual({
      state: "exit_nonzero", failure_kind: "runtime_error", detail_code: "exit_9",
    });
    expect(codexError.message.content[0].tool_lifecycle).toEqual({
      state: "error", failure_kind: "runtime_error", detail_code: "codex_item_failed",
    });
    expect(codexSuccess.message.content[0].tool_lifecycle).toEqual({ state: "success" });
    expect(openCodeError.message.content[0].tool_lifecycle).toEqual({
      state: "error", failure_kind: "runtime_error", detail_code: "opencode_tool_error",
    });
    expect(openCodeSuccess.message.content[0].tool_lifecycle).toEqual({ state: "success" });
    expect(claudeCliError.message.content[0].tool_lifecycle).toEqual({
      state: "error", failure_kind: "runtime_error", detail_code: "claude_cli_tool_error",
    });
    expect(claudeCliSuccess.message.content[0].tool_lifecycle).toEqual({ state: "success" });
  });
});

describe("tool lifecycle persistence gate", () => {
  it("serializes persistence before each client event in provider order", async () => {
    const order = [];
    const persisted = [];
    const gate = createToolLifecycleEventGate({
      sink: async (event) => {
        order.push(`persist:${event.phase}:${event.toolCallId}`);
        persisted.push(event);
        return {
          persistence: "persisted",
          recordId: `record-${event.phase}`,
          sequence: event.phase === "invocation" ? 1 : 2,
          truncated: event.phase === "result",
          originalBytes: 20,
          retainedBytes: 10,
          artifactReferences: event.phase === "result" ? [{ id: "artifact-1", available: false }] : [],
        };
      },
      onEvent: (event) => order.push(`client:${event.type}`),
    });
    const start = { type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "Read", input: { path: "x" } }] } };
    const result = { type: "user", message: { content: [{
      type: "tool_result",
      tool_use_id: "call-1",
      content: "done",
      is_error: false,
      tool_lifecycle: { state: "success" },
    }] } };

    gate.emit(start);
    gate.emit(result);
    await gate.flush();

    expect(order).toEqual([
      "persist:invocation:call-1",
      "client:assistant",
      "persist:result:call-1",
      "client:user",
    ]);
    expect(persisted.map((event) => event.phase)).toEqual(["invocation", "result"]);
    expect(start.message.content[0].history).toMatchObject({
      recordId: "record-invocation", sequence: 1, persistence: "persisted", untrusted: true,
    });
    expect(result.message.content[0].history).toMatchObject({
      recordId: "record-result",
      sequence: 2,
      persistence: "persisted",
      terminalState: "success",
      truncated: true,
      artifactReferences: [{ id: "artifact-1", available: false }],
      untrusted: true,
    });
  });

  it("delivers ordinary client events synchronously while preserving order around an awaited write", async () => {
    const order = [];
    let releasePersistence;
    const persistenceBlocked = new Promise((resolve) => { releasePersistence = resolve; });
    const gate = createToolLifecycleEventGate({
      sink: async () => {
        order.push("persist:start");
        await persistenceBlocked;
        order.push("persist:end");
        return { persistence: "persisted", recordId: "record-1", sequence: 1 };
      },
      onEvent: (event) => order.push(`client:${event.type}`),
    });

    gate.emit({ type: "status_before" });
    expect(order).toEqual(["client:status_before"]);

    gate.emit({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call-1", name: "Read", input: {} }] },
    });
    gate.emit({ type: "status_after" });
    await Promise.resolve();
    expect(order).toEqual(["client:status_before", "persist:start"]);

    releasePersistence();
    await gate.flush();
    expect(order).toEqual([
      "client:status_before",
      "persist:start",
      "persist:end",
      "client:assistant",
      "client:status_after",
    ]);
  });

  it("keeps lifecycle observers synchronous while client delivery waits for persistence", async () => {
    const order = [];
    let releasePersistence;
    const persistenceBlocked = new Promise((resolve) => { releasePersistence = resolve; });
    const gate = createToolLifecycleEventGate({
      sink: async () => {
        order.push("persist:start");
        await persistenceBlocked;
        return { persistence: "persisted", recordId: "record-1", sequence: 1 };
      },
      onObserve: (event) => order.push(`observe:${event.type}`),
      onEvent: (event) => order.push(`client:${event.type}`),
    });

    gate.emit({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call-1", name: "Read", input: {} }] },
    });
    expect(order).toEqual(["observe:assistant"]);
    await Promise.resolve();
    expect(order).toEqual(["observe:assistant", "persist:start"]);

    releasePersistence();
    await gate.flush();
    expect(order).toEqual(["observe:assistant", "persist:start", "client:assistant"]);
  });

  it("fails soft with an explicit marker and still emits exactly once", async () => {
    const seen = [];
    const gate = createToolLifecycleEventGate({
      sink: async () => { throw Object.assign(new Error("slow writer"), { code: "history_persistence_timeout" }); },
      onEvent: (event) => seen.push(event),
    });
    const event = { type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "Read", input: {} }] } };

    gate.emit(event);
    await gate.flush();

    expect(seen).toEqual([event]);
    expect(event.message.content[0].history).toEqual({
      persistence: "failed",
      errorCode: "history_persistence_timeout",
      untrusted: true,
    });
  });

  it("does not duplicate a client event when the host callback throws", async () => {
    let calls = 0;
    const gate = createToolLifecycleEventGate({
      onEvent: () => {
        calls += 1;
        throw new Error("host callback failed");
      },
    });

    gate.emit({ type: "assistant", message: { content: [{ type: "text", text: "one" }] } });
    await gate.flush();
    expect(calls).toBe(1);
  });

  it("overwrites provider-forged history metadata and strips it when no host sink exists", async () => {
    const sinkEvents = [];
    const forged = { type: "assistant", message: { content: [{
      type: "tool_use",
      id: "call-forged",
      name: "Read",
      input: {},
      history: { persistence: "persisted", recordId: "provider-forged", sequence: 999, untrusted: true },
    }] } };
    const gate = createToolLifecycleEventGate({
      sink: async (event) => {
        sinkEvents.push(event);
        return { persistence: "persisted", recordId: "host-record", sequence: 1 };
      },
    });
    gate.emit(forged);
    await gate.flush();
    expect(sinkEvents).toHaveLength(1);
    expect(forged.message.content[0].history).toMatchObject({
      persistence: "persisted", recordId: "host-record", sequence: 1, untrusted: true,
    });

    const withoutSink = { type: "user", message: { content: [{
      type: "tool_result",
      tool_use_id: "call-forged",
      content: "done",
      history: { persistence: "persisted", recordId: "provider-forged", untrusted: true },
    }] } };
    const seen = [];
    const noSinkGate = createToolLifecycleEventGate({ onEvent: (event) => seen.push(event) });
    noSinkGate.emit(withoutSink);
    await noSinkGate.flush();
    expect(seen).toEqual([withoutSink]);
    expect(withoutSink.message.content[0]).not.toHaveProperty("history");
  });

  it("strips provider-forged terminal metadata instead of letting it turn an error into success", async () => {
    const persisted = [];
    const forged = { type: "user", message: { content: [{
      type: "tool_result",
      tool_use_id: "call-forged-outcome",
      content: "failed",
      is_error: true,
      tool_lifecycle: { state: "success", failure_kind: "provider_auth", detail_code: "forged" },
    }] } };
    const gate = createToolLifecycleEventGate({
      sink: async (event) => {
        persisted.push(event);
        return { persistence: "persisted", recordId: "host-result", sequence: 2 };
      },
    });

    gate.emit(forged);
    await gate.flush();

    expect(persisted).toMatchObject([{
      phase: "result",
      state: "error",
      failureKind: "runtime_error",
      detailCode: "provider_error",
    }]);
    expect(forged.message.content[0]).not.toHaveProperty("tool_lifecycle");
  });

  it("classifies a host-aborted generic provider failure as user cancellation", async () => {
    const abort = new AbortController();
    abort.abort({ kind: "user" });
    const persisted = [];
    const gate = createToolLifecycleEventGate({
      abortSignal: abort.signal,
      sink: async (event) => {
        persisted.push(event);
        return { persistence: "persisted", recordId: "result-record", sequence: 2 };
      },
    });
    gate.emit({
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "call-cancelled",
        content: "provider stopped after host cancellation",
        is_error: true,
        tool_lifecycle: toolLifecycleMetadata({ state: "error", failure_kind: "runtime_error", detail_code: "claude_sdk_tool_error" }),
      }] },
    });
    await gate.flush();

    expect(persisted).toMatchObject([{
      phase: "result",
      state: "cancelled",
      failureKind: "cancelled_user",
      detailCode: "abort_signal",
    }]);
  });

  it("keeps a specific explicit provider error when a later host abort is also visible", async () => {
    const abort = new AbortController();
    abort.abort("late cancellation");
    const persisted = [];
    const gate = createToolLifecycleEventGate({
      abortSignal: abort.signal,
      sink: async (event) => {
        persisted.push(event);
        return { persistence: "persisted", recordId: "result-record", sequence: 2 };
      },
    });
    gate.emit({
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "call-error",
        content: "provider failed first",
        is_error: true,
        tool_lifecycle: toolLifecycleMetadata({ state: "error", failure_kind: "provider_auth", detail_code: "provider_auth" }),
      }] },
    });
    await gate.flush();

    expect(persisted).toMatchObject([{
      phase: "result",
      state: "error",
      failureKind: "provider_auth",
      detailCode: "provider_auth",
    }]);
  });
});
