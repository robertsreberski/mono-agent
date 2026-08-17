import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { StatusBar } from "../ui/components/status-bar.js";
import { formatDurationMs, formatTokens } from "../ui/format.js";
import { TurnPresenter } from "../ui/turn-presenter.js";
import { stripAnsi } from "./test-terminal.js";

function setup(now?: () => number, opts?: { requestedModelOverride?: string }): {
  presenter: TurnPresenter;
  transcript: Container;
  statusBar: StatusBar;
  rendered: () => string;
  status: () => string;
  renders: { count: number };
} {
  const transcript = new Container();
  const statusBar = new StatusBar();
  const renders = { count: 0 };
  const presenter = new TurnPresenter({
    transcript,
    statusBar,
    requestRender: () => {
      renders.count += 1;
    },
    flushIntervalMs: 0,
    ...(now === undefined ? {} : { now }),
    ...(opts?.requestedModelOverride === undefined ? {} : { requestedModelOverride: opts.requestedModelOverride }),
  });
  return {
    presenter,
    transcript,
    statusBar,
    renders,
    rendered: () => stripAnsi(transcript.render(80).join("\n")),
    status: () => stripAnsi(statusBar.render(80).join("\n")),
  };
}

describe("TurnPresenter", () => {
  it("renders streamed text, thinking, tool lifecycle, and telemetry in order", async () => {
    const { presenter, rendered, status } = setup();

    await presenter.event({ type: "provider_status", kind: "request_started", model: "claude-fable-5" });
    await presenter.event({ type: "assistant_thought", text: "I should list the files. " });
    await presenter.event({ type: "assistant_thought", text: "Then answer." });
    await presenter.event({ type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } });
    await presenter.event({ type: "tool_call_progress", id: "t1", partialResult: "a.txt\nb.txt\n" });
    await presenter.event({
      type: "tool_call_completed",
      id: "t1",
      content: "a.txt\nb.txt",
      isError: false,
      executionMs: 42,
    });
    await presenter.event({
      type: "usage_update",
      cumulativeUsd: 0.012,
      tokens: { input: 900, output: 40, cacheRead: 100, cacheCreation: 0 },
      model: "claude-fable-5",
    });
    await presenter.append("There are ");
    await presenter.append("two files.");
    await presenter.finish("There are two files.");
    presenter.settle();

    const text = rendered();
    // Thinking collapsed to a summary by default.
    expect(text).toContain("thought (");
    expect(text).not.toContain("I should list the files");
    // Tool panel with name, args preview, timing, result.
    expect(text).toContain("✓ bash");
    expect(text).toContain("42ms");
    expect(text).toContain("a.txt");
    // Streamed answer once (no duplication after finish reconciliation).
    expect(text.match(/two files\./gu)?.length).toBe(1);
    // Order: thinking before tool before answer.
    expect(text.indexOf("thought")).toBeLessThan(text.indexOf("✓ bash"));
    expect(text.indexOf("✓ bash")).toBeLessThan(text.indexOf("two files."));
    // Telemetry landed on the status bar.
    expect(status()).toContain("↑900");
    expect(status()).toContain("$0.012");
  });

  it("renders applied live input as a completed Steered tool panel", async () => {
    const { presenter, rendered } = setup();

    await presenter.event({
      type: "tool_call_started",
      id: "live-input:follow-up-1",
      name: "↪️ Steered: “Use the API instead”",
      metadata: { liveInput: true, synthetic: true },
    });
    await presenter.event({
      type: "tool_call_completed",
      id: "live-input:follow-up-1",
      name: "↪️ Steered: “Use the API instead”",
      content: "Applied to current run",
      metadata: { liveInput: true, synthetic: true },
    });

    expect(rendered()).toContain("✓ ↪️ Steered: “Use the API instead”");
    expect(rendered()).toContain("Applied to current run");
    expect(rendered()).not.toContain("◐ ↪️ Steered");
  });

  it("does not promise artifact recovery when a streamed tool payload was truncated", async () => {
    const { presenter, rendered } = setup();
    await presenter.event({ type: "tool_call_started", id: "t1", name: "read_file" });
    await presenter.event({
      type: "tool_call_completed",
      id: "t1",
      content: "bounded preview",
      metadata: { truncated: true },
    });

    const text = rendered();
    expect(text).toContain("payload truncated for streaming; replay may also be bounded");
    expect(text).not.toContain("full data in run artifacts");
  });

  it("keeps successful persistence bookkeeping off the tool panel while still using the canonical state", async () => {
    const { presenter, rendered } = setup();
    await presenter.event({
      type: "tool_call_started",
      id: "history-tool",
      name: "Bash",
      arguments: { command: "slow" },
      history: {
        recordId: "sth1_start",
        sequence: 1,
        persistence: "persisted",
        untrusted: true,
      },
    });
    await presenter.event({
      type: "tool_call_completed",
      id: "history-tool",
      name: "Bash",
      content: "bounded output",
      history: {
        ...({ privatePayload: "persisted-history-secret" } as object),
        recordId: "sth1_result",
        sequence: 2,
        persistence: "persisted",
        terminalState: "timeout",
        truncated: true,
        artifactReferences: [{ id: "stha1_output", available: false }],
        untrusted: true,
      },
    });

    const text = rendered();
    expect(text).toContain("✗ Bash");
    expect(text).not.toContain("sth1_result");
    expect(text).not.toContain("untrusted historical data");
    expect(text).not.toContain("persisted-history-secret");
  });

  it("reports a lost history record without leaking unrelated fields", async () => {
    const { presenter, rendered } = setup();
    await presenter.event({ type: "tool_call_started", id: "failed-history-tool", name: "Read" });
    await presenter.event({
      type: "tool_call_completed",
      id: "failed-history-tool",
      name: "Read",
      content: "bounded result",
      history: {
        ...({ privatePayload: "failed-history-secret" } as object),
        recordId: "sth1_failed",
        persistence: "failed",
        errorCode: "history_writer_closed",
        untrusted: true,
      },
    });

    const text = rendered();
    expect(text.replace(/\s+/gu, " ")).toContain(
      "Tool history for this call was not saved (history_writer_closed).",
    );
    expect(text).not.toContain("sth1_failed");
    expect(text).not.toContain("failed-history-secret");
  });

  it("escapes terminal and bidi controls in untrusted history identifiers", async () => {
    const { presenter, rendered } = setup();
    await presenter.event({ type: "tool_call_started", id: "hostile-history-tool", name: "Read" });
    await presenter.event({
      type: "tool_call_completed",
      id: "hostile-history-tool",
      name: "Read",
      content: "bounded result",
      history: {
        recordId: "sth1_safe\u001b[31m",
        persistence: "failed",
        errorCode: "history\u202eclosed",
        untrusted: true,
      },
    });

    const text = rendered();
    expect(text).toContain("history\\u202eclosed");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u202e");
  });

  it("expands thinking on demand with the full text", async () => {
    const { presenter, transcript, rendered } = setup();
    await presenter.event({ type: "assistant_thought", text: "secret reasoning here" });
    presenter.settle();

    expect(rendered()).not.toContain("secret reasoning here");
    for (const child of transcript.children) {
      (child as { setExpanded?: (expanded: boolean) => void }).setExpanded?.(true);
    }
    expect(rendered()).toContain("secret reasoning here");
  });

  it("splits assistant text at tool boundaries and keeps chronology", async () => {
    const { presenter, rendered } = setup();
    await presenter.append("Let me check.");
    await presenter.event({ type: "tool_call_started", id: "t1", name: "read_file" });
    await presenter.event({ type: "tool_call_completed", id: "t1", content: "data" });
    await presenter.append("Done: 42.");
    await presenter.finish("Let me check.Done: 42.");
    presenter.settle();

    const text = rendered();
    expect(text.indexOf("Let me check.")).toBeLessThan(text.indexOf("read_file"));
    expect(text.indexOf("read_file")).toBeLessThan(text.indexOf("Done: 42."));
    expect(text.match(/Let me check\./gu)?.length).toBe(1);
    expect(text.match(/Done: 42\./gu)?.length).toBe(1);
  });

  it("shows finalText exactly once when nothing streamed (finalOnly runs)", async () => {
    const { presenter, rendered } = setup();
    await presenter.finish("The complete answer.");
    presenter.settle();

    expect(rendered().match(/The complete answer\./gu)?.length).toBe(1);
  });

  it("collapses to finalText when the stream diverged", async () => {
    const { presenter, rendered } = setup();
    await presenter.append("partial garbage");
    await presenter.finish("Clean final answer.");
    presenter.settle();

    const text = rendered();
    expect(text).toContain("Clean final answer.");
    expect(text).not.toContain("partial garbage");
  });

  it("renders warnings and failover notices inline, with the cause", async () => {
    const { presenter, rendered, status } = setup();
    await presenter.event({ type: "runtime_warning", message: "context compaction imminent" });
    await presenter.event({
      type: "provider_status",
      kind: "failover_started",
      from: "gpt-5.5",
      to: "kimi",
      reason: "overloaded",
    });
    await presenter.event({ type: "provider_status", kind: "failover_completed", model: "kimi" });

    expect(rendered()).toContain("context compaction imminent");
    expect(rendered()).toContain("failover gpt-5.5 → kimi (overloaded)");
    // The router emits `model` as a modelKey string, so the completion note can
    // actually name the route that answered.
    expect(status()).toContain("answered by kimi");
  });

  it("omits the cause when the router could not classify it", async () => {
    const { presenter, rendered } = setup();
    await presenter.event({ type: "provider_status", kind: "failover_started", from: "a", to: "b" });

    expect(rendered()).toContain("failover a → b");
    expect(rendered()).not.toContain("(");
  });

  it("announces a same-model retry instead of a bogus failover-completed note", async () => {
    // retry_started must be handled explicitly: the trailing else in the
    // provider_status branch would otherwise render it as "answered by X".
    const { presenter, rendered, status } = setup();
    await presenter.event({
      type: "provider_status",
      kind: "retry_started",
      model: "gpt-5.5",
      attemptIndex: 0,
      retryIndex: 1,
      reason: "overloaded",
    });

    expect(rendered()).toContain("retrying gpt-5.5 (attempt 2, overloaded)");
    expect(status()).toContain("retrying gpt-5.5");
    expect(status()).not.toContain("answered by");
  });

  it("gives each subagent its own tool panel instead of merging identical tools", async () => {
    const { presenter, rendered } = setup();
    // Two subagents running Read concurrently. The panel map is keyed flatly on
    // the event id, so unnamespaced ids would collapse these into one panel.
    await presenter.event({ type: "tool_call_started", id: "agent:c1:t1", name: "alpha▸Read" });
    await presenter.event({ type: "tool_call_started", id: "agent:c2:t1", name: "beta▸Read" });
    await presenter.event({ type: "tool_call_completed", id: "agent:c1:t1", name: "alpha▸Read", content: "a body" });
    await presenter.event({ type: "tool_call_completed", id: "agent:c2:t1", name: "beta▸Read", content: "b body" });

    const text = rendered();
    expect(text).toContain("alpha▸Read");
    expect(text).toContain("beta▸Read");
  });

  it("no longer sets a 'waiting for <model>' ephemeral on request_started", async () => {
    const { presenter, status } = setup();

    await presenter.event({ type: "provider_status", kind: "request_started", model: "claude-fable-5" });

    expect(status()).not.toContain("waiting for");
  });

  it("still clears the ephemeral on request_completed (no-op when nothing was set)", async () => {
    const { presenter, status } = setup();

    await presenter.event({ type: "provider_status", kind: "request_started", model: "claude-fable-5" });
    await presenter.status("Thinking…");
    await presenter.event({ type: "provider_status", kind: "request_completed", model: "claude-fable-5" });

    expect(status()).not.toContain("Thinking…");
    expect(status()).not.toContain("waiting for");
  });

  it("ignores unknown event types (forward compatibility)", async () => {
    const { presenter, rendered } = setup();
    await presenter.event({ type: "quantum_flux", level: 9 } as never);
    await presenter.append("still fine");
    presenter.settle();

    expect(rendered()).toContain("still fine");
  });

  it("surfaces stream status and memory recall on the status bar", async () => {
    const { presenter, status } = setup();
    await presenter.status("Thinking…");
    expect(status()).toContain("Thinking…");
    await presenter.event({ type: "memory_recalled", source: "bujo", bytes: 2048 });
    expect(status()).toContain("memory recalled 2.0KB");
  });

  it("applies run_config telemetry (model + effort) to the status bar", async () => {
    const { presenter, status } = setup();
    await presenter.event({
      type: "runtime_telemetry",
      kind: "run_config",
      data: { model: "claude-fable-5", effort: "high", overridden: false, timestamp: "2026-01-01T00:00:00.000Z" },
    });
    const text = status();
    expect(text).toContain("claude-fable-5");
    expect(text).toContain("effort:high");
  });

  it("renders session boundary telemetry as a compact transcript notice", async () => {
    const { presenter, status, rendered } = setup();
    await presenter.event({
      type: "runtime_telemetry",
      kind: "session_boundary",
      data: {
        type: "session_boundary",
        kind: "rollover",
        previousConversationId: "telegram:42#2026-07-05",
        conversationId: "telegram:42#2026-07-06",
        reason: "daily_rollover",
      },
    });

    const text = rendered();
    const normalized = text.replace(/\s+/gu, " ");
    expect(text).toContain("session boundary: rollover");
    expect(text).toContain("daily rollover");
    expect(normalized).toContain("telegram:42#2026-07-05 -> telegram:42#2026-07-06");
    expect(status()).not.toContain("effort:");
  });

  it("recognizes sparse session boundary telemetry by payload kind or type without leaking raw data", async () => {
    const byPayloadKind = setup();
    await byPayloadKind.presenter.event({
      type: "runtime_telemetry",
      kind: "runtime_event",
      data: { kind: "session_boundary" },
    });
    expect(byPayloadKind.rendered()).toContain("session boundary");
    expect(byPayloadKind.rendered()).not.toContain("runtime_event");
    expect(byPayloadKind.rendered()).not.toContain("{");

    const byPayloadType = setup();
    await byPayloadType.presenter.event({
      type: "runtime_telemetry",
      kind: "runtime_event",
      data: { type: "session_boundary" },
    });
    expect(byPayloadType.rendered()).toContain("session boundary");
    expect(byPayloadType.rendered()).not.toContain("runtime_event");
    expect(byPayloadType.rendered()).not.toContain("{");
  });

  it("keeps session boundary notices chronologically between streamed text segments", async () => {
    const { presenter, rendered } = setup();
    await presenter.append("before boundary.");
    await presenter.event({
      type: "runtime_telemetry",
      kind: "session_boundary",
      data: { kind: "isolated", reason: "model_override" },
    });
    await presenter.append("after boundary.");
    await presenter.finish("before boundary.after boundary.");
    presenter.settle();

    const text = rendered();
    expect(text.indexOf("before boundary.")).toBeLessThan(text.indexOf("session boundary: isolated"));
    expect(text.indexOf("session boundary: isolated")).toBeLessThan(text.indexOf("after boundary."));
    expect(text.match(/before boundary\./gu)?.length).toBe(1);
    expect(text.match(/after boundary\./gu)?.length).toBe(1);
  });

  it("ignores non run_config/session_boundary runtime_telemetry kinds (no transcript, no status bar change)", async () => {
    const { presenter, status, rendered } = setup();
    await presenter.event({ type: "runtime_telemetry", kind: "cache_hit", data: { tokens: 400 } });
    expect(rendered()).toBe("");
    expect(status()).not.toContain("effort:");
  });

  it("does not clear a previously known effort when a later run_config omits it", async () => {
    const { presenter, status } = setup();
    await presenter.event({ type: "runtime_telemetry", kind: "run_config", data: { effort: "high" } });
    expect(status()).toContain("effort:high");
    await presenter.event({ type: "runtime_telemetry", kind: "run_config", data: { model: "claude-fable-5" } });
    expect(status()).toContain("effort:high");
    expect(status()).toContain("claude-fable-5");
  });

  it("tags the model as (override) when run_config reports overridden:true", async () => {
    const { presenter, status } = setup();
    await presenter.event({
      type: "runtime_telemetry",
      kind: "run_config",
      data: { model: "kimi-k2.6", overridden: true },
    });
    expect(status()).toContain("kimi-k2.6 (override)");
  });

  it("clears the (override) tag and notices when a requested override was not applied", async () => {
    const { presenter, status, rendered } = setup(undefined, { requestedModelOverride: "kimi-k2.6" });
    await presenter.event({
      type: "runtime_telemetry",
      kind: "run_config",
      data: { model: "claude-fable-5", overridden: false },
    });
    expect(status()).toContain("claude-fable-5");
    expect(status()).not.toContain("(override)");
    expect(rendered()).toContain("model override not applied");
    expect(rendered()).toContain("claude-fable-5");
  });

  it("does not notice on overridden:false when no override was requested", async () => {
    const { presenter, status, rendered } = setup();
    await presenter.event({
      type: "runtime_telemetry",
      kind: "run_config",
      data: { model: "claude-fable-5", overridden: false },
    });
    expect(status()).not.toContain("(override)");
    expect(rendered()).not.toContain("not applied");
  });

  it("accumulates thinking chars on the status bar while active", async () => {
    const { presenter, status } = setup();
    await presenter.event({ type: "assistant_thought", text: "12345" });
    expect(status()).toContain(`∴ thinking ${formatTokens(5)}`);
    await presenter.event({ type: "assistant_thought", text: "67890" });
    expect(status()).toContain(`∴ thinking ${formatTokens(10)}`);
  });

  it("finalizes thinking duration (via injected clock) when the thinking cell is sealed by a tool call", async () => {
    let clock = 1_000;
    const { presenter, status, rendered } = setup(() => clock);
    await presenter.event({ type: "assistant_thought", text: "12345" }); // 5 chars, t=1000
    clock = 42_000; // +41s
    await presenter.event({ type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } });

    const expectedDuration = formatDurationMs(41_000);
    expect(status()).toContain(`∴ ${formatTokens(5)} chars · ${expectedDuration}`);
    expect(status()).not.toContain("thinking 5"); // no longer "active"
    // The sealed ThinkingCell header also carries the duration.
    expect(rendered()).toContain(`thought (${formatTokens(5)} chars · ${expectedDuration}`);
  });

  it("accumulates chars and spans first-thought-to-last-seal duration across multiple thinking cells in one turn", async () => {
    let clock = 0;
    const { presenter, status } = setup(() => clock);
    await presenter.event({ type: "assistant_thought", text: "aaaaa" }); // 5 chars, t=0 (first thought)
    clock = 5_000;
    await presenter.event({ type: "tool_call_started", id: "t1", name: "bash", arguments: {} });
    await presenter.event({ type: "tool_call_completed", id: "t1", content: "ok" });
    clock = 10_000;
    await presenter.event({ type: "assistant_thought", text: "bbbbbbbbbb" }); // +10 chars = 15 total
    clock = 20_000; // last seal at t=20000; duration = 20000 - 0 = 20000ms
    presenter.settle();

    const expectedDuration = formatDurationMs(20_000);
    expect(status()).toContain(`∴ ${formatTokens(15)} chars · ${expectedDuration}`);
  });

  it("shows chars+duration on the ThinkingCell header after settle finalizes it", async () => {
    let clock = 0;
    const { presenter, rendered } = setup(() => clock);
    await presenter.event({ type: "assistant_thought", text: "reasoning text here" }); // 19 chars
    clock = 3_500;
    presenter.settle();

    expect(rendered()).toContain(`thought (${formatTokens(19)} chars · ${formatDurationMs(3_500)}`);
  });

  it("replaces the status bar's thinking segment on a new turn's first thought (fresh presenter per turn)", async () => {
    let clock = 0;
    const statusBar = new StatusBar();
    const transcript = new Container();
    const firstTurn = new TurnPresenter({
      transcript,
      statusBar,
      requestRender: () => {},
      flushIntervalMs: 0,
      now: () => clock,
    });
    await firstTurn.event({ type: "assistant_thought", text: "a".repeat(100) });
    clock = 10_000;
    firstTurn.settle();
    const afterFirstTurn = stripAnsi(statusBar.render(80).join("\n"));
    expect(afterFirstTurn).toContain(`∴ ${formatTokens(100)} chars`);

    // A new turn gets a brand-new presenter (ChatView's pattern); its counters
    // start fresh rather than adding onto the previous turn's totals.
    const secondTurn = new TurnPresenter({
      transcript: new Container(),
      statusBar,
      requestRender: () => {},
      flushIntervalMs: 0,
      now: () => clock,
    });
    await secondTurn.event({ type: "assistant_thought", text: "bb" });
    const afterSecondTurnFirstThought = stripAnsi(statusBar.render(80).join("\n"));
    expect(afterSecondTurnFirstThought).toContain(`∴ thinking ${formatTokens(2)}`);
    expect(afterSecondTurnFirstThought).not.toContain(`${formatTokens(100)} chars`);
  });
});

