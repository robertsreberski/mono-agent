import { describe, it, expect, vi } from "vitest";
import { createAskParentTool } from "../../agent/tools/ask-parent-tool.js";
import { getPiBuiltinTools } from "../../agent/tools/pi-bridge.js";
import { createToolContext } from "../../agent/tools/shared/tool-context.js";

const ctx = createToolContext();

describe("AskParent", () => {
  it("requires a controller even when all tools are allowed", () => {
    expect(createAskParentTool()).toBeNull();
    expect(getPiBuiltinTools(["*"], { ctx }).map((tool) => tool.name)).not.toContain("AskParent");
    const options = { askParentController: { submit: vi.fn() } };
    expect(getPiBuiltinTools(["AskParent"], { ...options, ctx }).map((tool) => tool.name)).toContain("AskParent");
    expect(getPiBuiltinTools(["*"], { ...options, ctx, disallowedTools: ["AskParent"] }).map((tool) => tool.name)).not.toContain("AskParent");
  });
  it("awaits durable submission, normalizes options, terminates, and refuses duplicate submissions", async () => {
    let release;
    const submit = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const tool = createAskParentTool({ submit });
    let finished = false;
    const result = tool.execute("q", { question: " Which? ", options: [" A ", "B", "A"] }).then((value) => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(submit).toHaveBeenCalledWith({ question: "Which?", options: ["A", "B"] });
    await expect(tool.execute("again", { question: "again?" })).rejects.toThrow(/already submitted/);
    release();
    expect(await result).toMatchObject({ terminate: true, details: { tool: "AskParent", question: { question: "Which?", options: ["A", "B"] } } });
  });
  it.each([{}, { question: " " }, { question: "x".repeat(2001) }, { question: "q", options: [] },
    { question: "q", options: ["a", " a "] }, { question: "q", options: ["a", ""] },
    { question: "q", options: ["a", "b", "c", "d", "e", "f"] }, { question: "q", options: ["a", "x".repeat(201)] },
    { question: "q", extra: true }])("rejects invalid execute input %j", async (input) => {
    const submit = vi.fn();
    await expect(createAskParentTool({ submit }).execute("q", input)).rejects.toThrow(/AskParent/);
    expect(submit).not.toHaveBeenCalled();
  });
  it("propagates persistence failure without a terminating success", async () => {
    await expect(createAskParentTool({ submit: async () => { throw new Error("disk full"); } }).execute("q", { question: "q" })).rejects.toThrow("disk full");
  });
});

it("retries a rejected publication but refuses duplicates after commit", async () => {
  const submit = vi.fn().mockRejectedValueOnce(new Error("transient write failure")).mockResolvedValue(undefined);
  const tool = createAskParentTool({ submit });
  await expect(tool.execute("first", { question: "Scope?" })).rejects.toThrow("transient write failure");
  expect(await tool.execute("retry", { question: "Scope?" })).toMatchObject({ terminate: true });
  await expect(tool.execute("duplicate", { question: "Again?" })).rejects.toThrow(/already submitted/);
  expect(submit).toHaveBeenCalledTimes(2);
});


it("persistent child exposure stays stable without a current publication controller", async () => {
  const submit = vi.fn();
  const unavailable = createAskParentTool(null, true);
  const available = createAskParentTool({ submit }, true);
  const definition = ({ name, description, parameters }) => JSON.stringify({ name, description, parameters });
  expect(definition(unavailable)).toBe(definition(available));
  await expect(unavailable.execute("no", { question: "Can I proceed?" })).rejects.toThrow(/unavailable/);
  expect(submit).not.toHaveBeenCalled();
});
