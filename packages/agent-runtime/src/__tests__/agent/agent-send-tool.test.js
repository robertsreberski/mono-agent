import { describe, it, expect, vi } from "vitest";
import { createAgentTool, SUBAGENT_HARD_DENY } from "../../agent/tools/agent-tool.js";
import { createAgentSendTool } from "../../agent/tools/agent-send-tool.js";
import { getPiBuiltinTools } from "../../agent/tools/pi-bridge.js";
import { createToolContext } from "../../agent/tools/shared/tool-context.js";

const ctx = createToolContext();

function setup(overrides = {}) {
  const records = new Map();
  const instances = {
    list: vi.fn(async () => [...records.values()]),
    get: vi.fn(async (id) => records.get(id)),
    create: vi.fn(async (spec) => {
      const id = spec.id ?? "critic-1";
      if (records.has(id)) throw new Error("Duplicate instance; Live ids: critic-1");
      const record = { ...spec, id, sessionId: "sub-test", sessionsRoot: "/test/sessions", status: "idle", turns: 0, updatedAt: Date.now() - 120_000 };
      records.set(id, record); return record;
    }),
    begin: vi.fn(async (id) => { const r = records.get(id); if (r.status === "running") throw new Error("busy"); r.status = "running"; return r; }),
    finish: vi.fn(async (id, outcome) => { const r = records.get(id); r.status = "idle"; r.turns++; r.lastStatus = outcome.status; return r; }),
    close: vi.fn(async (id) => { const r = records.get(id); r.status = "closed"; return r; }),
  };
  const options = { instances, run: vi.fn(async () => ({ text: "answer" })), ...overrides };
  const context = { parentRunId: "parent" };
  return { records, instances, options, agent: createAgentTool(options, context), send: createAgentSendTool(options, context) };
}
describe("persistent Agent and AgentSend", () => {
  it("preserves stateless registration and gates persistence and recursion", async () => {
    const options = { run: vi.fn() };
    const agent = createAgentTool(options);
    expect(agent.parameters.properties.persist).toBeUndefined();
    expect(agent.parameters.properties.id).toBeUndefined();
    await expect(agent.execute("a", { prompt: "x", persist: false })).rejects.toThrow(/unavailable/);
    await expect(agent.execute("a", { prompt: "x", id: "a" })).rejects.toThrow(/unavailable/);
    expect(createAgentSendTool(options)).toBeNull();
    expect(createAgentTool({ ...setup().options, depth: 1 })).toBeNull();
    expect(createAgentSendTool({ ...setup().options, depth: 1 })).toBeNull();
    expect(SUBAGENT_HARD_DENY).toContain("AgentSend");
  });
  it("creates, resumes a stored definition, reports turns and closes", async () => {
    const { agent, send, options, instances } = setup();
    const first = await agent.execute("a", { prompt: "first", persist: true, id: "critic-1" });
    expect(first.content[0].text).toContain("instance critic-1 · turn 1");
    expect(first.details.subagent.instance).toEqual({ id: "critic-1", turns: 1, status: "idle" });
    const second = await send.execute("b", { id: "critic-1", message: "second", close: true });
    expect(second.content[0].text).toContain("instance critic-1 · turn 2 · closed");
    expect(options.run.mock.calls[1][0]).toMatchObject({ instance: { sessionId: "sub-test", sessionsRoot: "/test/sessions" } });
    expect(options.run.mock.calls[1][0].prompt).toMatch(/turn 2; 2 min.*Prior context is retained\.\n\nsecond/);
    expect(instances.finish).toHaveBeenCalledTimes(2);
    expect(second.details.tool).toBe("AgentSend");
  });
  it("continues the stored profile without resolving general-purpose against the current ceiling", async () => {
    const profile = { name: "writer", description: "Writes", systemPrompt: "Write", allowedTools: ["Bash"] };
    const { agent, send, options } = setup({ definitions: [profile], inline: { allowedTools: ["Bash"] } });
    await agent.execute("a", { prompt: "first", name: "writer", persist: true, id: "writer-1" });
    const result = await send.execute("b", { id: "writer-1", message: "continue" });
    expect(result.details.subagent.status).toBe("ok");
    expect(options.run.mock.calls[1][0].definition.allowedTools).toEqual(["Bash"]);
  });
  it("keeps stateless concurrency limits independent across parent turns", async () => {
    let release;
    const gate = new Promise((done) => { release = done; });
    const options = { maxConcurrent: 1, run: vi.fn(async () => { await gate; return { text: "done" }; }) };
    const first = createAgentTool(options, { parentRunId: "one" }).execute("a", { prompt: "a" });
    const second = createAgentTool(options, { parentRunId: "two" }).execute("b", { prompt: "b" });
    try { await vi.waitFor(() => expect(options.run).toHaveBeenCalledTimes(2)); }
    finally { release(); await Promise.all([first, second]); }
  });

  it("shares the per-turn call budget and permits close-only after exhaustion", async () => {
    const { agent, send, options } = setup({ maxPerTurn: 1 });
    await agent.execute("a", { prompt: "first", persist: true });
    await expect(send.execute("b", { id: "critic-1", message: "second" })).rejects.toThrow(/budget/);
    expect((await send.execute("c", { id: "critic-1", close: true })).content[0].text).toContain("closed");
    expect(options.run).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["busy", { failureKind: "session_busy" }],
    ["provider error", { error: "provider failed" }],
    ["continuity loss", { failureKind: "session_continuity_lost", error: "lost" }],
    ["cancelled", { cancelled: true }],
    ["empty", { text: "" }],
  ])("retains the live transcript when message+close returns %s", async (_label, outcome) => {
    const { agent, send, options, instances } = setup();
    await agent.execute("a", { prompt: "first", persist: true });
    options.run.mockResolvedValueOnce(outcome);
    await send.execute("b", { id: "critic-1", message: "last", close: true });
    expect(instances.close).not.toHaveBeenCalled();
    expect((await instances.get("critic-1")).status).toBe("idle");
  });
  it("retains message+close after thrown errors and cooperative timeouts", async () => {
    const { agent, send, options, instances } = setup({ timeoutMs: 10 });
    await agent.execute("a", { prompt: "first", persist: true });
    options.run.mockRejectedValueOnce(new Error("failed"));
    await send.execute("b", { id: "critic-1", message: "last", close: true });
    options.run.mockImplementationOnce(async ({ abortSignal }) => {
      await new Promise((done) => abortSignal.addEventListener("abort", done, { once: true }));
      return { text: "partial", cancelled: true };
    });
    await send.execute("c", { id: "critic-1", message: "last", close: true });
    expect(instances.close).not.toHaveBeenCalled();
  });
  it("keeps message+close live when the parent cancels", async () => {
    const { agent, send, options, instances } = setup();
    await agent.execute("a", { prompt: "first", persist: true });
    const controller = new AbortController();
    options.run.mockImplementationOnce(async () => { controller.abort(); return { text: "answer" }; });
    await expect(send.execute("b", { id: "critic-1", message: "last", close: true }, controller.signal)).rejects.toThrow(/aborted/);
    expect(instances.close).not.toHaveBeenCalled();
    expect(instances.finish).toHaveBeenLastCalledWith("critic-1", expect.objectContaining({ status: "cancelled" }));
  });
  it("attributes spilled continuation output to AgentSend", async () => {
    const { agent, options } = setup();
    await agent.execute("a", { prompt: "first", persist: true });
    options.run.mockResolvedValueOnce({ text: "output ".repeat(20_000) });
    const persistArtifact = vi.fn(() => "/artifacts/continued.txt");
    const send = createAgentSendTool(options, { parentRunId: "next", persistArtifact });
    const result = await send.execute("send-id", { id: "critic-1", message: "more" });
    expect(persistArtifact).toHaveBeenCalledWith(expect.objectContaining({ filename: "AgentSend__send-id__full.txt", toolName: "AgentSend", toolUseId: "send-id" }));
    expect(result.details.tool_payload_saved_paths).toContain("/artifacts/continued.txt");
  });

  it("rejects unknown, busy, closed, duplicate, and invalid requests", async () => {
    const { agent, send, records } = setup();
    await expect(send.execute("a", { id: "unknown", message: "x" })).rejects.toThrow(/Live ids: none/);
    await expect(send.execute("a", { id: "x" })).rejects.toThrow(/message is required/);
    await expect(agent.execute("a", { prompt: "first", id: "x" })).rejects.toThrow(/requires persist/);
    await agent.execute("a", { prompt: "first", persist: true });
    await expect(agent.execute("b", { prompt: "x", persist: true })).rejects.toThrow(/Duplicate/);
    records.get("critic-1").status = "running";
    await expect(send.execute("b", { id: "critic-1", message: "x" })).rejects.toThrow(/busy/);
    records.get("critic-1").status = "expired";
    await expect(send.execute("b", { id: "critic-1", message: "x" })).rejects.toThrow(/expired/);
  });
  it("maps provider busy results without reporting success", async () => {
    const { agent, instances } = setup({ run: vi.fn(async () => ({ failureKind: "session_busy" })) });
    const result = await agent.execute("a", { prompt: "x", persist: true });
    expect(result.details.subagent.status).toBe("busy");
    expect(instances.finish.mock.calls[0][1].status).toBe("busy");
  });
  it.each([
    [["Agent"], [], false], [["*"], ["AgentSend"], false], [["*"], [], true],
  ])("gates persistence at the effective pi tool boundary: %j/%j", async (allowed, denied, enabled) => {
    const { options } = setup();
    const tools = getPiBuiltinTools(allowed, { ctx, disallowedTools: denied, subagents: options });
    const agent = tools.find((tool) => tool.name === "Agent");
    expect(agent.parameters.properties.persist !== undefined).toBe(enabled);
    expect(tools.some((tool) => tool.name === "AgentSend")).toBe(enabled);
    if (!enabled) {
      expect(agent.description).not.toContain("AgentSend");
      await expect(agent.execute("denied", { prompt: "x", persist: true })).rejects.toThrow(/unavailable/);
    }
  });
  it("registers AgentSend next to Agent only with a registry", () => {
    const names = (subagents) => getPiBuiltinTools(undefined, { ctx, subagents }).map((tool) => tool.name);
    expect(names(setup().options)).toContain("AgentSend");
    expect(names({ run: vi.fn() })).not.toContain("AgentSend");
  });
});

