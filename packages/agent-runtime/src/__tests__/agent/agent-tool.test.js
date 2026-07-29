import { describe, expect, it, vi } from "vitest";

const { createAgentTool, DEFAULT_SUBAGENT_TOOLS } = await import("../../agent/tools/agent-tool.js");

const PROFILE = {
  name: "researcher",
  description: "Reads code and answers factual questions.",
  systemPrompt: "You are a researcher.",
  allowedTools: ["Read", "Grep"],
};

/** Minimal run stub returning a successful child result. */
function okRun(text = "the answer") {
  return vi.fn(async () => ({ text, events: [], failureKind: null }));
}

function subagentOptions(overrides = {}) {
  return { definitions: [PROFILE], run: okRun(), ...overrides };
}

describe("Agent tool registration", () => {
  it("is unavailable without a run callback", () => {
    expect(createAgentTool(null)).toBeNull();
    expect(createAgentTool({ definitions: [PROFILE] })).toBeNull();
  });

  it("is unavailable at depth >= 1 so a subagent can never spawn subagents", () => {
    expect(createAgentTool(subagentOptions({ depth: 1 }))).toBeNull();
    expect(createAgentTool(subagentOptions({ depth: 3 }))).toBeNull();
    expect(createAgentTool(subagentOptions({ depth: 0 }))).not.toBeNull();
  });

  it("leaves executionMode undefined so it never serializes a mixed tool batch", () => {
    // pi-agent-core makes the WHOLE batch sequential when any tool in it
    // declares executionMode "sequential" (dist/agent-loop.js:289).
    expect(createAgentTool(subagentOptions()).executionMode).toBeUndefined();
  });

  it("offers configured profile names plus general-purpose, and omits the enum when none exist", () => {
    const withNames = createAgentTool(subagentOptions());
    expect(withNames.parameters.properties.name.enum).toEqual(["researcher", "general-purpose"]);
    expect(withNames.description).toContain("researcher: Reads code");

    const adHocOnly = createAgentTool({ definitions: [], run: okRun() });
    expect(adHocOnly.parameters.properties.name).toBeUndefined();
  });
});

describe("Agent tool dispatch", () => {
  it("routes a named profile and passes its prompt and tools through", async () => {
    const run = okRun("found it");
    const tool = createAgentTool(subagentOptions({ run }));
    const result = await tool.execute("call-1", { name: "researcher", prompt: "find X" });

    expect(run).toHaveBeenCalledOnce();
    const request = run.mock.calls[0][0];
    expect(request).toMatchObject({
      systemPrompt: "You are a researcher.",
      prompt: "find X",
      callId: "call-1",
      callIndex: 1,
      depth: 1,
    });
    expect(request.definition.allowedTools).toEqual(["Read", "Grep"]);
    expect(result.content[0].text).toContain("found it");
    expect(result.content[0].text).toContain("<subagent: researcher · ok");
  });

  it("falls back to a read-only general-purpose profile when no name is given", async () => {
    const run = okRun();
    const tool = createAgentTool(subagentOptions({ run }));
    await tool.execute("call-1", { prompt: "look around" });

    const request = run.mock.calls[0][0];
    expect(request.definition.name).toBe("general-purpose");
    expect(request.definition.allowedTools).toEqual(DEFAULT_SUBAGENT_TOOLS);
    expect(request.definition.allowedTools).not.toContain("Bash");
    expect(request.definition.allowedTools).not.toContain("Write");
  });

  it("always tells the child it is one level deeper than the parent", async () => {
    const run = okRun();
    const tool = createAgentTool(subagentOptions({ run, depth: 0 }));
    await tool.execute("call-1", { prompt: "x" });
    expect(run.mock.calls[0][0].depth).toBe(1);
  });

  it("throws on an unknown profile name and lists what is available", async () => {
    const tool = createAgentTool(subagentOptions());
    await expect(tool.execute("call-1", { name: "nope", prompt: "x" }))
      .rejects.toThrow(/unknown subagent "nope"\. Available: researcher, general-purpose/u);
  });
});

