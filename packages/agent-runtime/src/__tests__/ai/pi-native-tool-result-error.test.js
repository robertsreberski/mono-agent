import { describe, expect, it } from "vitest";

const { toolResultErrorOverride } = await import("../../ai/providers/pi-native/turn-runner.js");

describe("toolResultErrorOverride", () => {
  it("leaves genuinely successful results alone", () => {
    expect(toolResultErrorOverride(undefined)).toBeUndefined();
    expect(toolResultErrorOverride({})).toBeUndefined();
    expect(toolResultErrorOverride({ outcome: { status: "ok" } })).toBeUndefined();
  });

  it("restores the flag for MCP protocol errors and failed outcomes", () => {
    expect(toolResultErrorOverride({ mcp_result_is_error: true })).toEqual({ isError: true });
    expect(toolResultErrorOverride({ outcome: { status: "error" } })).toEqual({ isError: true });
  });

  it.each(["failed", "timeout", "cancelled", "empty"])(
    "marks a %s subagent as an error so the model is not told it succeeded",
    (status) => {
      // pi resolves every non-throwing execute() as isError:false, so without
      // this the parent sees a failed delegation as a successful tool call.
      expect(toolResultErrorOverride({ tool: "Agent", subagent: { status } })).toEqual({ isError: true });
    },
  );

  it("keeps a successful subagent successful", () => {
    expect(toolResultErrorOverride({ tool: "Agent", subagent: { status: "ok" } })).toBeUndefined();
  });
});
