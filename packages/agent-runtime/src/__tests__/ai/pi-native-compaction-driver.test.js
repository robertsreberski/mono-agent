import { describe, expect, it, vi } from "vitest";
import {
  estimateCurrentContextTokens,
  resolveLiveCompactionPolicy,
  runProactiveCompaction,
  runReactiveCompaction,
  tryCompact,
} from "../../ai/providers/pi-native/compaction-driver.js";

// A session double whose buildContext / getEntries / (message count) are
// scriptable, so the trigger math is exercised deterministically.
function fakeSession({ entries = [], messages = [] } = {}) {
  return {
    getEntries: async () => entries,
    buildContext: async () => ({ messages }),
  };
}

function freshRunState(session, { policy } = {}) {
  return {
    session,
    sessionBaselineCount: 0,
    externalAbort: false,
    maxTurnsHit: false,
    compaction: {
      applied: false,
      reactiveAttempted: false,
      compactedThisRun: false,
      policy: policy ?? null,
      diagnostics: {},
    },
  };
}

describe("estimateCurrentContextTokens", () => {
  it("returns unavailable when there is no usage and no transcript", async () => {
    const out = await estimateCurrentContextTokens(fakeSession(), 0);
    expect(out).toEqual({ tokens: 0, source: "unavailable" });
  });

  it("adds the fixed overhead to the raw branch only and picks the larger source", async () => {
    // Two short messages → small raw token estimate; a large fixed overhead
    // pushes the raw branch above the (zero) usage branch.
    const session = fakeSession({ messages: [{ role: "user", content: "hello" }] });
    const out = await estimateCurrentContextTokens(session, 10_000);
    expect(out.source).toBe("estimate");
    expect(out.tokens).toBeGreaterThanOrEqual(10_000);
  });
});

describe("tryCompact", () => {
  it("emits the applied event, fires onCompactionRecorded, and reports applied", async () => {
    const events = [];
    const recorded = [];
    const messages = [{ role: "user", content: "x".repeat(4000) }];
    const session = fakeSession({ messages });
    const harness = { compact: async () => {
      messages.splice(0, messages.length, { role: "user", content: "summary" });
      return { tokensBefore: 1234, summary: "s", firstKeptEntryId: "e1" };
    } };
    const res = await tryCompact(harness, {
      trigger: "proactive",
      onEvent: (e) => events.push(e),
      runtimeWarnings: [],
      onCompactionRecorded: (row) => recorded.push(row),
      runId: "r1",
      model: "pi:faux:m",
      session,
    });
    expect(res).toMatchObject({ applied: true, tokensBefore: 1234, reduced: true, nothingToCompact: false });
    expect(res.tokensAfter).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({
      warning_kind: "context_compaction_applied",
      trigger: "proactive",
      tokens_before: 1234,
      reduced: true,
    });
    expect(recorded[0]).toMatchObject({ trigger: "proactive", provider_kind: "pi", tokens_before: 1234, status: "succeeded" });
  });

  it("reports an applied compaction that did not reduce the built context", async () => {
    const warnings = [];
    const session = fakeSession({ messages: [{ role: "user", content: "unchanged" }] });
    const res = await tryCompact(
      { compact: async () => ({ tokensBefore: 10 }) },
      { trigger: "reactive_overflow", onEvent: () => {}, runtimeWarnings: warnings, session },
    );
    expect(res).toMatchObject({ applied: true, reduced: false });
    expect(warnings).toContainEqual(expect.objectContaining({
      warning_kind: "context_compaction_not_reducible",
      trigger: "reactive_overflow",
    }));
  });

  it("classifies a nothing-to-compact failure as a warning, not a throw", async () => {
    const warnings = [];
    const err = Object.assign(new Error("nothing to compact"), { code: "compaction" });
    const harness = { compact: async () => { throw err; } };
    const res = await tryCompact(harness, { trigger: "proactive", onEvent: () => {}, runtimeWarnings: warnings });
    expect(res).toEqual({
      applied: false,
      tokensBefore: null,
      tokensAfter: null,
      reduced: null,
      nothingToCompact: true,
    });
    expect(warnings[0].warning_kind).toBe("context_compaction_nothing_to_compact");
  });

  it("maps auth/busy/other error codes to distinct warning kinds", async () => {
    const kinds = [];
    for (const [code, kind] of [
      ["auth", "context_compaction_auth_failed"],
      ["busy", "context_compaction_busy"],
      ["other", "context_compaction_failed"],
    ]) {
      const warnings = [];
      const harness = { compact: async () => { throw Object.assign(new Error("x"), { code }); } };
      await tryCompact(harness, { trigger: "reactive_overflow", onEvent: () => {}, runtimeWarnings: warnings });
      kinds.push(warnings[0].warning_kind);
    }
    expect(kinds).toEqual([
      "context_compaction_auth_failed",
      "context_compaction_busy",
      "context_compaction_failed",
    ]);
  });
});

