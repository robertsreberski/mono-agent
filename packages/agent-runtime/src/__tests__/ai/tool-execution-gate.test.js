import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createPiHarnessAdapter, createPiSessionAdapter, PI_CONTEXT } from "../../ai/providers/pi-native/harness-adapter.js";
import { createToolExecutionGate, isSharedTool } from "../../ai/providers/pi-native/tool-execution-gate.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function batch(names, { mode = "safe-parallel", question = false } = {}) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "gate-test" }], tokensPerSecond: undefined });
  const model = faux.getModel();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(names.map((name, index) => fauxToolCall(name, {}, { id: `call-${index}` }))),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const repo = new MemorySessionRepo();
  const rawSession = await repo.create({ id: `gate-${Math.random()}` }, PI_CONTEXT);
  const session = createPiSessionAdapter(rawSession);
  const events = [];
  const blockers = names.map(() => deferred());
  const tools = [...new Set([...names, "Bash"])].map((name) => ({
    name, label: name, description: name,
    parameters: { type: "object", properties: {} },
    ...(name === "Agent" || name === "Read" ? {} : { executionMode: "sequential" }),
    async execute(id) {
      events.push(`enter:${id}`);
      await blockers[Number(id.slice(5))].promise;
      events.push(`exit:${id}`);
      return { content: [{ type: "text", text: id }],
        ...(name === "AskParent" && question ? { details: { tool: "AskParent" }, terminate: true } : {}) };
    },
  }));
  const harness = await createPiHarnessAdapter(session, {
    models, model, thinkingLevel: "off", systemPrompt: "system", tools,
    toolExecutionMode: mode, streamOptions: { transport: "auto", maxRetries: 0, maxRetryDelayMs: 1 },
    steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
  });
  const run = harness.prompt("run");
  const finish = async () => {
    blockers.forEach((blocker) => blocker.resolve());
    try { return await run; } finally { await harness.close(); await repo.close(PI_CONTEXT); }
  };
  return { events, blockers, run, finish, harness, session };
}

const enter = (i) => `enter:call-${i}`;
const exit = (i) => `exit:call-${i}`;
const wait = (fn) => vi.waitFor(fn, { timeout: 5000 });

