// Pure helpers in agent/compaction.js.
//
// These have no Agent loop / harness dependency, so they are exercised directly.
// estimateFixedOverheadTokens is the budget-aware-compaction helper that accounts
// for the fixed per-request overhead (system prompt + tool/MCP schemas + per-turn
// user messages) the provider meters but the raw transcript estimate excludes.

import { describe, expect, it } from "vitest";
import {
  estimateFixedOverheadTokens,
  liftCompactionCeilingFloor,
  resolveAgentCompactionPolicy,
} from "../../agent/compaction.js";

// Mirrors pi-ai's chars/4 heuristic so the expected values are derived, not magic.
const tokensForChars = (value: unknown) => Math.ceil(String(value ?? "").length / 4);

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
    const circular: { name: string; description: string; parameters?: unknown } = { name: "loop", description: "d" };
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
    const policy = resolveAgentCompactionPolicy({}, null as unknown as Parameters<typeof resolveAgentCompactionPolicy>[1]);
    expect(policy.mcpCallTimeoutMs).toBe(120_000);
    expect(policy.mcpCallMaxTotalTimeoutMs).toBe(2_700_000);
  });

  it("reads agent_mcp_call_max_total_timeout_ms from settings and falls back on junk", () => {
    const policy = resolveAgentCompactionPolicy({ toolLimits: { mcpCallMaxTotalTimeoutMs: 300_000 } }, null as unknown as Parameters<typeof resolveAgentCompactionPolicy>[1]);
    expect(policy.mcpCallMaxTotalTimeoutMs).toBe(300_000);
    const junk = resolveAgentCompactionPolicy({ toolLimits: { mcpCallMaxTotalTimeoutMs: "soon" as unknown as number } }, null as unknown as Parameters<typeof resolveAgentCompactionPolicy>[1]);
    expect(junk.mcpCallMaxTotalTimeoutMs).toBe(2_700_000);
  });

  it("resolves fixedOverheadEnabled (default true, false only when explicitly disabled)", () => {
    expect(resolveAgentCompactionPolicy({}, null as unknown as Parameters<typeof resolveAgentCompactionPolicy>[1]).fixedOverheadEnabled).toBe(true);
    expect(resolveAgentCompactionPolicy({ compaction: { fixedOverheadEnabled: false } }, null as unknown as Parameters<typeof resolveAgentCompactionPolicy>[1]).fixedOverheadEnabled).toBe(false);
    // Any non-false value keeps the default-on behavior.
    expect(resolveAgentCompactionPolicy({ compaction: { fixedOverheadEnabled: true } }, null as unknown as Parameters<typeof resolveAgentCompactionPolicy>[1]).fixedOverheadEnabled).toBe(true);
  });
});