describe("resolveLiveCompactionPolicy — window recognition", () => {
  it("reads the harness live model context window into the policy", () => {
    const harness = { getModel: () => ({ id: "m", contextWindow: 100_000 }) };
    const policy = resolveLiveCompactionPolicy({
      harness,
      runtime: { model: { id: "m" } },
      resolved: { reference: "pi:faux:m" },
      settings: {},
    });
    expect(policy.contextWindow).toBe(100_000);
    expect(policy.enabled).toBe(true);
    expect(policy.triggerTokens).toBeGreaterThan(0);
  });

  it("falls back to the runtime model window when the harness has no live model", () => {
    const policy = resolveLiveCompactionPolicy({
      harness: {},
      runtime: { model: { id: "m", contextWindow: 40_000 } },
      resolved: {},
      settings: {},
    });
    expect(policy.contextWindow).toBe(40_000);
  });
});

describe("runProactiveCompaction — trigger math", () => {
  const policy = (over = {}) => ({ enabled: true, contextWindow: 1_000, triggerTokens: 500, ...over });

  it("does nothing when the policy is disabled", async () => {
    const runState = freshRunState(fakeSession(), { policy: policy({ enabled: false }) });
    const harness = { waitForIdle: vi.fn(), compact: vi.fn() };
    await runProactiveCompaction(runState, {
      harness, systemPrompt: "s", options: { settings: {} }, tools: [],
      promptText: "hi", promptImages: [], reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
    });
    expect(harness.compact).not.toHaveBeenCalled();
    expect(runState.compaction.applied).toBe(false);
  });

  it("does not compact when the estimate is below the trigger", async () => {
    // tiny transcript, fixed overhead disabled → estimate well under 500.
    const runState = freshRunState(fakeSession({ messages: [{ role: "user", content: "hi" }] }), { policy: policy() });
    const harness = { waitForIdle: vi.fn(), compact: vi.fn(async () => ({ tokensBefore: 1 })) };
    await runProactiveCompaction(runState, {
      harness, systemPrompt: "s",
      options: { settings: { agent_compaction_fixed_overhead_enabled: false } },
      tools: [], promptText: "hi", promptImages: [], reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
    });
    expect(harness.compact).not.toHaveBeenCalled();
  });

  it("compacts, records diagnostics, and re-anchors the baseline when the estimate crosses the trigger", async () => {
    // Large fixed overhead pushes the estimate over triggerTokens.
    const session = fakeSession({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] });
    const runState = freshRunState(session, { policy: policy() });
    const harness = { waitForIdle: vi.fn(), compact: vi.fn(async () => ({ tokensBefore: 900 })) };
    await runProactiveCompaction(runState, {
      harness, systemPrompt: "s",
      options: { settings: {} }, // fixed overhead ON
      tools: [{ name: "Bash", description: "x".repeat(4000), parameters: {} }],
      promptText: "hi", promptImages: [], reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
    });
    expect(harness.compact).toHaveBeenCalledTimes(1);
    expect(runState.compaction.applied).toBe(true);
    expect(runState.compaction.compactedThisRun).toBe(true);
    expect(runState.compaction.diagnostics.context_compaction_proactive).toBe(true);
    expect(runState.compaction.diagnostics.context_compaction_tokens_before).toBe(900);
    // re-anchored to the (2-message) compacted length.
    expect(runState.sessionBaselineCount).toBe(2);
  });
});