describe("Pi harness invoked-call admission", () => {
  it.each([["Agent", "Agent"], ["Read", "Agent"]])("overlaps %s and %s with Bash offered", async (a, b) => {
    const state = await batch([a, b]);
    try {
      await wait(() => expect(state.events).toContain(enter(1)));
      expect(state.events).not.toContain(exit(0));
      state.blockers[1].resolve();
      state.blockers[0].resolve();
      const result = await state.run;
      expect(result.status).toBe("completed");
      // Pi materializes provider-visible results in call order even when the
      // second call exits first. The original call IDs stay associated.
      const messages = (await state.session.buildContext()).messages;
      expect(messages.filter((message) => message.role === "toolResult")
        .map((message) => message.toolCallId)).toEqual(["call-0", "call-1"]);
      expect(state.events).toContain(exit(1));
    } finally { await state.finish(); }
  });

  it.each(["Bash", "Write", "Edit", "Exec", "NodeRepl", "Monitor", "McpTool", "AgentManage", "AskParent", "StructuredOutput", "Unknown"])(
    "holds %s exclusively in both mixed orders", async (unsafe) => {
      for (const names of [[unsafe, "Agent"], ["Agent", unsafe]]) {
        const state = await batch(names);
        try {
          await wait(() => expect(state.events).toContain(enter(0)));
          await new Promise((resolve) => setTimeout(resolve, 15));
          expect(state.events).not.toContain(enter(1));
          state.blockers[0].resolve();
          await wait(() => expect(state.events).toContain(enter(1)));
        } finally { await state.finish(); }
      }
    },
  );

  it("keeps forced sequential even for two Agents", async () => {
    const state = await batch(["Agent", "Agent"], { mode: "sequential" });
    try {
      await wait(() => expect(state.events).toContain(enter(0)));
      expect(state.events).not.toContain(enter(1));
      state.blockers[0].resolve();
      await wait(() => expect(state.events).toContain(enter(1)));
    } finally { await state.finish(); }
  });

  it("overrides persisted sequential settings on the next restored run", async () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "restored-gate" }], tokensPerSecond: undefined });
    const model = faux.getModel();
    const models = createModels();
    models.setProvider(faux.provider);
    const repo = new MemorySessionRepo();
    const raw = await repo.create({ id: "restored-gate" }, PI_CONTEXT);
    const metadata = raw.metadata;
    const blocks = [deferred(), deferred()];
    const entries = [];
    const tools = ["Agent", "Bash"].map((name) => ({
      name, label: name, description: name, parameters: { type: "object", properties: {} },
      ...(name === "Bash" ? { executionMode: "sequential" } : {}),
      async execute(id) {
        entries.push(id);
        if (id.startsWith("parallel-")) await blocks[Number(id.at(-1))].promise;
        return { content: [{ type: "text", text: id }] };
      },
    }));
    const make = (session, toolExecutionMode) => createPiHarnessAdapter(session, {
      models, model, thinkingLevel: "off", systemPrompt: "system", tools, toolExecutionMode,
      streamOptions: { transport: "auto", maxRetries: 0, maxRetryDelayMs: 1 },
    });
    try {
      faux.setResponses([fauxAssistantMessage([fauxToolCall("Agent", {}, { id: "first" })]), fauxAssistantMessage([fauxText("done")])]);
      const first = await make(createPiSessionAdapter(raw), "sequential");
      expect((await first.prompt("first")).status).toBe("completed");
      await first.close();
      const restored = createPiSessionAdapter(await repo.open(metadata, PI_CONTEXT));
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Agent", {}, { id: "parallel-0" }), fauxToolCall("Agent", {}, { id: "parallel-1" })]),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const second = await make(restored, "safe-parallel");
      try {
        const run = second.prompt("second");
        await wait(() => expect(entries).toContain("parallel-1"));
        blocks.forEach((block) => block.resolve());
        expect((await run).status).toBe("completed");
      } finally { blocks.forEach((block) => block.resolve()); await second.close(); }
    } finally { await repo.close(PI_CONTEXT); }
  });

  it("never executes a queued call after the run is cancelled", async () => {
    const state = await batch(["Bash", "Agent"]);
    try {
      await wait(() => expect(state.events).toContain(enter(0)));
      const cancelling = state.harness.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.blockers[0].resolve();
      await cancelling;
      await state.run;
      expect(state.events).not.toContain(enter(1));
    } finally { await state.finish(); }
  });

  it("does not enter a queued call after a successful AskParent", async () => {
    const state = await batch(["AskParent", "Agent"], { question: true });
    try {
      await wait(() => expect(state.events).toContain(enter(0)));
      state.blockers[0].resolve();
      await state.run;
      expect(state.events).not.toContain(enter(1));
    } finally { await state.finish(); }
  });
});

describe("run-local gate cancellation and hand-off", () => {
  it("removes aborted waiters and releases a failed or timed-out execution", async () => {
    const gate = createToolExecutionGate();
    const release = await gate.acquire(false);
    const controller = new AbortController();
    const aborted = gate.acquire(true, controller.signal);
    const following = gate.acquire(true);
    controller.abort();
    await expect(aborted).rejects.toThrow("aborted");
    release();
    const releaseFollowing = await following;
    releaseFollowing();
    // A tool's finally release applies equally to throw, timeout or cancel.
    for (const error of [new Error("failure"), new Error("timeout")]) {
      const entered = (async () => {
        const done = await gate.acquire(false);
        try { throw error; } finally { done(); }
      })();
      await expect(entered).rejects.toBe(error);
      const done = await gate.acquire(true);
      done();
    }
  });

  it("releases on background process and detached Agent receipts, not child lifetime", async () => {
    const gate = createToolExecutionGate();
    for (const name of ["Bash", "Exec", "Agent"]) {
      const receipt = deferred();
      const running = (async () => {
        const release = await gate.acquire(isSharedTool({ name }));
        try { await receipt.promise; } finally { release(); }
      })();
      const next = gate.acquire(false);
      receipt.resolve({ state: "started" });
      await running;
      const release = await next;
      release();
    }
  });
});