describe("Agent tool budgets", () => {
  it("never exceeds maxConcurrent in-flight subagents", async () => {
    let inFlight = 0;
    let peak = 0;
    /** @type {Array<() => void>} */
    const pending = [];
    const run = vi.fn(() => new Promise((resolve) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      pending.push(() => {
        inFlight -= 1;
        resolve({ text: "done", events: [] });
      });
    }));

    const tool = createAgentTool(subagentOptions({ run, maxConcurrent: 3 }));
    const calls = Array.from({ length: 8 }, (_, i) => tool.execute(`c${i}`, { prompt: "x" }));

    // Let every admitted call reach `run`, then release exactly one at a time so
    // a queued caller can only start as a slot frees.
    const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
    await settle();
    expect(inFlight).toBe(3);

    while (pending.length > 0) {
      pending.shift()();
      await settle();
    }
    await Promise.all(calls);

    expect(peak).toBe(3);
    expect(run).toHaveBeenCalledTimes(8);
  });

  it("refuses further calls once the per-turn budget is spent", async () => {
    const tool = createAgentTool(subagentOptions({ maxPerTurn: 2 }));
    await tool.execute("c1", { prompt: "x" });
    await tool.execute("c2", { prompt: "x" });
    await expect(tool.execute("c3", { prompt: "x" }))
      .rejects.toThrow(/budget for this turn is exhausted \(2 of 2 used\)/u);
  });

  it("gives a queued call its full timeout rather than burning it while waiting", async () => {
    vi.useFakeTimers();
    try {
      let firstRelease;
      const run = vi.fn((request) => new Promise((resolve, reject) => {
        if (!firstRelease) {
          firstRelease = () => resolve({ text: "first", events: [] });
          return;
        }
        // The second call must still see a live signal when it finally starts.
        request.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        resolve({ text: "second", events: [] });
      }));

      const tool = createAgentTool(subagentOptions({ run, maxConcurrent: 1, timeoutMs: 1_000 }));
      const first = tool.execute("c1", { prompt: "x" });
      const second = tool.execute("c2", { prompt: "x" });

      // Hold the slot past the second call's whole timeout budget.
      await vi.advanceTimersByTimeAsync(5_000);
      firstRelease();
      const firstText = (await first).content[0].text;
      expect(firstText).toContain("first");

      await vi.advanceTimersByTimeAsync(0);
      expect((await second).content[0].text).toContain("second");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Agent tool outcomes", () => {
  it("returns a failed status with the activity log instead of throwing", async () => {
    const run = vi.fn(async (request) => {
      request.onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/b.ts" } }] } });
      request.onEvent({ type: "tool_timing", tool_use_id: "t1", execution_ms: 12 });
      request.onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } });
      return { text: null, error: "boom", failureKind: "provider_unavailable", events: [] };
    });
    const tool = createAgentTool(subagentOptions({ run }));
    const result = await tool.execute("c1", { prompt: "x" });

    const text = result.content[0].text;
    expect(text).toContain("· failed ·");
    expect(text).toContain("provider_unavailable: boom");
    expect(text).toContain("1. Read /a/b.ts → ok 12ms");
    // pi ignores a top-level `error` field; the pi-native tool_result hook
    // reads this status to restore isError, so it is the load-bearing signal.
    expect(result.details.subagent.status).toBe("failed");
  });

  it("reports an empty answer distinctly from a failure", async () => {
    const tool = createAgentTool(subagentOptions({ run: vi.fn(async () => ({ text: "   ", events: [] })) }));
    const text = (await tool.execute("c1", { prompt: "x" })).content[0].text;
    expect(text).toContain("· empty ·");
  });

  it("does not reclassify an answer that legitimately starts with Error:", async () => {
    // createBuiltinTool would have thrown this away; the Agent tool must not.
    const tool = createAgentTool(subagentOptions({ run: okRun("Error: the build is broken at foo.ts:12") }));
    const result = await tool.execute("c1", { prompt: "x" });
    expect(result.content[0].text).toContain("Error: the build is broken at foo.ts:12");
    expect(result.details.subagent.status).toBe("ok");
  });

  it("surfaces a parent-turn abort as an aborted tool call", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      return { text: "partial", events: [] };
    });
    const tool = createAgentTool(subagentOptions({ run }));
    await expect(tool.execute("c1", { prompt: "x" }, controller.signal))
      .rejects.toThrow(/tool execution aborted/u);
  });

  it("reports a timeout with its partial activity preserved", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn((request) => new Promise((resolve) => {
        request.onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "x" } }] } });
        request.onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } });
        request.abortSignal.addEventListener("abort", () => resolve({ text: "", events: [], cancelled: true }), { once: true });
      }));
      const tool = createAgentTool(subagentOptions({ run, timeoutMs: 500 }));
      const pending = tool.execute("c1", { prompt: "x" });
      await vi.advanceTimersByTimeAsync(600);
      const text = (await pending).content[0].text;
      expect(text).toContain("· timeout ·");
      expect(text).toContain("Grep");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Agent tool result budget", () => {
  it("keeps a pathological subagent result far under the bloat guard", async () => {
    const run = vi.fn(async (request) => {
      for (let i = 0; i < 10_000; i += 1) {
        request.onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/very/long/path/number/${i}/${"x".repeat(200)}.ts` } }] } });
        request.onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: false }] } });
      }
      return { text: "y".repeat(5_000_000), events: [] };
    });
    const tool = createAgentTool(subagentOptions({ run }));
    const text = (await tool.execute("c1", { prompt: "x" })).content[0].text;

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(24_000);
    // Head and tail of the trace survive; the middle is elided.
    expect(text).toContain("1. Read");
    expect(text).toContain("10000. Read");
    expect(text).toMatch(/… 9945 calls elided …/u);
  });

describe("Agent tool activity forwarding", () => {
  function capture(runImpl, params = { name: "researcher", prompt: "x" }, options = {}) {
    const events = [];
    const tool = createAgentTool(subagentOptions({ run: runImpl, ...options }), { onEvent: (e) => events.push(e) });
    return { events, done: tool.execute("call-1", params) };
  }

  it("brackets the subagent with its own lifecycle events", async () => {
    const { events, done } = capture(okRun("answer"), { name: "researcher", prompt: "x", description: "find the thing" });
    await done;

    const lifecycle = events.filter((e) => e.phase?.startsWith("agent_"));
    expect(lifecycle.map((e) => e.phase)).toEqual(["agent_started", "agent_completed"]);
    expect(lifecycle[0]).toMatchObject({
      type: "subagent_activity",
      id: "agent:call-1",
      name: "Agent(researcher)",
      subagent: { id: "call-1", name: "researcher", callIndex: 1, label: "find the thing" },
    });
    expect(lifecycle[1]).toMatchObject({ isError: false, content: "ok · 0 tool calls" });
  });

  it("forwards each child tool call with a namespaced id and subagent metadata", async () => {
    const run = async (request) => {
      request.onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }] } });
      request.onEvent({ type: "tool_timing", tool_use_id: "t1", execution_ms: 9 });
      request.onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "body", is_error: false }] } });
      return { text: "done", events: [] };
    };
    const { events, done } = capture(run);
    await done;

    const toolEvents = events.filter((e) => e.phase === "started" || e.phase === "completed");
    expect(toolEvents.map((e) => e.id)).toEqual(["agent:call-1:t1", "agent:call-1:t1"]);
    expect(toolEvents[0]).toMatchObject({ name: "researcher▸Read", arguments: { file_path: "/a.ts" } });
    expect(toolEvents[1]).toMatchObject({ name: "researcher▸Read", isError: false, executionMs: 9, content: "body" });
    expect(toolEvents[0].subagent).toEqual({ id: "call-1", name: "researcher", callIndex: 1 });
  });

  it("never forwards the child's assistant text, which would splice into the parent answer", async () => {
    const run = async (request) => {
      request.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "internal monologue" }] } });
      request.onEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } });
      return { text: "final", events: [] };
    };
    const { events, done } = capture(run);
    await done;

    expect(JSON.stringify(events)).not.toContain("internal monologue");
    expect(JSON.stringify(events)).not.toContain("hmm");
  });

  it("caps a forwarded tool result so the wire reducer never has to run", async () => {
    const run = async (request) => {
      request.onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } });
      request.onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "z".repeat(500_000) }] } });
      return { text: "done", events: [] };
    };
    const { events, done } = capture(run);
    await done;

    const completed = events.find((e) => e.phase === "completed");
    expect(completed.content.length).toBeLessThanOrEqual(2_001);
    expect(completed.content.endsWith("…")).toBe(true);
  });

  it("keeps forwarding failures from breaking the subagent", async () => {
    const tool = createAgentTool(subagentOptions(), {
      onEvent: () => { throw new Error("operator stream is gone"); },
    });
    const result = await tool.execute("call-1", { name: "researcher", prompt: "x" });
    expect(result.content[0].text).toContain("the answer");
  });
});

describe("Agent tool confinement", () => {
  it("materializes the safe read-only set for a named profile that omits tools", async () => {
    // Forwarding `undefined` would mean pi's allow-all sentinel — every
    // built-in including Bash, Write, and Exec — for a profile that merely
    // declined to enumerate its tools.
    const run = okRun();
    const tool = createAgentTool({
      definitions: [{ name: "bare", description: "d", systemPrompt: "s" }],
      run,
    });
    await tool.execute("c1", { name: "bare", prompt: "x" });

    const { definition } = run.mock.calls[0][0];
    expect(definition.allowedTools).toEqual(DEFAULT_SUBAGENT_TOOLS);
    expect(definition.allowedTools).not.toContain("Bash");
  });

  it("unions the hard-deny list onto every profile, including in the bare kernel", async () => {
    const run = okRun();
    const tool = createAgentTool({
      definitions: [{ name: "shelly", description: "d", systemPrompt: "s", allowedTools: ["Read", "Bash"], disallowedTools: ["Write"] }],
      run,
    });
    await tool.execute("c1", { name: "shelly", prompt: "x" });

    const { definition } = run.mock.calls[0][0];
    expect(definition.disallowedTools).toEqual(expect.arrayContaining([
      "Write", "Agent", "AskUser", "SlackSendMessage", "TelegramSendMessage", "TelegramSendFile",
    ]));
  });

  it("strips a hard-denied tool a profile tries to allow", async () => {
    const run = okRun();
    const tool = createAgentTool({
      definitions: [{ name: "sneaky", description: "d", systemPrompt: "s", allowedTools: ["Read", "Agent", "AskUser"] }],
      run,
    });
    await tool.execute("c1", { name: "sneaky", prompt: "x" });

    const { definition } = run.mock.calls[0][0];
    expect(definition.allowedTools).toEqual(["Read"]);
  });

  it("hands the parent's sandbox policy to every child request", async () => {
    const run = okRun();
    const sandboxPolicy = { mode: "workspace-write", network: { mode: "deny" } };
    const sandboxEngine = { id: "srt" };
    const tool = createAgentTool(subagentOptions({ run }), { sandboxPolicy, sandboxEngine });
    await tool.execute("c1", { prompt: "x" });

    // A child inheriting no policy would bypass network deny through its own
    // default WebFetch/WebSearch tools.
    expect(run.mock.calls[0][0]).toMatchObject({ sandboxPolicy, sandboxEngine });
  });
});

describe("Agent tool bounds", () => {
  it("abandons a runner that ignores both its abort signal and its deadline", async () => {
    vi.useFakeTimers();
    try {
      // A signal only asks. Without an enforceable deadline this call would stay
      // pending forever, holding its permit and wedging every queued sibling.
      const run = vi.fn(() => new Promise(() => {}));
      const tool = createAgentTool(subagentOptions({ run, timeoutMs: 1_000, maxConcurrent: 1 }));
      const first = tool.execute("c1", { prompt: "x" });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(5_000);
      const text = (await first).content[0].text;
      expect(text).toContain("· timeout ·");
      expect(text).toContain("abandoned");

      // The slot is free, so a queued sibling can still run.
      const second = tool.execute("c2", { prompt: "y" });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await second).content[0].text).toContain("· timeout ·");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the aggregate bytes of many results in one turn", async () => {
    const run = vi.fn(async () => ({ text: "z".repeat(200_000), events: [] }));
    const tool = createAgentTool(subagentOptions({ run, maxPerTurn: 20 }));

    let total = 0;
    for (let i = 0; i < 20; i += 1) {
      const result = await tool.execute(`c${i}`, { prompt: "x" });
      total += Buffer.byteLength(result.content[0].text, "utf8");
    }
    // Twenty individually-capped 24KB results would be ~480KB of parent context.
    expect(total).toBeLessThanOrEqual(140_000);
  });

  it("still reports the outcome after the turn byte budget is spent", async () => {
    const run = vi.fn(async () => ({ text: "z".repeat(200_000), events: [] }));
    const tool = createAgentTool(subagentOptions({ run, maxPerTurn: 20 }));
    for (let i = 0; i < 12; i += 1) await tool.execute(`c${i}`, { prompt: "x" });

    const last = await tool.execute("last", { name: "researcher", prompt: "x" });
    expect(last.content[0].text).toContain("<subagent: researcher");
  });

  it("keeps one call budget across router attempts that rebuild the tool", async () => {
    // getPiBuiltinTools runs per router attempt, so a closure-local counter
    // would hand each retry and failover a fresh maxPerTurn allowance.
    const shared = subagentOptions({ maxPerTurn: 2 });
    const context = { parentRunId: "run-1" };

    const attemptOne = createAgentTool(shared, context);
    await attemptOne.execute("c1", { prompt: "x" });

    const attemptTwo = createAgentTool(shared, context);
    await attemptTwo.execute("c2", { prompt: "x" });
    await expect(attemptTwo.execute("c3", { prompt: "x" }))
      .rejects.toThrow(/budget for this turn is exhausted/u);
  });

  it("starts a fresh budget for a different parent run", async () => {
    const shared = subagentOptions({ maxPerTurn: 1 });
    const first = createAgentTool(shared, { parentRunId: "run-1" });
    await first.execute("c1", { prompt: "x" });
    await expect(first.execute("c2", { prompt: "x" })).rejects.toThrow(/exhausted/u);

    const second = createAgentTool(shared, { parentRunId: "run-2" });
    await expect(second.execute("c3", { prompt: "x" })).resolves.toBeDefined();
  });
});
});
