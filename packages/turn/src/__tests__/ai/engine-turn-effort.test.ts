import type { RuntimeSubagentRunRequest } from "../../contracts/runtime.js";
import { describe, expect, it } from "vitest";

import { createToolContext } from "../../tools/shared/tool-context.js";
import { buildTurnTools, thinkingLevelForEffort } from "../../execution/pi/turn-runner.js";

describe("thinkingLevelForEffort", () => {
  it("keeps the documented ultra mapping specific to reasoning-capable Pi models", () => {
    expect(thinkingLevelForEffort("ultra", { reasoning: true })).toBe("low");
    expect(thinkingLevelForEffort("ultra", { reasoning: false })).toBe("off");
    expect(thinkingLevelForEffort("ultra", { reasoning: true, reasoning_mode: "none" })).toBe("off");
  });
});


it("forwards the effective turn model and effort through the real Agent tool builder", async () => {
  const requests: RuntimeSubagentRunRequest[] = [];
  const model = { provider: "anthropic", model: "parent", reference: "anthropic:parent" };
  const built = await buildTurnTools({}, {
    // The Pi provider always hands buildTurnTools an explicit per-run context.
    options: { model, effort: "xhigh", allowedTools: ["Agent"], toolContext: createToolContext(),
      subagents: { run: async (request: RuntimeSubagentRunRequest) => { requests.push(request); return { text: "ok" }; } },
    },
    capabilities: {}, toolLimits: {}, runtime: {}, resolved: model,
    onEvent: () => {}, runtimeWarnings: [],
  });
  try {
    await built.tools.find((tool) => tool.name === "Agent").execute("inherit", { prompt: "x" });
    expect(requests[0]).toMatchObject({ model, effort: "xhigh" });
  } finally {
    await built.closeRunTools();
  }
});
