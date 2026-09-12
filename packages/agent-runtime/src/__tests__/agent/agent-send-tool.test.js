import { describe, it, expect, vi } from "vitest";
import { createAgentTool, SUBAGENT_HARD_DENY } from "../../agent/tools/agent-tool.js";
import { createAgentSendTool } from "../../agent/tools/agent-send-tool.js";
import { getPiBuiltinTools } from "../../agent/tools/pi-bridge.js";

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
  it("shares the per-turn call budget and permits close-only after exhaustion", async () => {
    const { agent, send, options } = setup({ maxPerTurn: 1 });
    await agent.execute("a", { prompt: "first", persist: true });
    await expect(send.execute("b", { id: "critic-1", message: "second" })).rejects.toThrow(/budget/);
    expect((await send.execute("c", { id: "critic-1", close: true })).content[0].text).toContain("closed");
    expect(options.run).toHaveBeenCalledTimes(1);
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
  it("registers AgentSend next to Agent only with a registry", () => {
    const names = (subagents) => getPiBuiltinTools(undefined, { subagents }).map((tool) => tool.name);
    expect(names(setup().options)).toContain("AgentSend");
    expect(names({ run: vi.fn() })).not.toContain("AgentSend");
  });
});