describe("resolveAgentCompactionPolicy adaptive defaults", () => {
  // Windows whose window-derived trigger exceeds the default 200k absolute
  // ceiling compact at the ceiling instead.
  const cases = [
    { window: 32_000, trigger: 16_000, source: "reserve", keep: 4_000, summary: 2_000, savings: 4_000 },
    { window: 128_000, trigger: 112_000, source: "reserve", keep: 12_800, summary: 5_120, savings: 12_800 },
    { window: 200_000, trigger: 180_000, source: "ratio", keep: 20_000, summary: 8_000, savings: 20_000 },
    { window: 272_000, trigger: 200_000, source: "max_input_tokens", keep: 20_000, summary: 10_880, savings: 20_000 },
    { window: 372_000, trigger: 200_000, source: "max_input_tokens", keep: 20_000, summary: 12_000, savings: 20_000 },
    { window: 400_000, trigger: 200_000, source: "max_input_tokens", keep: 20_000, summary: 12_000, savings: 20_000 },
  ];

  for (const row of cases) {
    it(`derives conservative defaults for a ${row.window}-token window`, () => {
      const policy = resolveAgentCompactionPolicy({}, { contextWindow: row.window });
      expect(policy).toMatchObject({
        enabled: true,
        contextWindow: row.window,
        triggerRatio: 0.90,
        triggerTokens: row.trigger,
        triggerSource: row.source,
        maxInputTokens: 200_000,
        keepRecentTokens: row.keep,
        summaryMaxTokens: row.summary,
        compactionMinSavingsTokens: row.savings,
        fixedOverheadEnabled: true,
      });
    });
  }

  it("lets every explicit scalar override its adaptive value while retaining existing clamps", () => {
    const policy = resolveAgentCompactionPolicy({ compaction: { enabled: false, triggerRatio: 0.8, maxInputTokens: 300_000, keepRecentTokens: 9_000, summaryMaxTokens: 3_000, minSavingsTokens: 7_000, fixedOverheadEnabled: false } }, { contextWindow: 372_000 });
    // The ratio arm binds here: floor(372000 * 0.8) = 297,600 < the 372000 -
    // 37200 = 334,800 reserve arm and < the configured 300,000 ceiling. (Before
    // the scale-aware headroom the 25% reserve arm capped this at 279,000,
    // making ratios above 0.75 inert.)
    expect(policy).toMatchObject({
      enabled: false,
      triggerRatio: 0.8,
      triggerTokens: 297_600,
      triggerSource: "ratio",
      maxInputTokens: 300_000,
      keepRecentTokens: 9_000,
      summaryMaxTokens: 3_000,
      compactionMinSavingsTokens: 7_000,
      fixedOverheadEnabled: false,
    });
  });

  it("honors a configured 0.9 on large windows while the 16k floor still protects small ones", () => {
    // The absolute ceiling is disabled here so the window arms are visible.
    // 272k: headroom floor(27200) < ratio arm, so the full 0.9 binds.
    expect(resolveAgentCompactionPolicy(
      { compaction: { triggerRatio: 0.9, maxInputTokens: 0 } },
      { contextWindow: 272_000 },
    ).triggerTokens).toBe(244_800);
    // 400k: headroom hits the 48k ceiling; the ratio arm still binds.
    expect(resolveAgentCompactionPolicy(
      { compaction: { triggerRatio: 0.9, maxInputTokens: 0 } },
      { contextWindow: 400_000 },
    ).triggerTokens).toBe(360_000);
    // 32k: the 16k headroom floor binds, so the trigger stays at half the window.
    expect(resolveAgentCompactionPolicy(
      { compaction: { triggerRatio: 0.9 } },
      { contextWindow: 32_000 },
    ).triggerTokens).toBe(16_000);
    // 128k: the 16k floor holds the trigger at 87.5% of the window.
    expect(resolveAgentCompactionPolicy(
      { compaction: { triggerRatio: 0.9 } },
      { contextWindow: 128_000 },
    ).triggerTokens).toBe(112_000);
  });

  it("always keeps triggerTokens strictly below the context window", () => {
    // The compaction driver maps triggerTokens to
    // reserveTokens = contextWindow - triggerTokens + 1 and depends on the
    // trigger staying below the window (reserveTokens >= 2). Headroom is at
    // least 16,000 tokens, so both arms stay below the window for every
    // supported window and every ratio in [0.2, 0.95].
    const windows = [32_000, 64_000, 128_000, 200_000, 272_000, 372_000, 400_000, 1_000_000];
    const ratios = [0.2, 0.5, 0.7, 0.75, 0.8, 0.9, 0.95];
    for (const window of windows) {
      for (const ratio of ratios) {
        for (const maxInputTokens of [undefined, 0, 32_000, 10_000_000]) {
          const policy = resolveAgentCompactionPolicy(
            { compaction: { triggerRatio: ratio, ...(maxInputTokens === undefined ? {} : { maxInputTokens }) } },
            { contextWindow: window },
          );
          expect(policy.triggerTokens).toBeLessThan(policy.contextWindow);
          expect(policy.triggerTokens).toBeLessThanOrEqual(policy.windowTriggerTokens);
          expect(policy.contextWindow - policy.triggerTokens + 1).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});

describe("resolveAgentCompactionPolicy absolute maxInputTokens ceiling", () => {
  // window, today's (ceiling-free) trigger and its binding arm.
  const windows = [
    { window: 32_000, today: 16_000, todaySource: "reserve" },
    { window: 128_000, today: 112_000, todaySource: "reserve" },
    { window: 200_000, today: 180_000, todaySource: "ratio" },
    { window: 272_000, today: 244_800, todaySource: "ratio" },
    { window: 400_000, today: 360_000, todaySource: "ratio" },
    { window: 1_000_000, today: 900_000, todaySource: "ratio" },
    { window: 2_000_000, today: 1_800_000, todaySource: "ratio" },
  ];
  const settings = [
    { name: "default", compaction: {}, ceiling: 200_000 },
    { name: "overridden 300k", compaction: { maxInputTokens: 300_000 }, ceiling: 300_000 },
    { name: "opt-out 0", compaction: { maxInputTokens: 0 }, ceiling: 0 },
  ];

  for (const row of windows) {
    for (const setting of settings) {
      it(`resolves the ${setting.name} ceiling for a ${row.window}-token window`, () => {
        const policy = resolveAgentCompactionPolicy({ compaction: setting.compaction }, { contextWindow: row.window });
        const binds = setting.ceiling > 0 && setting.ceiling < row.today;
        expect(policy).toMatchObject({
          contextWindow: row.window,
          windowTriggerTokens: row.today,
          maxInputTokens: setting.ceiling,
          triggerTokens: binds ? setting.ceiling : row.today,
          triggerSource: binds ? "max_input_tokens" : row.todaySource,
        });
        // The ceiling never touches the drain budgets or the window itself.
        const baseline = resolveAgentCompactionPolicy({ compaction: { maxInputTokens: 0 } }, { contextWindow: row.window });
        expect({ ...policy, triggerTokens: 0, triggerSource: "", maxInputTokens: 0 })
          .toEqual({ ...baseline, triggerTokens: 0, triggerSource: "", maxInputTokens: 0 });
      });
    }
  }

  it("drains a 1M window through the existing summary and retained-tail budgets", () => {
    const policy = resolveAgentCompactionPolicy({}, { contextWindow: 1_000_000 });
    expect(policy).toMatchObject({ triggerTokens: 200_000, keepRecentTokens: 20_000, summaryMaxTokens: 12_000, compactionMinSavingsTokens: 20_000 });
  });

  it("treats omitted or null as the default and clamps non-zero values into 32k-10M", () => {
    const window = { contextWindow: 2_000_000 };
    expect(resolveAgentCompactionPolicy({ compaction: { maxInputTokens: null as unknown as number } }, window).maxInputTokens).toBe(200_000);
    expect(resolveAgentCompactionPolicy({ compaction: { maxInputTokens: "soon" as unknown as number } }, window).maxInputTokens).toBe(200_000);
    expect(resolveAgentCompactionPolicy({ compaction: { maxInputTokens: 1_000 } }, window).maxInputTokens).toBe(32_000);
    expect(resolveAgentCompactionPolicy({ compaction: { maxInputTokens: 20_000_000 } }, window).maxInputTokens).toBe(10_000_000);
  });
});

describe("liftCompactionCeilingFloor", () => {
  const ceilingPolicy = () => resolveAgentCompactionPolicy({}, { contextWindow: 1_000_000 });

  it("keeps a binding ceiling when the fixed overhead leaves room to drain", () => {
    const policy = ceilingPolicy();
    // 110k overhead + 12k summary + 20k tail + 20k savings = 162k <= 200k.
    expect(liftCompactionCeilingFloor(policy, 110_000)).toEqual({ policy, floorTokens: null });
  });

  it("lifts a binding ceiling to overhead + summary + tail + minimum savings", () => {
    const { policy, floorTokens } = liftCompactionCeilingFloor(ceilingPolicy(), 190_000);
    expect(floorTokens).toBe(242_000);
    expect(policy).toMatchObject({ triggerTokens: 242_000, triggerSource: "max_input_tokens_floor", maxInputTokens: 200_000 });
  });

  it("never lifts beyond the window-derived trigger", () => {
    const { policy } = liftCompactionCeilingFloor(ceilingPolicy(), 5_000_000);
    expect(policy.triggerTokens).toBe(900_000);
    expect(policy.triggerTokens).toBeLessThan(policy.contextWindow);
  });

  it("leaves ratio- and reserve-bound policies unchanged", () => {
    for (const policy of [
      resolveAgentCompactionPolicy({}, { contextWindow: 128_000 }),
      resolveAgentCompactionPolicy({}, { contextWindow: 200_000 }),
      resolveAgentCompactionPolicy({ compaction: { maxInputTokens: 0 } }, { contextWindow: 1_000_000 }),
    ]) {
      expect(liftCompactionCeilingFloor(policy, 500_000)).toEqual({ policy, floorTokens: null });
    }
  });
});