describe("runReactiveCompaction — overflow recovery", () => {
  const overflowState = { stopReason: "error", lastAssistant: { errorMessage: "context length exceeded, too many tokens" } };

  it("no-ops when already compacted this run (avoids the near-certain nothing-to-compact)", async () => {
    const runState = freshRunState(fakeSession(), { policy: { enabled: true } });
    runState.compaction.compactedThisRun = true;
    const harness = { compact: vi.fn(), waitForIdle: vi.fn(), prompt: vi.fn(), getModel: () => null };
    const out = await runReactiveCompaction(runState, {
      harness, runtime: {}, resolved: {}, options: {}, promptText: "hi", promptImages: [],
      reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
      state: overflowState, runError: null, captureState: async () => overflowState,
    });
    // reactiveAttempted flips, but no second compaction fires.
    expect(runState.compaction.reactiveAttempted).toBe(true);
    expect(harness.compact).not.toHaveBeenCalled();
    expect(out.state).toBe(overflowState);
  });

  it("compacts once and re-prompts once on a fresh overflow", async () => {
    const messages = [{ role: "user", content: "x".repeat(4000) }];
    const runState = freshRunState(fakeSession({ messages }), { policy: { enabled: true } });
    const captured = [];
    const harness = {
      waitForIdle: vi.fn(),
      compact: vi.fn(async () => {
        messages.splice(0, messages.length, { role: "user", content: "summary" });
        return { tokensBefore: 5000 };
      }),
      prompt: vi.fn(async () => { captured.push("prompt"); }),
      getModel: () => ({ id: "m", contextWindow: 8000 }),
    };
    const rerunState = { stopReason: "endTurn", lastAssistant: { content: [{ type: "text", text: "recovered" }] } };
    let capturedCalls = 0;
    const out = await runReactiveCompaction(runState, {
      harness, runtime: { model: { id: "m" } }, resolved: { reference: "pi:faux:m" }, options: {},
      promptText: "hi", promptImages: [], reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
      state: overflowState, runError: null,
      captureState: async () => { capturedCalls += 1; return rerunState; },
    });
    expect(harness.compact).toHaveBeenCalledTimes(1);
    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect(runState.compaction.applied).toBe(true);
    expect(runState.compaction.diagnostics.context_compaction_reactive).toBe(true);
    expect(runState.compaction.diagnostics.context_compaction_reactive_attempted).toBe(true);
    expect(runState.compaction.diagnostics.context_compaction_reduced).toBe(true);
    expect(out.state).toBe(rerunState);
    expect(capturedCalls).toBe(1);
  });

  it("does not re-prompt when compaction leaves the built context unchanged", async () => {
    const session = fakeSession({ messages: [{ role: "user", content: "unchanged" }] });
    const runState = freshRunState(session, { policy: { enabled: true } });
    const warnings = [];
    const harness = {
      waitForIdle: vi.fn(),
      compact: vi.fn(async () => ({ tokensBefore: 5000 })),
      prompt: vi.fn(),
      getModel: () => ({ id: "m", contextWindow: 8000 }),
    };
    const out = await runReactiveCompaction(runState, {
      harness, runtime: { model: { id: "m" } }, resolved: { reference: "pi:faux:m" }, options: {},
      promptText: "hi", promptImages: [], reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: warnings,
      state: overflowState, runError: null, captureState: vi.fn(),
    });
    expect(harness.compact).toHaveBeenCalledTimes(1);
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(runState.compaction.diagnostics.context_compaction_reduced).toBe(false);
    expect(warnings).toContainEqual(expect.objectContaining({ warning_kind: "context_compaction_not_reducible" }));
    expect(out.state).toBe(overflowState);
  });

  it("does not fire on a non-overflow error", async () => {
    const runState = freshRunState(fakeSession(), { policy: { enabled: true } });
    const harness = { compact: vi.fn(), waitForIdle: vi.fn(), prompt: vi.fn(), getModel: () => null };
    const benign = { stopReason: "error", lastAssistant: { errorMessage: "401 unauthorized" } };
    const out = await runReactiveCompaction(runState, {
      harness, runtime: {}, resolved: {}, options: {}, promptText: "hi", promptImages: [],
      reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
      state: benign, runError: null, captureState: async () => benign,
    });
    expect(harness.compact).not.toHaveBeenCalled();
    expect(runState.compaction.reactiveAttempted).toBe(false);
    expect(out.runError).toBeNull();
  });

  it("skips when the run was externally aborted or hit max turns", async () => {
    const runState = freshRunState(fakeSession(), { policy: { enabled: true } });
    runState.externalAbort = true;
    const harness = { compact: vi.fn(), waitForIdle: vi.fn(), prompt: vi.fn() };
    await runReactiveCompaction(runState, {
      harness, runtime: {}, resolved: {}, options: {}, promptText: "hi", promptImages: [],
      reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
      state: overflowState, runError: null, captureState: async () => overflowState,
    });
    expect(runState.compaction.reactiveAttempted).toBe(false);
    expect(harness.compact).not.toHaveBeenCalled();
  });
});