it("closes an awaiting instance without running an answer, but keeps a new question open", async () => {
  const first = setup();
  await first.agent.execute("a", { persist: true, id: "critic", prompt: "review" });
  Object.assign(first.records.get("critic"), { status: "awaiting_reply", pendingQuestion: { question: "Scope?" } });
  await first.send.execute("close", { id: "critic", close: true });
  expect(first.options.run).toHaveBeenCalledTimes(1);
  expect(first.instances.close).toHaveBeenCalledWith("critic");

  const second = setup();
  await second.agent.execute("a", { persist: true, id: "critic", prompt: "review" });
  second.options.run.mockResolvedValue({ text: "", subagentQuestion: { question: "Another?" } });
  const result = await second.send.execute("answer", { id: "critic", message: "API", close: true });
  expect(result.details.subagent).toMatchObject({ status: "awaiting_reply", question: { question: "Another?" } });
  expect(second.instances.finish).toHaveBeenLastCalledWith("critic", expect.objectContaining({ status: "awaiting_reply", question: { question: "Another?" } }));
  expect(second.instances.close).not.toHaveBeenCalled();
});

describe("AgentSend recovery boundary", () => {
  it("passes only host access to inspection and never invokes a provider", async () => {
    const f = setup(); const recoveryAccess = { host: true };
    f.instances.inspect = vi.fn(async () => ({ schema: "mono-agent.subagent-recovery.v1", status: "held" }));
    const send = createAgentSendTool(f.options, { recoveryAccess });
    const result = await send.execute("inspect", { id: "helper", inspect: true });
    expect(result.details).toMatchObject({ executed: false, recovery: { status: "held" } });
    expect(f.instances.inspect).toHaveBeenCalledWith("helper", recoveryAccess);
    expect(f.instances.get).not.toHaveBeenCalled(); expect(f.options.run).not.toHaveBeenCalled();
  });
  it.each([{ message: "next" }, { close: false }, { background: false }, { ack: "token" }, { description: "purpose" }])(
    "rejects mixed inspection semantics %j without execution", async (extra) => {
      const f = setup(); f.instances.inspect = vi.fn();
      await expect(createAgentSendTool(f.options).execute("inspect", { id: "helper", inspect: true, ...extra })).rejects.toThrow("inspect must be used alone");
      expect(f.instances.inspect).not.toHaveBeenCalled(); expect(f.options.run).not.toHaveBeenCalled();
    },
  );
  it.each(["subagent_recovery_already_consumed", "subagent_recovery_ack_conflict", "subagent_recovery_ack_stale"])(
    "returns typed %s before busy lookup and never replays a receipt", async (code) => {
      const f = setup(); f.instances.checkAcknowledgement = vi.fn(async () => { throw Object.assign(new Error(code), { code }); });
      const request = { id: "helper", ack: "token", message: "exact bytes ", background: true, close: false, description: "purpose" };
      const result = await createAgentSendTool(f.options).execute("ack", request);
      expect(result.details).toEqual({ tool: "AgentSend", recovery: { code }, executed: false });
      expect(f.instances.checkAcknowledgement).toHaveBeenCalledWith("helper", { ack: "token", message: "exact bytes ", background: true, close: false, description: "purpose" }, undefined);
      expect(f.instances.get).not.toHaveBeenCalled(); expect(f.options.run).not.toHaveBeenCalled();
    },
  );
});


