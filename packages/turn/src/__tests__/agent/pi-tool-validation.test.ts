import { describe, expect, it, vi } from "vitest";
import { validateToolArguments, validateToolCall, type ToolCall } from "@earendil-works/pi-ai";
import { createStructuredOutputTool } from "../../tools/pi-tools.js";
import { objectSchema } from "../../tools/shared/tool-schema.js";

const parameters = objectSchema({
  title: { type: "string" },
  limit: { type: "integer", minimum: 1 },
  tags: { type: "array", items: { type: "string" } },
  enabled: { type: "boolean" },
}, ["title", "limit", "tags"]);
const call = (args: ToolCall["arguments"]): ToolCall => ({
  type: "toolCall", id: "fictional-call", name: "StructuredOutput", arguments: args,
});

describe("Pi 1.5 plain JSON Schema tool validation", () => {
  it("coerces plain/MCP-style schemas without mutating the transcript or schema", async () => {
    const submitted = vi.fn();
    const tool = createStructuredOutputTool(parameters, submitted)!;
    expect(tool.parameters).toBe(parameters);
    const schemaBefore = structuredClone(parameters);
    const input = call({ title: null, limit: "3.5", tags: "amber", enabled: null });
    const before = structuredClone(input);
    const parsed = validateToolCall([tool], input);
    expect(parsed).toEqual({ title: "null", limit: 3, tags: ["amber"] });
    expect(input).toEqual(before);
    expect(parameters).toEqual(schemaBefore);
    await tool.execute(input.id, parsed);
    expect(submitted).toHaveBeenCalledWith(parsed);
  });

  it("still rejects missing, out-of-range and extra arguments with actionable paths", () => {
    const tool = createStructuredOutputTool(parameters, vi.fn())!;
    expect(() => validateToolArguments(tool, call({ limit: 2, tags: [] })))
      .toThrow('Validation failed for tool "StructuredOutput":\n  - title: missing');
    for (const args of [
      { title: "Fictional", limit: "0", tags: [] },
      { title: "Fictional", limit: "invalid", tags: [] },
      { title: "Fictional", limit: 1, tags: [], undeclared: true },
    ]) expect(() => validateToolArguments(tool, call(args))).toThrow("Validation failed");
  });

  it("rejects malformed final JSON even if its partial arguments satisfy the schema", () => {
    const submitted = vi.fn();
    const tool = createStructuredOutputTool(parameters, submitted)!;
    const partial = call({ title: "Fictional", limit: 1, tags: [] });
    expect(validateToolArguments(tool, partial)).toEqual(partial.arguments);
    expect(() => validateToolArguments(tool, { ...partial, argumentsError: "Unexpected end of JSON input" }))
      .toThrow('Invalid arguments for tool "StructuredOutput": Unexpected end of JSON input');
    expect(submitted).not.toHaveBeenCalled();
  });
});
