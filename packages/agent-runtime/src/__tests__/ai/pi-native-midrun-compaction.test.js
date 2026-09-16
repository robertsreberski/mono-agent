// Mid-run (checkpoint) compaction on the pi-native bridge.
//
// The first block drives the REAL AgentHarness through pi-ai's `fauxProvider`,
// so Pi's own checkpoint scheduling, `before_compaction` hook dispatch and
// durable commit all run: the only scripted part is the provider. That is the
// only way to prove the trigger fires BETWEEN tool/model rounds rather than once
// before the request.
//
// The second block drives the controller directly with a harness double to pin
// the cost guards (one attempt in flight, one evaluation per round, required
// fresh assistant progress and growth) without paying for four faux runs.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { shouldCompact } from "@earendil-works/pi-agent-core";
import { runReactiveCompaction } from "../../ai/providers/pi-native/compaction-driver.js";
import { generatePiNativeResponse } from "../../ai/providers/pi-native.js";
import {
  createMidRunCompaction,
  midRunBaselineAdjustment,
  midRunReserveTokens,
} from "../../ai/providers/pi-native/mid-run-compaction.js";
import { buildPiSessionContext } from "../../ai/providers/pi-native/harness-adapter.js";

// 30k characters ≈ 7.5k estimated tokens: two of these cross a 14k trigger, and
// neither one alone is large enough to make the retained tail unsummarizable.
const BULK = "lorem ipsum dolor sit amet ".repeat(1_600).slice(0, 40_000);

function fauxSetup(modelDef = {}) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", contextWindow: 30_000, maxTokens: 8_000, ...modelDef }],
    tokensPerSecond: undefined,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}

function runOptions({ model, models }, overrides = {}) {
  return {
    model: { provider: model.provider, model: model.id, reference: `${model.provider}:${model.id}` },
    piResolvedModel: model,
    piResolvedModels: models,
    effort: "none",
    allowedTools: [],
    ...overrides,
  };
}