it("keeps optional continuation definitions stable and refuses unavailable operations before instance access", async () => {
  const { options, instances } = setup();
  const context = { persistentExposure: true };
  const unavailable = createAgentSendTool({ run: options.run }, context);
  const current = createAgentSendTool(options, context);
  const capable = createAgentSendTool({ ...options, instances: { ...instances, reserve: vi.fn(), releaseReservation: vi.fn(), inspect: vi.fn(), checkAcknowledgement: vi.fn() }, backgroundSubagentController: {} }, context);
  const definition = ({ name, description, parameters }) => JSON.stringify({ name, description, parameters });
  expect(definition(current)).toBe(definition(unavailable)); expect(definition(capable)).toBe(definition(current));
  await expect(unavailable.execute("no", { id: "x", message: "work" })).rejects.toThrow(/unavailable/);
  await expect(current.execute("no", { id: "x", message: "work", background: true })).rejects.toThrow(/unavailable/);
  await expect(current.execute("no", { id: "x", inspect: true })).rejects.toThrow(/unavailable/);
  expect(instances.get).not.toHaveBeenCalled(); expect(options.run).not.toHaveBeenCalled();
});


describe("AgentSend stop", () => {
  it.each([
    [{ message: "next" }, "message"], [{ close: false }, "close"], [{ background: false }, "background"],
    [{ inspect: false }, "inspect"], [{ ack: "token" }, "ack"], [{ jobId: "arbitrary" }, "jobId"],
    [{ message: "next", ack: "token" }, "ack, message"],
  ])("stop rejects unexpected parameters before instance access: %j", async (extra, keys) => {
    const f = setup();
    const result = await f.send.execute("stop", { id: "helper", stop: true, ...extra });
    const stop = { code: "subagent_stop_unexpected_parameters", instanceId: "helper", jobId: null, stopRequested: false,
      message: `stop takes only id and optional description (unexpected: ${keys}).` };
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: JSON.stringify(stop) }],
      details: { tool: "AgentSend", executed: false, stop } });
    expect(f.instances.get).not.toHaveBeenCalled(); expect(f.options.run).not.toHaveBeenCalled();
  });
  it.each([
    ...[false, undefined, null, "true", 1].map((stop) => [{ stop }, "subagent_stop_not_requested", "stop must be exactly true."]),
    ...[undefined, null, 1, "", "Helper", "-helper", "has space", "a".repeat(41)].map((id) => [{ id }, "subagent_stop_invalid_id",
      "id must be a string matching ^[a-z0-9][a-z0-9-]{0,39}$ (1-40 lowercase letters, digits or hyphens, starting with a letter or digit)."]),
    ...[null, 1, "a".repeat(81)].map((description) => [{ description }, "subagent_stop_invalid_request",
      "description must be a string of at most 80 characters."]),
  ])("stop explains invalid declared parameters before instance access: %j", async (extra, code, message) => {
    const f = setup();
    const params = { id: "helper", stop: true, ...extra };
    const result = await f.send.execute("stop", params);
    const stop = { code, instanceId: typeof params.id === "string" ? params.id : null, jobId: null, stopRequested: false, message };
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: JSON.stringify(stop) }],
      details: { tool: "AgentSend", executed: false, stop } });
    expect(f.instances.get).not.toHaveBeenCalled(); expect(f.options.run).not.toHaveBeenCalled();
  });
  it.each([undefined, "stop", "", "a".repeat(80)])("accepts and ignores description on the real stop path: %j", async (description) => {
    const stop = vi.fn();
    const f = setup({ backgroundSubagentController: { stop } });
    const plainMissing = await f.send.execute("plain", { id: "helper", stop: true });
    const describedMissing = await f.send.execute("described", { id: "helper", stop: true, description });
    expect(describedMissing).toEqual(plainMissing);
    expect(describedMissing.details.stop.code).toBe("subagent_stop_instance_not_found");
    f.records.set("helper", { id: "helper", status: "idle", turns: 1, lastStatus: "ok" });
    const plainIdle = await f.send.execute("plain", { id: "helper", stop: true });
    const describedIdle = await f.send.execute("described", { id: "helper", stop: true, description });
    expect(describedIdle).toEqual(plainIdle);
    expect(describedIdle.details.stop.status).toBe("already_idle");
    expect(f.instances.get).toHaveBeenCalledTimes(4);
    expect(f.instances.get).toHaveBeenCalledWith("helper");
    expect(stop).not.toHaveBeenCalled(); expect(f.options.run).not.toHaveBeenCalled();
  });
  it("stop unavailable does not execute", async () => {
    const f = setup();
    const result = await f.send.execute("stop", { id: "helper", stop: true });
    expect(result.details).toEqual({ tool: "AgentSend", executed: false, stop: { code: "subagent_stop_unavailable", instanceId: "helper", jobId: null, stopRequested: false } });
    expect(result.isError).toBe(true); expect(f.options.run).not.toHaveBeenCalled();
  });
  it.each([{}, { description: "stop" }])("resolves only the captured active turn and returns bounded busy evidence: %j", async (extra) => {
    const stop = vi.fn(async () => ({ jobId: "owned-token", stopRequested: true, childStillBusy: true, resumable: false, disposition: "cancelled" }));
    const f = setup({ backgroundSubagentController: { stop } });
    f.records.set("helper", { id: "helper", incarnation: "epoch", status: "running", turns: 1, activeTurn: { kind: "detached", token: "owned-token" } });
    const result = await f.send.execute("stop", { id: "helper", stop: true, ...extra });
    expect(f.instances.get).toHaveBeenCalledWith("helper");
    expect(stop).toHaveBeenCalledWith({ instanceId: "helper", instanceIncarnation: "epoch", turnToken: "owned-token" });
    expect(result.details).toEqual({ tool: "AgentSend", executed: false, stop: { instanceId: "helper", jobId: "owned-token", status: "stop_requested", instanceStatus: "running", turns: 1, disposition: "cancelled", stopRequested: true, childStillBusy: true, resumable: false } });
    expect(JSON.parse(result.content[0].text)).toEqual(result.details.stop);
    expect(f.options.run).not.toHaveBeenCalled();
    await expect(f.send.execute("message", { id: "helper", message: "next" })).rejects.toThrow("busy");
    await expect(f.send.execute("close", { id: "helper", close: true })).rejects.toThrow("busy");
  });
  it.each([false, true])("accepts only the exact settled turn certificate (successor=%s)", async (successor) => {
    const f = setup();
    f.records.set("helper", { id: "helper", incarnation: "epoch", status: "running", turns: 0, activeTurn: { kind: "detached", token: "owned-token" } });
    f.options.backgroundSubagentController = { stop: async () => {
      f.records.set("helper", { id: "helper", incarnation: "epoch", status: "idle", turns: 1, settledTurnToken: successor ? "successor" : "owned-token" });
      return { jobId: "owned-token", stopRequested: true, childStillBusy: false, resumable: true, disposition: "cancelled" };
    } };
    const result = await createAgentSendTool(f.options).execute("stop", { id: "helper", stop: true });
    if (successor) expect(result).toMatchObject({ isError: true, details: { stop: { code: "subagent_stale_turn" } } });
    else expect(result.details).toEqual({ tool: "AgentSend", executed: false, stop: { instanceId: "helper", jobId: "owned-token", status: "stopped", instanceStatus: "idle", turns: 1, disposition: "cancelled", stopRequested: true, childStillBusy: false, resumable: true } });
    expect(f.options.run).not.toHaveBeenCalled();
  });
  it("bounds controller/storage hangs without claiming acceptance", async () => {
    vi.useFakeTimers();
    try {
      const f = setup({ backgroundSubagentController: { stop: vi.fn(() => new Promise(() => {})) } });
      f.records.set("helper", { id: "helper", incarnation: "epoch", status: "running", turns: 1, activeTurn: { kind: "detached", token: "owned-token" } });
      const result = f.send.execute("stop", { id: "helper", stop: true });
      await vi.advanceTimersByTimeAsync(6000);
      expect(await result).toMatchObject({ isError: true, details: { stop: { code: "subagent_stop_unavailable", stopRequested: "unknown" } } });
    } finally { vi.useRealTimers(); }
  });
});
