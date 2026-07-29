import { describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";

const harnessMock = vi.fn((options: Record<string, unknown>) => ({ options }));

vi.mock("@mono-agent/agent-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/agent-harness")>();
  return { ...actual, createAgentHarness: (options: unknown) => harnessMock(options as Record<string, unknown>) };
});

const { createConfiguredAgentHarness } = await import("../index.js");

const PRIMARY = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;
const HAIKU = { sdk: "pi", provider: "anthropic", model: "claude-haiku-4-5", reference: "pi:anthropic:claude-haiku-4-5" } as const;

function monoConfig(subagents?: MonoAgentConfig["subagents"]): MonoAgentConfig {
  return {
    runtime: {
      model: PRIMARY,
      retry: { primaryAttempts: 2, backoffMs: 1_000, maxBackoffMs: 15_000 },
      executionMode: "sdk",
      workspace: "/repo",
      session: { mode: "continuous", idleTimeoutMs: 1_800_000 },
    },
    ...(subagents === undefined ? {} : { subagents }),
    context: { identityPath: "/repo/IDENTITY.md", selectedSkills: [] },
    tools: { allowedTools: ["Read", "Agent"], disallowedTools: [] },
    artifacts: {
      dir: "/repo/.mono-agent/artifacts",
      retention: { maxAgeDays: 365, maxCount: 50_000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 5_000, dryRun: false },
    },
    traceability: { registryDir: "/repo/.mono-agent/trace" },
  } as MonoAgentConfig;
}

const RESEARCHER = {
  name: "researcher",
  description: "Reads code.",
  prompt: "You research.",
  allowedTools: ["Read", "Grep"],
};

async function buildSubagents(config: MonoAgentConfig, extra: Record<string, unknown> = {}) {
  harnessMock.mockClear();
  const runtime = { run: vi.fn(async (_prompt: string, _options: Record<string, unknown>) => ({ text: "child answer", events: [] })) };
  await createConfiguredAgentHarness({ config, runtime: runtime as never, ...extra } as never);
  const options = harnessMock.mock.calls[0]?.[0] as { runtimeOptions?: Record<string, unknown> };
  return { runtime, subagents: options.runtimeOptions?.subagents as Record<string, unknown> | undefined };
}

describe("configured subagents", () => {
  it("is absent unless subagents.enabled is true", async () => {
    expect((await buildSubagents(monoConfig())).subagents).toBeUndefined();
    expect((await buildSubagents(monoConfig({ definitions: [RESEARCHER] }))).subagents).toBeUndefined();
    expect((await buildSubagents(monoConfig({ enabled: false, definitions: [RESEARCHER] }))).subagents).toBeUndefined();
  });

  it("projects profiles with their prompt, tools, and caps", async () => {
    const { subagents } = await buildSubagents(monoConfig({
      enabled: true,
      maxConcurrent: 3,
      maxPerTurn: 9,
      definitions: [RESEARCHER],
    }));

    expect(subagents).toMatchObject({ maxConcurrent: 3, maxPerTurn: 9 });
    const definitions = (subagents?.definitions ?? []) as Array<Record<string, unknown>>;
    expect(definitions[0]).toMatchObject({
      name: "researcher",
      description: "Reads code.",
      systemPrompt: "You research.",
      allowedTools: ["Read", "Grep"],
    });
  });

  it("hard-denies the recursion and channel tools on every profile", async () => {
    const { subagents } = await buildSubagents(monoConfig({
      enabled: true,
      definitions: [{ ...RESEARCHER, disallowedTools: ["Bash"] }],
    }));

    const definitions = (subagents?.definitions ?? []) as Array<Record<string, unknown>>;
    expect(definitions[0]?.disallowedTools).toEqual([
      "Bash",
      "Agent",
      "AskUser",
      "SlackSendMessage",
      "TelegramSendMessage",
      "TelegramSendFile",
    ]);
  });

  it("defaults an unspecified profile to the read-only tool set", async () => {
    const { subagents } = await buildSubagents(monoConfig({
      enabled: true,
      definitions: [{ name: "helper", description: "d", prompt: "p" }],
    }));
    const definitions = (subagents?.definitions ?? []) as Array<Record<string, unknown>>;
    expect(definitions[0]?.allowedTools).toEqual(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
  });

  it("runs a child on the shared router so it inherits the fallback chain and retries", async () => {
    const { runtime, subagents } = await buildSubagents(monoConfig({ enabled: true, definitions: [RESEARCHER] }));
    const run = subagents?.run as (request: unknown) => Promise<unknown>;

    const result = await run({
      systemPrompt: "You research.",
      prompt: "find X",
      definition: { name: "researcher", allowedTools: ["Read", "Grep"] },
      maxTurns: 12,
      depth: 1,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(result).toMatchObject({ text: "child answer" });
    expect(runtime.run).toHaveBeenCalledOnce();
    const [prompt, options] = runtime.run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(prompt).toBe("You research.");
    expect(options).toMatchObject({
      model: PRIMARY,
      maxTurns: 12,
      messages: [{ role: "user", content: "find X" }],
      allowedTools: ["Read", "Grep"],
      mcpServers: {},
      subagents: { depth: 1 },
    });
    expect(options.disallowedTools).toContain("Agent");
  });

  it("routes a profile with its own model through runtimeForModel, not the shared router", async () => {
    // The router overrides options.model per chain entry, so passing a different
    // model to the shared runtime would be silently ignored and the child would
    // run on the chain primary instead.
    const overrideRuntime = { run: vi.fn(async (_prompt: string, _options: Record<string, unknown>) => ({ text: "haiku answer", events: [] })) };
    const runtimeForModel = vi.fn(() => overrideRuntime);
    const { runtime, subagents } = await buildSubagents(
      monoConfig({ enabled: true, definitions: [{ ...RESEARCHER, model: HAIKU }] }),
      { runtimeForModel },
    );
    const run = subagents?.run as (request: unknown) => Promise<unknown>;

    await run({
      systemPrompt: "You research.",
      prompt: "x",
      definition: { name: "researcher", model: HAIKU },
      maxTurns: 5,
      depth: 1,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(runtimeForModel).toHaveBeenCalledWith(HAIKU, expect.any(String));
    expect(overrideRuntime.run).toHaveBeenCalledOnce();
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("keeps a profile whose model matches the primary on the shared router", async () => {
    const runtimeForModel = vi.fn();
    const { runtime, subagents } = await buildSubagents(
      monoConfig({ enabled: true, definitions: [{ ...RESEARCHER, model: PRIMARY }] }),
      { runtimeForModel },
    );
    const run = subagents?.run as (request: unknown) => Promise<unknown>;

    await run({
      systemPrompt: "p",
      prompt: "x",
      definition: { name: "researcher", model: PRIMARY },
      maxTurns: 5,
      depth: 1,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(runtimeForModel).not.toHaveBeenCalled();
    expect(runtime.run).toHaveBeenCalledOnce();
  });

  it("gives a profile only the MCP servers it names, and none by default", async () => {
    const { subagents } = await buildSubagents(monoConfig({
      enabled: true,
      definitions: [RESEARCHER],
    }));
    const definitions = (subagents?.definitions ?? []) as Array<Record<string, unknown>>;
    // No named servers means AskUser and the channel-send tools stay
    // structurally unreachable rather than merely denied by name.
    expect(definitions[0]?.mcpServers).toEqual({});
  });
});
