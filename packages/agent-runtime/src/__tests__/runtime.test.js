import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.fn();
const resolveRuntimeBridgeMock = vi.fn();

vi.mock("../ai/runtime/registry.js", () => ({
  resolveRuntimeBridge: (...args) => resolveRuntimeBridgeMock(...args),
}));

const { createRuntime } = await import("../runtime.js");
const { readToolRuntime, resetToolRuntime } = await import("../agent/tools/shared/runtime-context.js");

function modelRef(provider, model) {
  return { provider, model, reference: `${provider}:${model}` };
}

beforeEach(() => {
  executeMock.mockReset();
  resolveRuntimeBridgeMock.mockReset();
  resolveRuntimeBridgeMock.mockResolvedValue({ id: "stub", execute: executeMock });
  resetToolRuntime();
});

afterEach(() => {
  resetToolRuntime();
});

describe("createRuntime", () => {
  it("exposes run() and configureTools() and threads a per-instance tool context to bridge.execute", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime({
      workspace: "/tmp/work",
      repoRoot: "/tmp/repo",
      ripgrepPath: "/usr/bin/rg",
      qaOutputDir: "/tmp/qa",
    });
    expect(typeof runtime.run).toBe("function");
    expect(typeof runtime.configureTools).toBe("function");
    await runtime.run("sys", { model: modelRef("anthropic", "x") });
    // The host tool config lives on the per-instance context threaded to the
    // bridge — NOT published to the process-global default context.
    expect(executeMock.mock.calls[0][1].toolContext).toMatchObject({
      workspace: "/tmp/work",
      repoRoot: "/tmp/repo",
      ripgrepPath: "/usr/bin/rg",
      qaOutputDir: "/tmp/qa",
    });
    expect(readToolRuntime().workspace).toBeUndefined();
  });

  it("ignores host keys it does not recognize when building the tool context", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime({ workspace: "/tmp/work", unrelated: "ignored" });
    await runtime.run("sys", { model: modelRef("anthropic", "x") });
    const { toolContext } = executeMock.mock.calls[0][1];
    expect(toolContext.workspace).toBe("/tmp/work");
    expect(toolContext.unrelated).toBeUndefined();
  });

  it("clones request tool environment into one run without contaminating the shared context", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime({ workspace: "/tmp/work" });
    const toolEnvironment = { schema: 1, values: { MULTICA_TASK_ID: "task-1" } };

    await runtime.run("first", { model: modelRef("faux", "x"), toolEnvironment });
    await runtime.run("second", { model: modelRef("faux", "x") });

    expect(executeMock.mock.calls[0][1].toolContext).toMatchObject({ toolEnvironment });
    expect(executeMock.mock.calls[1][1].toolContext).not.toHaveProperty("toolEnvironment");
    expect(executeMock.mock.calls[0][1].toolContext).not.toBe(executeMock.mock.calls[1][1].toolContext);
  });

  it("does not touch the global default tool runtime, regardless of host tool keys", () => {
    createRuntime({ workspace: "/tmp/work", ripgrepPath: "/usr/bin/rg" });
    expect(readToolRuntime().workspace).toBeUndefined();
    expect(readToolRuntime().ripgrepPath).toBeUndefined();
  });

  it("run() throws without a model", async () => {
    const runtime = createRuntime();
    await expect(runtime.run("sys", {})).rejects.toThrow(/requires options.model/);
  });

  it("run() resolves the bridge with the supplied model", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime();
    const model = modelRef("anthropic", "claude-sonnet-4-6");
    await runtime.run("sys", { model, liveInput: false });
    expect(resolveRuntimeBridgeMock).toHaveBeenCalledWith(model, {
      liveInput: false,
    });
  });

  it("run() defaults liveInput to false when omitted", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime();
    await runtime.run("sys", { model: modelRef("anthropic", "x") });
    expect(resolveRuntimeBridgeMock).toHaveBeenCalledWith(
      modelRef("anthropic", "x"),
      { liveInput: false },
    );
  });

  it("emits one metadata-only live_input_applied event after a bridge acknowledges guidance", async () => {
    const acknowledge = vi.fn();
    const events = [];
    executeMock.mockImplementationOnce(async (_systemPrompt, options) => {
      const next = await options.liveInput[Symbol.asyncIterator]().next();
      next.value.acknowledge();
      next.value.acknowledge();
      return { text: "ok", events: [] };
    });
    const runtime = createRuntime();
    const liveInput = {
      async *[Symbol.asyncIterator]() {
        yield {
          body: "Do not expose this full guidance",
          id: "follow-up-1",
          receivedAt: "2026-07-22T08:30:00.000Z",
          acknowledge,
        };
      },
    };

    await runtime.run("sys", {
      model: modelRef("anthropic", "x"),
      liveInput,
      onEvent: (event) => events.push(event),
    });

    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{
      type: "live_input_applied",
      inputId: "follow-up-1",
      receivedAt: "2026-07-22T08:30:00.000Z",
    }]);
    expect(events[0]).not.toHaveProperty("body");
    expect(events[0]).not.toHaveProperty("text");
  });

  it("run() forwards host defaults under per-call options to bridge.execute", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const resolveCustomPricing = () => null;
    const persistArtifact = () => null;
    const onCompactionRecorded = () => undefined;
    const resolvePiApiKey = async () => "key";
    const runtime = createRuntime({
      resolveCustomPricing,
      persistArtifact,
      onCompactionRecorded,
      resolvePiApiKey,
    });
    await runtime.run("sys", {
      model: modelRef("anthropic", "x"),
      cwd: "/work",
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [systemPrompt, options] = executeMock.mock.calls[0];
    expect(systemPrompt).toBe("sys");
    expect(options).toMatchObject({
      cwd: "/work",
      resolveCustomPricing,
      persistArtifact,
      onCompactionRecorded,
      resolvePiApiKey,
    });
  });

  it("run() does not bind host keys the RuntimeRequest shape no longer declares", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    // These three belonged to the deleted ACP *client* backend (the ACP server
    // bridge never used them). HOST_KEYS must stay identical to the
    // `Pick<AgentRuntimeHostOptions, ...>` clause of RuntimeRequest, so a host
    // that still passes them gets them dropped rather than smuggled onto a
    // request shape that does not admit them.
    const runtime = createRuntime({
      resolveAcpProfile: () => ({}),
      onAcpInteractionRequest: () => undefined,
      acpSessionTokenKey: "legacy-acp-token",
      resolveCustomPricing: () => null,
    });
    await runtime.run("sys", { model: modelRef("anthropic", "x") });

    const [, options] = executeMock.mock.calls[0];
    expect(options).not.toHaveProperty("resolveAcpProfile");
    expect(options).not.toHaveProperty("onAcpInteractionRequest");
    expect(options).not.toHaveProperty("acpSessionTokenKey");
    expect(options.resolveCustomPricing).toBeTypeOf("function");
  });

  it("run() lets per-call options override host defaults", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const hostResolver = () => "host";
    const callResolver = () => "call";
    const runtime = createRuntime({ resolveCustomPricing: hostResolver });
    await runtime.run("sys", {
      model: modelRef("anthropic", "x"),
      resolveCustomPricing: callResolver,
    });
    expect(executeMock.mock.calls[0][1].resolveCustomPricing).toBe(callResolver);
  });

  it("configureTools() updates the instance context observed by the next run", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime({ workspace: "/tmp/initial" });
    runtime.configureTools({ workspace: "/tmp/updated", ripgrepPath: "/opt/rg" });
    await runtime.run("sys", { model: modelRef("anthropic", "x") });
    expect(executeMock.mock.calls[0][1].toolContext).toMatchObject({
      workspace: "/tmp/updated",
      ripgrepPath: "/opt/rg",
    });
  });

  it("configureTools() can explicitly clear previously configured tool state", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const sandboxPolicy = { mode: "native", marker: "configured" };
    const sandboxEngine = { name: "srt" };
    const runtime = createRuntime({ sandboxPolicy, sandboxEngine });
    runtime.configureTools({ sandboxPolicy: undefined, sandboxEngine: undefined });

    await runtime.run("sys", { model: modelRef("anthropic", "x"), messages: [] });

    const options = executeMock.mock.calls.at(-1)[1];
    expect(options.toolContext.sandboxPolicy).toBeUndefined();
    expect(options.toolContext.sandboxEngine).toBeUndefined();
  });

  it("configureTools() ignores unknown keys", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime();
    runtime.configureTools({ workspace: "/w", bogus: "nope" });
    await runtime.run("sys", { model: modelRef("anthropic", "x") });
    const { toolContext } = executeMock.mock.calls[0][1];
    expect(toolContext.workspace).toBe("/w");
    expect(toolContext.bogus).toBeUndefined();
  });

  it("merges prompt overrides with run-over-host per-field precedence", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const hostInstruction = () => "host-instruction";
    const hostFinalization = () => "host-finalization";
    const runInstruction = () => "run-instruction";
    const runtime = createRuntime({
      prompts: { structuredOutputInstruction: hostInstruction, structuredOutputFinalization: hostFinalization },
    });
    await runtime.run("sys", {
      model: modelRef("faux", "x"),
      // Run overrides ONE field; the host's other prompt default must survive.
      prompts: { structuredOutputInstruction: runInstruction },
    });
    const { prompts } = executeMock.mock.calls[0][1];
    expect(prompts.structuredOutputInstruction).toBe(runInstruction); // run wins
    expect(prompts.structuredOutputFinalization).toBe(hostFinalization); // host fills the rest
  });

  it("passes host-only prompt overrides through when the run supplies none", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const hostGuidance = () => "g";
    const runtime = createRuntime({ prompts: { liveInputGuidance: hostGuidance } });
    await runtime.run("sys", { model: modelRef("faux", "x") });
    expect(executeMock.mock.calls[0][1].prompts).toEqual({ liveInputGuidance: hostGuidance });
  });

  it("omits prompts entirely when neither host nor run supply any", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const runtime = createRuntime();
    await runtime.run("sys", { model: modelRef("faux", "x") });
    expect(executeMock.mock.calls[0][1].prompts).toBeUndefined();
  });

  it("two runtime instances keep independent tool contexts (no cross-instance clobber)", async () => {
    executeMock.mockResolvedValue({ text: "ok" });
    const a = createRuntime({ workspace: "/tmp/a", runtimeBrand: { schemaPrefix: "aa" } });
    const b = createRuntime({ workspace: "/tmp/b", runtimeBrand: { schemaPrefix: "bb" } });
    // Mutate a AFTER b exists — the old global singleton would have leaked this
    // across both instances.
    a.configureTools({ workspace: "/tmp/a-updated" });
    await a.run("sys", { model: modelRef("anthropic", "x") });
    await b.run("sys", { model: modelRef("anthropic", "x") });
    const ctxA = executeMock.mock.calls[0][1].toolContext;
    const ctxB = executeMock.mock.calls[1][1].toolContext;
    expect(ctxA).not.toBe(ctxB);
    expect(ctxA.workspace).toBe("/tmp/a-updated");
    expect(ctxB.workspace).toBe("/tmp/b");
    expect(ctxA.runtimeBrand.schemaPrefix).toBe("aa");
    expect(ctxB.runtimeBrand.schemaPrefix).toBe("bb");
    // Neither instance published anything to the process-global default context.
    expect(readToolRuntime().workspace).toBeUndefined();
    expect(readToolRuntime().runtimeBrand.schemaPrefix).toBe("agent_runtime");
  });