describe("TurnPresenter subagent panels", () => {
  const launch = (id: string, name: string) => ({
    type: "tool_call_started" as const,
    id,
    name: "Agent",
    arguments: { name, prompt: "find X" },
  });
  const bookend = (id: string, name: string) => ({
    type: "tool_call_started" as const,
    id: `agent:${id}`,
    name: `Agent(${name})`,
    arguments: { name, prompt: "find X" },
    metadata: { subagent: { id, name, callIndex: 0 }, synthetic: true, subagentLifecycle: true },
  });
  const childCall = (id: string, name: string, toolId: string, tool: string, args: unknown) => ({
    type: "tool_call_started" as const,
    id: `agent:${id}:${toolId}`,
    name: `${name}▸${tool}`,
    arguments: args,
    metadata: { subagent: { id, name, callIndex: 0 }, synthetic: true },
  });

  it("nests a subagent's tool calls under its Agent panel without duplicating it for the bookend", async () => {
    const { presenter, rendered, transcript } = setup();

    await presenter.event(launch("call-1", "researcher"));
    await presenter.event(bookend("call-1", "researcher"));
    expect(transcript.children).toHaveLength(1);
    await presenter.event(childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }));
    presenter.settle();

    const lines = rendered().split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Agent");
    // The profile already names the panel above, so the `researcher▸` prefix is
    // dropped and the call is indented past its parent.
    expect(lines[1]).toContain("Read");
    expect(lines[1]).not.toContain("researcher▸");
    expect(indentOf(lines[1] ?? "")).toBeGreaterThan(indentOf(lines[0] ?? ""));
    // The lifecycle bookend must not become a second panel.
    expect(rendered()).not.toContain("Agent(researcher)");
  });

  it("keeps a background Agent panel running until its lifecycle terminal arrives", async () => {
    const { presenter, rendered } = setup();
    const subagent = { id: "call-1", nativeId: "native-1", name: "researcher", callIndex: 0 };

    await presenter.event(launch("call-1", "researcher"));
    await presenter.event({
      type: "tool_call_started",
      id: "agent:call-1",
      name: "Agent(researcher)",
      metadata: { subagent, synthetic: true, subagentLifecycle: true },
    });
    await presenter.event(childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }));

    expect(rendered()).toContain("◐ Agent");
    expect(rendered()).not.toContain("✓ Agent");

    await presenter.event({
      type: "tool_call_completed",
      id: "agent:call-1",
      name: "Agent(researcher)",
      content: "Review complete",
      metadata: { subagent, synthetic: true, subagentLifecycle: true },
    });
    presenter.settle();

    expect(rendered()).toContain("✓ Agent");
    expect(rendered()).toContain("Review complete");
    expect(rendered()).not.toContain("◐ Agent");
  });

  it("creates and settles the canonical Agent panel from lifecycle bookends alone", async () => {
    const { presenter, rendered, transcript } = setup();
    const canonicalId = "codex-spawn-1";
    const subagent = { id: canonicalId, name: "codex", callIndex: 0 };

    // Codex-native delegation can begin with only agent_started: there is no
    // ordinary parent Agent tool event to create the transcript panel first.
    await presenter.event(bookend(canonicalId, "codex"));
    expect(transcript.children).toHaveLength(1);
    expect(rendered()).toContain("◐ Agent");

    await presenter.event(childCall(canonicalId, "codex", "read-1", "Read", {
      file_path: "/repo/a.ts",
    }));
    await presenter.event({
      type: "tool_call_completed",
      id: `agent:${canonicalId}`,
      name: "Agent(codex)",
      content: "done",
      executionMs: 125,
      metadata: { subagent, synthetic: true, subagentLifecycle: true },
    });
    presenter.settle();

    const lines = rendered().split("\n").filter((line) => line.trim().length > 0);
    expect(transcript.children).toHaveLength(1);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("✓ Agent");
    expect(lines[0]).toContain("125ms");
    expect(lines[1]).toContain("done");
    expect(lines[2]).toContain("Read");
    expect(indentOf(lines[2] ?? "")).toBeGreaterThan(indentOf(lines[0] ?? ""));
  });

  it("attaches native activity to the canonical parent id when the provider task id differs", async () => {
    const { presenter, rendered } = setup();
    const canonicalId = "toolu_parent";
    const nativeId = "provider-task-42";
    const subagent = {
      id: canonicalId,
      nativeId,
      name: "researcher",
      callIndex: 0,
      agentPath: "root/researcher",
    };

    await presenter.event(launch(canonicalId, "researcher"));
    await presenter.event({
      type: "tool_call_started",
      id: `agent:${canonicalId}`,
      name: "Agent(researcher)",
      metadata: { subagent, synthetic: true, subagentLifecycle: true },
    });
    await presenter.event({
      type: "tool_call_started",
      id: `agent:${canonicalId}:read-1`,
      name: "researcher▸Read",
      arguments: { file_path: "/repo/a.ts" },
      metadata: { subagent, synthetic: true },
    });
    await presenter.event({
      type: "tool_call_completed",
      id: `agent:${canonicalId}`,
      name: "Agent(researcher)",
      content: "done",
      metadata: { subagent, synthetic: true, subagentLifecycle: true },
    });
    presenter.settle();

    const text = rendered();
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("✓ Agent");
    expect(lines[1]).toContain("done");
    expect(lines[2]).toContain("Read");
    expect(indentOf(lines[2] ?? "")).toBeGreaterThan(indentOf(lines[0] ?? ""));
    expect(text).not.toContain(nativeId);
  });

  it("keeps concurrent subagents' calls under their own parents", async () => {
    const { presenter, rendered } = setup();

    await presenter.event(launch("a", "researcher"));
    await presenter.event(launch("b", "reviewer"));
    // Interleaved: appending each child at the transcript tail would shuffle
    // both agents' work into one list.
    await presenter.event(childCall("a", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }));
    await presenter.event(childCall("b", "reviewer", "t2", "Grep", { pattern: "x" }));
    await presenter.event(childCall("a", "researcher", "t3", "Glob", { pattern: "*.ts" }));
    presenter.settle();

    const lines = rendered().split("\n").filter((line) => line.trim().length > 0);
    expect(lines.map((line) => line.trim().split(/\s+/u)[1])).toEqual([
      "Agent", "Read", "Glob", "Agent", "Grep",
    ]);
  });

  it("completes a nested panel from its own completion event", async () => {
    const { presenter, rendered } = setup();

    await presenter.event(launch("call-1", "researcher"));
    await presenter.event(childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }));
    await presenter.event({
      type: "tool_call_completed",
      id: "agent:call-1:t1",
      name: "researcher▸Read",
      isError: true,
      executionMs: 12,
    });
    presenter.settle();

    expect(rendered()).toContain("✗ Read");
  });

  it("falls back to a top-level panel when the parent Agent call was never seen", async () => {
    const { presenter, rendered } = setup();

    await presenter.event(childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }));
    presenter.settle();

    // Orphaned activity is still shown, keeping its profile prefix since no
    // parent panel names the agent it came from.
    expect(rendered()).toContain("researcher▸Read");
  });

  it("ignores malformed subagent metadata instead of keying a panel on it", async () => {
    const { presenter, rendered, transcript } = setup();

    await presenter.event({
      type: "tool_call_started",
      id: "t1",
      name: "Read",
      arguments: { file_path: "/repo/a.ts" },
      metadata: { subagent: { id: 42 }, synthetic: true },
    });
    presenter.settle();

    expect(transcript.children).toHaveLength(1);
    expect(rendered()).toContain("Read");
  });
});

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}
