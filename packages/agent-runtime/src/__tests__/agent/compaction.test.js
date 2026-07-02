// Pure helpers in agent/compaction.js.
//
// These have no Agent loop / harness dependency, so they are exercised directly.
// estimateFixedOverheadTokens is the budget-aware-compaction helper that accounts
// for the fixed per-request overhead (system prompt + tool/MCP schemas + per-turn
// user messages) the provider meters but the raw transcript estimate excludes.

import { describe, expect, it } from "vitest";
import { estimateFixedOverheadTokens, resolveAgentCompactionPolicy } from "../../agent/compaction.js";

// Mirrors pi-ai's chars/4 heuristic so the expected values are derived, not magic.
const tokensForChars = (value) => Math.ceil(String(value ?? "").length / 4);

describe("estimateFixedOverheadTokens", () => {
  it("counts system prompt, tool schemas, and user messages with the chars/4 heuristic", () => {
    const systemPrompt = "x".repeat(400); // 100 tokens
    const tools = [
      { name: "Read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "Grep", description: "search", inputSchema: { type: "object" } },
    ];
    const messages = [
      { role: "user", content: "hello world" },
      { role: "assistant", content: "ignored? no — every message content is counted" },
      { role: "user", content: "second user turn" },
    ];

    const out = estimateFixedOverheadTokens({ systemPrompt, tools, messages });

    const expectedSystem = tokensForChars(systemPrompt);
    const expectedTools = tools.reduce(
      (sum, tool) => sum + tokensForChars(JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? tool.inputSchema ?? {},
      })),
      0,
    );
    const expectedUsers = messages.reduce(
      (sum, message) => sum + tokensForChars(JSON.stringify(message.content ?? "")),
      0,
    );

    expect(out.systemPromptTokens).toBe(expectedSystem);
    expect(out.toolSchemaTokens).toBe(expectedTools);
    expect(out.userMessageTokens).toBe(expectedUsers);
    expect(out.fixedOverheadTokens).toBe(expectedSystem + expectedTools + expectedUsers);
    expect(expectedSystem).toBe(100);
  });

  it("prefers `parameters`, falls back to `inputSchema`, then to {}", () => {
    const withParameters = estimateFixedOverheadTokens({
      tools: [{ name: "A", description: "d", parameters: { p: 1 }, inputSchema: { other: 2 } }],
    });
    const withInputSchema = estimateFixedOverheadTokens({
      tools: [{ name: "A", description: "d", inputSchema: { other: 2 } }],
    });
    const withNeither = estimateFixedOverheadTokens({
      tools: [{ name: "A", description: "d" }],
    });

    expect(withParameters.toolSchemaTokens).toBe(
      tokensForChars(JSON.stringify({ name: "A", description: "d", parameters: { p: 1 } })),
    );
    expect(withInputSchema.toolSchemaTokens).toBe(
      tokensForChars(JSON.stringify({ name: "A", description: "d", parameters: { other: 2 } })),
    );
    expect(withNeither.toolSchemaTokens).toBe(
      tokensForChars(JSON.stringify({ name: "A", description: "d", parameters: {} })),
    );
  });

  it("counts a circular tool schema as 0 instead of throwing", () => {
    const circular = { name: "loop", description: "d" };
    circular.parameters = circular; // self-reference -> JSON.stringify throws
    const out = estimateFixedOverheadTokens({ tools: [circular] });
    expect(out.toolSchemaTokens).toBe(0);
    expect(out.fixedOverheadTokens).toBe(0);
  });

  it("returns all-zero for empty/undefined input", () => {
    expect(estimateFixedOverheadTokens()).toEqual({
      systemPromptTokens: 0,
      toolSchemaTokens: 0,
      userMessageTokens: 0,
      fixedOverheadTokens: 0,
    });
    expect(estimateFixedOverheadTokens({ systemPrompt: "", tools: [], messages: [] })).toEqual({
      systemPromptTokens: 0,
      toolSchemaTokens: 0,
      userMessageTokens: 0,
      fixedOverheadTokens: 0,
    });
  });

  it("handles array-shaped user content (text blocks) by stringifying it", () => {
    const content = [{ type: "text", text: "describe this" }, { type: "image", data: "B64" }];
    const out = estimateFixedOverheadTokens({ messages: [{ role: "user", content }] });
    expect(out.userMessageTokens).toBe(tokensForChars(JSON.stringify(content)));
  });
});

describe("resolveAgentCompactionPolicy MCP call timeouts", () => {
  it("defaults mcpCallMaxTotalTimeoutMs to 45 minutes, separate from the 120s inactivity cap", () => {
    const policy = resolveAgentCompactionPolicy({}, null);
    expect(policy.mcpCallTimeoutMs).toBe(120_000);
    expect(policy.mcpCallMaxTotalTimeoutMs).toBe(2_700_000);
  });

  it("reads agent_mcp_call_max_total_timeout_ms from settings and falls back on junk", () => {
    const policy = resolveAgentCompactionPolicy({ agent_mcp_call_max_total_timeout_ms: 300_000 }, null);
    expect(policy.mcpCallMaxTotalTimeoutMs).toBe(300_000);
    const junk = resolveAgentCompactionPolicy({ agent_mcp_call_max_total_timeout_ms: "soon" }, null);
    expect(junk.mcpCallMaxTotalTimeoutMs).toBe(2_700_000);
  });
});