describe("createRuntime subagent seam", () => {
  const model = modelRef("faux", "m");
  const subagents = {
    definitions: [{ name: "researcher", description: "d", systemPrompt: "child system prompt" }],
  };

  it("supplies a kernel self-run so the Agent tool works without host wiring", async () => {
    executeMock.mockResolvedValue({ text: "ok", events: [] });
    const runtime = createRuntime();
    await runtime.run("parent", { model, subagents });

    const forwarded = executeMock.mock.calls[0][1];
    expect(typeof forwarded.subagents.run).toBe("function");
    expect(forwarded.subagents.definitions).toBe(subagents.definitions);
  });

  it("does not overwrite a host-supplied run callback", async () => {
    executeMock.mockResolvedValue({ text: "ok", events: [] });
    const hostRun = vi.fn();
    const runtime = createRuntime();
    await runtime.run("parent", { model, subagents: { ...subagents, run: hostRun } });

    expect(executeMock.mock.calls[0][1].subagents.run).toBe(hostRun);
  });

  it("runs a child turn one level deeper, with no session or steering state", async () => {
    executeMock.mockResolvedValue({ text: "child answer", events: [] });
    const runtime = createRuntime();
    await runtime.run("parent", { model, subagents });

    const childRun = executeMock.mock.calls[0][1].subagents.run;
    executeMock.mockClear();
    const result = await childRun({
      systemPrompt: "child system prompt",
      prompt: "do the thing",
      definition: { name: "researcher", allowedTools: ["Read"] },
      model,
      maxTurns: 7,
      depth: 1,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(result.text).toBe("child answer");
    const childOptions = executeMock.mock.calls[0][1];
    expect(executeMock.mock.calls[0][0]).toBe("child system prompt");
    expect(childOptions.messages).toEqual([{ role: "user", content: "do the thing" }]);
    expect(childOptions.maxTurns).toBe(7);
    expect(childOptions.allowedTools).toEqual(["Read"]);
    // Depth 1 is what makes getPiBuiltinTools refuse to register Agent for the
    // child, so a subagent can never spawn subagents even via a custom run.
    expect(childOptions.subagents).toEqual({ depth: 1, run: expect.any(Function) });
    expect(childOptions.sessionId).toBeUndefined();
    expect(childOptions.liveInput).toBeUndefined();
  });

  it("confines a child with the parent's sandbox policy", async () => {
    executeMock.mockResolvedValue({ text: "ok", events: [] });
    const runtime = createRuntime();
    await runtime.run("parent", { model, subagents });
    const childRun = executeMock.mock.calls[0][1].subagents.run;

    executeMock.mockClear();
    const sandboxPolicy = { mode: "read-only", network: { mode: "deny" } };
    await childRun({
      systemPrompt: "s",
      prompt: "p",
      definition: { name: "researcher", allowedTools: ["Read"] },
      model,
      maxTurns: 3,
      depth: 1,
      sandboxPolicy,
      sandboxEngine: { id: "srt" },
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(executeMock.mock.calls[0][1]).toMatchObject({ sandboxPolicy, sandboxEngine: { id: "srt" } });
  });

  it("forwards the parent's skill context to a bare-kernel child", async () => {
    // Same reasoning as the sandbox policy: these are per-run options, so a child
    // that does not receive them gets no index and — since ReadSkill is only built
    // when `skills` is non-empty — no way to read one either. Without this the bug
    // is merely relocated from the host path down to the kernel default.
    executeMock.mockResolvedValue({ text: "ok", events: [] });
    const runtime = createRuntime();
    await runtime.run("parent", { model, subagents });
    const childRun = executeMock.mock.calls[0][1].subagents.run;

    executeMock.mockClear();
    const skills = [{ name: "research", description: "Reads the web." }];
    await childRun({
      systemPrompt: "s",
      prompt: "p",
      definition: { name: "researcher", allowedTools: ["Read"] },
      model,
      maxTurns: 3,
      depth: 1,
      skills,
      skillsRoot: "/repo/skills",
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(executeMock.mock.calls[0][1]).toMatchObject({ skills, skillsRoot: "/repo/skills" });
  });
});
});