describe("pi-native mid-run compaction (real harness)", () => {
  it("compacts between tool rounds once the growing transcript crosses the trigger", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-midrun-"));
    writeFileSync(join(root, "notes.txt"), "notes\n");
    try {
      const setup = fauxSetup();
      const summaryPrompts = [];
      setup.faux.setResponses([
        fauxAssistantMessage([fauxText(BULK), fauxToolCall("Read", { file_path: "notes.txt" }, { id: "call-1" })]),
        fauxAssistantMessage([fauxText(BULK), fauxToolCall("Read", { file_path: "notes.txt" }, { id: "call-2" })]),
        (context) => {
          summaryPrompts.push(context);
          return fauxAssistantMessage([fauxText("## Goal\nSummarized earlier rounds.")]);
        },
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const events = [];
      const recorded = [];

      const result = await generatePiNativeResponse("system", runOptions(setup, {
        cwd: root,
        allowedTools: ["Read"],
        messages: [{ role: "user", content: "read the notes twice" }],
        onEvent: (event) => events.push(event),
        onCompactionRecorded: (row) => recorded.push(row),
        runId: "run-midrun",
      }));

      expect(result.error).toBeNull();
      expect(result.text).toBe("done");

      // Exactly one compaction, and it is a summary request issued INSIDE the
      // prompt: two assistant rounds + one summary + the final assistant.
      const compactionEvents = events.filter((event) => event?.type === "context_compaction");
      expect(compactionEvents.map((event) => event.status)).toEqual(["running", "succeeded"]);
      expect(compactionEvents[0].trigger).toBe("proactive");
      expect(compactionEvents[1].accounting.midRun).toBe(true);
      expect(compactionEvents[1].tokensAfter).toBeLessThan(compactionEvents[1].tokensBefore);
      expect(summaryPrompts).toHaveLength(1);
      expect(setup.faux.state.callCount).toBe(4);
      expect(recorded).toEqual([expect.objectContaining({
        trigger: "proactive",
        provider_kind: "pi",
        task_run_id: "run-midrun",
        status: "succeeded",
      })]);

      // The compaction happened mid-prompt, so it must not have been reported as
      // the pre-request proactive pass and must not have started a second run.
      expect(result.capabilitiesUsed.context_compaction_applied).toBe(true);
      expect(events.filter((event) => event?.type === "provider_request_started")).toHaveLength(1);
      expect((result.runtimeWarnings || []).map((warning) => warning.warning_kind))
        .not.toContain("live_input_correlation_invalid");

      // Accounting: the first round's assistant message was summarized out of
      // the transcript, but its tokens were still billed to this run. Both
      // bulk outputs (~7.5k estimated tokens each) must still be accounted for.
      expect(result.usage.output_tokens).toBeGreaterThan(19_000);
      expect(result.usage.cache_write_tokens).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not compact when the run stays below the trigger", async () => {
    const setup = fauxSetup();
    setup.faux.setResponses([
      fauxAssistantMessage([fauxText("short answer")]),
    ]);
    const events = [];

    const result = await generatePiNativeResponse("system", runOptions(setup, {
      messages: [{ role: "user", content: "hello" }],
      onEvent: (event) => events.push(event),
    }));

    expect(result.error).toBeNull();
    expect(events.filter((event) => event?.type === "context_compaction")).toHaveLength(0);
    expect(setup.faux.state.callCount).toBe(1);
    expect(result.capabilitiesUsed.context_compaction_applied).toBe(false);
  }, 30_000);

  it("leaves the run consistent when an abort lands during a mid-run compaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-midrun-abort-"));
    writeFileSync(join(root, "notes.txt"), "notes\n");
    try {
      const setup = fauxSetup();
      const controller = new AbortController();
      setup.faux.setResponses([
        fauxAssistantMessage([fauxText(BULK), fauxToolCall("Read", { file_path: "notes.txt" }, { id: "call-1" })]),
        fauxAssistantMessage([fauxText(BULK), fauxToolCall("Read", { file_path: "notes.txt" }, { id: "call-2" })]),
        // The summary request is the compaction's only provider call: aborting
        // while it is in flight is the worst-case moment for a half-applied
        // transcript mutation.
        () => {
          controller.abort();
          return fauxAssistantMessage([fauxText("never used")]);
        },
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const events = [];

      const result = await generatePiNativeResponse("system", runOptions(setup, {
        cwd: root,
        allowedTools: ["Read"],
        messages: [{ role: "user", content: "read the notes twice" }],
        onEvent: (event) => events.push(event),
        abortSignal: controller.signal,
      }));

      expect(result.cancelled).toBe(true);
      // Nothing was committed, so the run never reports a compaction it did not
      // finish, and no summary leaked into the reported transcript.
      expect(result.capabilitiesUsed.context_compaction_applied).toBe(false);
      const compactionEvents = events.filter((event) => event?.type === "context_compaction");
      expect(compactionEvents.map((event) => event.status)).toEqual(["running", "failed"]);
      expect(compactionEvents.some((event) => event.status === "succeeded")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

// --- Controller-level guards -------------------------------------------------

function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistantMessage(text, usage) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux",
    provider: "faux",
    model: "m",
    stopReason: "stop",
    timestamp: 1,
    usage: usage || {
      input: 100, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 300,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    },
  };
}

function entriesFor(messages) {
  return messages.map((message, index) => ({
    type: "message",
    id: `e${index + 1}`,
    parentId: index === 0 ? null : `e${index}`,
    timestamp: index + 1,
    message,
  }));
}

function controllerFixture({ policy: policyOverrides = {}, summary = "## Goal\nshort summary" } = {}) {
  const policy = {
    enabled: true,
    contextWindow: 100_000,
    triggerTokens: 20_000,
    keepRecentTokens: 4_000,
    summaryMaxTokens: 2_000,
    compactionMinSavingsTokens: 4_000,
    fixedOverheadEnabled: true,
    ...policyOverrides,
  };
  const model = { id: "m", provider: "faux", api: "faux", contextWindow: 100_000, maxTokens: 8_000, reasoning: false };
  const completeSimple = vi.fn(async () => ({
    role: "assistant",
    content: [{ type: "text", text: summary }],
    stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
  }));
  /** @type {Array<(event: any) => void>} */
  const subscribers = [];
  /** @type {Array<(event: any) => any>} */
  const hooks = [];
  const settings = [];
  let midRunArmed = false;
  const harness = {
    models: { completeSimple, getModel: () => model },
    getModel: () => model,
    getThinkingLevel: () => "off",
    waitForIdle: vi.fn(),
    prompt: vi.fn(),
    compact: vi.fn(async () => {
      const entries = entriesFor(transcript);
      const result = await hooks.at(-1)?.({
        reason: "manual", branchEntries: entries, signal: new AbortController().signal,
      });
      if (!result?.compaction) throw new Error("Compaction cancelled");
      commitCompaction(entries, result.compaction);
      return result.compaction;
    }),
    setCompactionSettings: vi.fn(async (value) => { settings.push(value); }),
    setMidRunCompactionArmed: (value) => { midRunArmed = value; },
    on: (type, handler) => {
      expect(type).toBe("session_before_compact");
      hooks.push(handler);
      return () => hooks.splice(hooks.indexOf(handler), 1);
    },
    subscribe: (listener) => {
      subscribers.push(listener);
      return () => subscribers.splice(subscribers.indexOf(listener), 1);
    },
  };
  const runState = {
    session: { buildContext: async () => ({ messages: [...transcript] }) },
    sessionBaselineCount: 0,
    compaction: {
      applied: false,
      reactiveAttempted: false,
      compactedThisRun: false,
      policy,
      diagnostics: { context_fixed_overhead_tokens: 500, context_user_message_tokens: 100 },
      carriedUsage: null,
      carriedUsageMeasured: false,
    },
  };
  const events = [];
  const runtimeWarnings = [];
  const recorded = [];
  /** @type {Array<any>} */
  const transcript = [];
  function commitCompaction(entries, compaction) {
    const committed = {
      type: "compaction",
      id: `c${transcript.length}`,
      parentId: entries.at(-1)?.id || null,
      timestamp: Date.now(),
      ...compaction,
      fromHook: true,
    };
    const rebuilt = buildPiSessionContext([...entries, committed], { includeFailed: true });
    transcript.splice(0, transcript.length, ...rebuilt);
  }
  const controller = createMidRunCompaction(runState, {
    harness,
    options: { onCompactionRecorded: (row) => recorded.push(row), runId: "r1" },
    reference: "faux:m",
    onEvent: (event) => events.push(event),
    runtimeWarnings,
  });
  return {
    controller,
    harness,
    runState,
    events,
    runtimeWarnings,
    recorded,
    completeSimple,
    settings,
    isArmed: () => midRunArmed,
    hookCount: () => hooks.length,
    summaryRequests: () => completeSimple.mock.calls.length,
    transcript: () => [...transcript],
    append(...messages) {
      transcript.push(...messages);
    },
    setTranscript(messages) {
      transcript.splice(0, transcript.length, ...messages);
    },
    // Simulate one Pi checkpoint: dispatch the before_compaction hook and, when
    // the bridge supplied a compaction, the durable commit Pi performs next —
    // the transcript really is replaced by [summary, ...retainedTail].
    async checkpoint({ reason = "threshold", status = "completed" } = {}) {
      const entries = entriesFor(transcript);
      const result = await hooks[0]?.({
        reason,
        branchEntries: entries,
        signal: new AbortController().signal,
      });
      if (result?.compaction !== undefined) {
        if (status === "completed") {
          commitCompaction(entries, result.compaction);
        }
        for (const listener of subscribers) {
          listener({ type: "compaction_end", lane: "main", reason: "threshold", status, entryId: "c1" });
        }
      }
      return result;
    },
  };
}

// Three bulky earlier messages plus a small tail: the cut keeps the tail and
// summarizes the rest, which is the shape a long tool-using run reaches.
function growingTranscript(rounds) {
  const messages = [userMessage("start")];
  for (let index = 0; index < rounds; index += 1) {
    messages.push(assistantMessage(`round ${index} ${"x".repeat(40_000)}`));
    messages.push(userMessage(`follow up ${index}`));
  }
  return messages;
}

describe("mid-run compaction guards", () => {
  it("stays silent below the trigger and never pays for a summary", async () => {
    const fixture = controllerFixture();
    expect(await fixture.controller.arm()).toBe(true);
    fixture.setTranscript([userMessage("small"), assistantMessage("tiny")]);

    const result = await fixture.checkpoint();

    expect(result).toEqual({ cancel: true });
    expect(fixture.completeSimple).not.toHaveBeenCalled();
    expect(fixture.events).toHaveLength(0);
    expect(fixture.runtimeWarnings).toHaveLength(0);
    expect(fixture.runState.compaction.applied).toBe(false);
  });

  it("compacts once, then requires fresh assistant progress and growth before paying again", async () => {
    const fixture = controllerFixture();
    await fixture.controller.arm();
    fixture.setTranscript(growingTranscript(2));

    const first = await fixture.checkpoint();
    expect(first.compaction).toBeDefined();
    expect(fixture.summaryRequests()).toBeGreaterThan(0);
    expect(fixture.runState.compaction.applied).toBe(true);
    expect(fixture.runState.compaction.compactedThisRun).toBe(true);
    expect(fixture.events.map((event) => event.status)).toEqual(["running", "succeeded"]);
    expect(fixture.recorded).toHaveLength(1);
    const afterFirst = fixture.summaryRequests();

    // The very next checkpoint (no new assistant message): no second summary.
    await fixture.checkpoint();
    expect(fixture.summaryRequests()).toBe(afterFirst);

    // A new assistant message that adds only a little context: still no summary.
    fixture.append(assistantMessage("a bit more"));
    await fixture.checkpoint();
    expect(fixture.summaryRequests()).toBe(afterFirst);
    expect(fixture.controller.stats.attempts).toBe(1);

    // Real additional growth plus a new assistant message: one more attempt.
    fixture.append(assistantMessage(`later ${"y".repeat(160_000)}`), userMessage("and next"));
    await fixture.checkpoint();
    expect(fixture.summaryRequests()).toBeGreaterThan(afterFirst);
    expect(fixture.controller.stats.attempts).toBe(2);
    expect(fixture.controller.stats.applied).toBe(2);
  });

  it.each([
    ["fresh", 0, false],
    ["slightly grown", 100, false],
    ["stale", 40_000, true],
  ])("preserves one-shot overflow recovery after a %s mid-run compaction", async (_label, growth, shouldRecover) => {
    const fixture = controllerFixture();
    await fixture.controller.arm();
    fixture.setTranscript(growingTranscript(2));
    await fixture.checkpoint();
    expect(fixture.controller.stats.applied).toBe(1);
    expect(fixture.runState.compaction.compactedThisRun).toBe(true);
    await fixture.controller.disarm();

    // More rounds can accumulate before a provider with a lower real ceiling
    // rejects the next request. No new checkpoint compaction has committed.
    if (growth) fixture.append(assistantMessage("x".repeat(growth)), userMessage("continue"));
    const overflow = { stopReason: "error", lastAssistant: { errorMessage: "context length exceeded, too many tokens" } };
    const recovered = { stopReason: "endTurn" };
    const captureState = vi.fn(async () => recovered);
    const params = {
      harness: fixture.harness, runtime: {}, resolved: { reference: `faux:midrun-${growth}` },
      options: {}, promptText: "continue", promptImages: [], reference: "faux:m",
      onEvent: (event) => fixture.events.push(event), runtimeWarnings: fixture.runtimeWarnings,
      state: overflow, runError: null, captureState,
    };
    const result = await runReactiveCompaction(fixture.runState, params);
    expect(fixture.runState.compaction.reactiveAttempted).toBe(true);
    expect(fixture.harness.compact).toHaveBeenCalledTimes(shouldRecover ? 1 : 0);
    expect(fixture.harness.prompt).toHaveBeenCalledTimes(shouldRecover ? 1 : 0);
    expect(captureState).toHaveBeenCalledTimes(shouldRecover ? 1 : 0);
    expect(result.state).toBe(shouldRecover ? recovered : overflow);
    if (shouldRecover) {
      expect(fixture.runState.compaction.diagnostics.context_compaction_reduced).toBe(true);
      expect(fixture.events.at(-1)).toMatchObject({ status: "succeeded", trigger: "overflow" });
    }
    // A second overflow cannot buy another summary or re-prompt.
    await runReactiveCompaction(fixture.runState, params);
    expect(fixture.harness.compact).toHaveBeenCalledTimes(shouldRecover ? 1 : 0);
    expect(fixture.harness.prompt).toHaveBeenCalledTimes(shouldRecover ? 1 : 0);
  });

  it("requires additional growth after a skipped attempt instead of re-paying each round", async () => {
    // A summary as large as the history it replaces: the projection allows the
    // attempt, but the rebuilt-context preview proves it saves nothing.
    const fixture = controllerFixture({ summary: "s".repeat(200_000) });
    await fixture.controller.arm();
    fixture.setTranscript(growingTranscript(2));

    await fixture.checkpoint();
    const afterFirst = fixture.summaryRequests();
    expect(afterFirst).toBeGreaterThan(0);
    expect(fixture.runState.compaction.applied).toBe(false);
    expect(fixture.runtimeWarnings.map((warning) => warning.warning_kind))
      .toEqual(["context_compaction_not_reducible"]);
    expect(fixture.events.map((event) => event.status)).toEqual(["running", "skipped"]);

    fixture.append(assistantMessage("nothing much"));
    await fixture.checkpoint();
    expect(fixture.summaryRequests()).toBe(afterFirst);
  });

  it("does not pay for a summary when the retained tail already holds the context", async () => {
    const fixture = controllerFixture();
    await fixture.controller.arm();

    // One huge trailing message: Pi's cut keeps it, so nothing worth
    // summarizing remains and no summary request may be issued.
    fixture.setTranscript([userMessage("start"), assistantMessage("bulk " + "z".repeat(200_000))]);
    await fixture.checkpoint();

    expect(fixture.summaryRequests()).toBe(0);
    expect(fixture.events).toHaveLength(0);
    expect(fixture.runtimeWarnings.map((warning) => warning.warning_kind))
      .toEqual(["context_compaction_midrun_ineffective"]);
    expect(fixture.runState.compaction.applied).toBe(false);
  });

  it("ignores compaction requests that are not Pi's in-run threshold task", async () => {
    const fixture = controllerFixture();
    await fixture.controller.arm();

    // `undefined` defers to the next registered hook (the manual tryCompact
    // path) instead of accepting or declining on its behalf.
    fixture.setTranscript(growingTranscript(2));
    expect(await fixture.checkpoint({ reason: "manual" })).toBeUndefined();
    expect(fixture.completeSimple).not.toHaveBeenCalled();
  });

  it("never applies the accounting for a compaction Pi did not commit", async () => {
    const fixture = controllerFixture();
    await fixture.controller.arm();

    fixture.setTranscript(growingTranscript(2));
    await fixture.checkpoint({ status: "declined" });

    expect(fixture.runState.compaction.applied).toBe(false);
    expect(fixture.runState.sessionBaselineCount).toBe(0);
    expect(fixture.runState.compaction.carriedUsage).toBeNull();
    expect(fixture.events.map((event) => event.status)).toEqual(["running", "failed"]);
  });

  it("disarms back to Pi's compaction-disabled default", async () => {
    const fixture = controllerFixture();
    await fixture.controller.arm();
    expect(fixture.isArmed()).toBe(true);

    await fixture.controller.disarm();

    expect(fixture.isArmed()).toBe(false);
    expect(fixture.settings.at(-1)).toEqual({ enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 });
    // The decision hook is gone, so Pi's owner hook declines every later
    // threshold task on its own.
    expect(fixture.hookCount()).toBe(0);
    expect(fixture.summaryRequests()).toBe(0);
  });

  it("does not arm when the trigger cannot be expressed inside the provider window", async () => {
    const fixture = controllerFixture({ policy: { contextWindow: 400_000, triggerTokens: 280_000 } });

    expect(await fixture.controller.arm()).toBe(false);
    expect(fixture.runtimeWarnings.map((warning) => warning.warning_kind))
      .toEqual(["context_compaction_midrun_unavailable"]);
  });
});

describe("mid-run transcript accounting", () => {
  it("maps Pi's reserve so its checkpoint fires exactly at this bridge's trigger", () => {
    // Pi fires when tokens > window - reserve (strict), the bridge when
    // tokens + overhead >= trigger.
    expect(midRunReserveTokens(272_000, 190_400, 5_000)).toBe(272_000 - 185_400 + 1);
    expect(midRunReserveTokens(100_000, 190_400, 0)).toBeNull();
    expect(midRunReserveTokens(0, 10, 0)).toBeNull();
  });

  it("accepts reserve 1 when the transcript trigger equals Pi's window", async () => {
    const reserveTokens = midRunReserveTokens(100_000, 100_400, 400);
    expect(reserveTokens).toBe(1);
    const settings = { enabled: true, reserveTokens, keepRecentTokens: 4_000 };
    expect(shouldCompact(99_999, 100_000, settings)).toBe(false);
    expect(shouldCompact(100_000, 100_000, settings)).toBe(true);
    const fixture = controllerFixture({ policy: { triggerTokens: 100_400 } });
    expect(await fixture.controller.arm()).toBe(true);
    expect(fixture.settings[0].reserveTokens).toBe(1);
    expect(fixture.runtimeWarnings).toHaveLength(0);
    await fixture.controller.disarm();
  });

  it("re-anchors the baseline and carries the usage of run-owned messages that were summarized away", () => {
    const seeded = [userMessage("older history")];
    const runOwned = [
      userMessage("this run's prompt"),
      assistantMessage("first round", {
        input: 1_000, output: 2_000, cacheRead: 3, cacheWrite: 4, totalTokens: 3_007,
        cost: { total: 0.25 },
      }),
      assistantMessage("second round", {
        input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0.01 },
      }),
    ];
    const contextBefore = [...seeded, ...runOwned];

    // Pi retained only the last message; everything before it is summarized.
    const adjustment = midRunBaselineAdjustment(contextBefore, 1, 1);

    expect(adjustment.baselineAfter).toBe(1);
    expect(adjustment.lostMessages).toEqual(contextBefore.slice(1, 3));
    expect(adjustment.carriedUsage).toEqual({
      input: 1_000, output: 2_000, cacheRead: 3, cacheWrite: 4, cost: 0.25,
    });

    // The rebuilt context is [summary, ...retainedTail]; slicing it at the new
    // baseline yields exactly the run-owned messages that survived.
    const rebuilt = ["<summary>", ...contextBefore.slice(contextBefore.length - 1)];
    expect(rebuilt.slice(adjustment.baselineAfter)).toEqual([runOwned.at(-1)]);
  });

  it("keeps the whole run slice when the retained tail covers it", () => {
    const contextBefore = [userMessage("seed"), userMessage("run prompt"), assistantMessage("answer")];

    const adjustment = midRunBaselineAdjustment(contextBefore, 1, 3);

    expect(adjustment.lostMessages).toEqual([]);
    expect(adjustment.carriedUsage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    expect(adjustment.baselineAfter).toBe(2);
    expect(buildPiSessionContext([
      { type: "compaction", id: "c1", parentId: null, timestamp: 1, summary: "s", retainedTail: contextBefore },
    ], { includeFailed: true }).slice(adjustment.baselineAfter)).toEqual(contextBefore.slice(1));
  });
});
