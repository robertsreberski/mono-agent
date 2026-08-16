import { describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";

const harnessMock = vi.fn((options: Record<string, unknown>) => ({
  options,
  run: vi.fn(),
  dispose: vi.fn(async () => undefined),
}));

vi.mock("@mono-agent/agent-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mono-agent/agent-harness")>();
  return { ...actual, createAgentHarness: (options: unknown) => harnessMock(options as Record<string, unknown>) };
});

vi.mock("../agent-root-coordinator.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agent-root-coordinator.js")>(),
  acquireAgentRootOwnership: async () => ({
    agentRoot: "/repo",
    coordinator: {
      synchronizeGeneration() {},
      acquireRequestLease: () => ({
        generation: { id: "mono-agent.process-jobs-roots.absent", rootKeys: [] },
        releaseAfterSettlement() {},
      }),
    },
    release() {},
  }),
  releaseAgentRootOwnershipWhenIdle: async (ownership: { release(): void }) => {
    ownership.release();
    return true;
  },
  assertAgentRootLeaseOutsideWorkspace() {},
}));

vi.mock("../process-jobs-root-registry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../process-jobs-root-registry.js")>(),
  loadProcessJobsRootRegistryProtection: async () => ({
    kind: "empty",
    agentRoot: "/repo",
    registryDir: "/repo/.mono-agent/process-jobs-roots-v1",
    manifestPath: "/repo/.mono-agent/process-jobs-roots-v1/registry.json",
    mutationLockPath: "/repo/.mono-agent/.process-jobs-roots-v1.lock",
    generation: { id: "mono-agent.process-jobs-roots.absent", rootKeys: [] },
    roots: [],
    protectedRoots: [],
  }),
  attestProcessJobsRootRegistrySnapshot: async (snapshot: unknown) => snapshot,
}));

const { createConfiguredAgentHarness } = await import("../index.js");
const { createConfiguredAgentResponderForApp } = await import("../configured-agent.js");

const PRIMARY = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;
const HAIKU = { sdk: "pi", provider: "anthropic", model: "claude-haiku-4-5", reference: "pi:anthropic:claude-haiku-4-5" } as const;
const CLAUDE_CHILD = { sdk: "claude", model: "claude-sonnet-4-6", reference: "claude:claude-sonnet-4-6" } as const;

function monoConfig(
  subagents?: MonoAgentConfig["subagents"],
  tools: MonoAgentConfig["tools"] = { allowedTools: ["Read", "Agent"], disallowedTools: [] },
): MonoAgentConfig {
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
    tools,
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

  it("blocks a named non-Pi Agent child before its provider can read protected ProcessJobs state", async () => {
    const privateState = "PRIVATE_PROCESS_JOB_STATE_MUST_NOT_ESCAPE";
    const providerRun = vi.fn(async () => ({ text: privateState, events: [], failureKind: null }));
    const resolveAttempt = vi.fn(() => ({ runtime: { run: providerRun } }));
    const childRouter = createMonoRuntime({
      routeSafety: "per-route-native",
      fallbackChain: [{ model: CLAUDE_CHILD }],
      resolveAttempt,
    });
    const runtimeForModel = vi.fn(() => childRouter);
    const { runtime, subagents } = await buildSubagents(
      monoConfig({
        enabled: true,
        definitions: [{ name: "private-reader", description: "Reads code.", prompt: "Read state.", model: CLAUDE_CHILD }],
      }),
      { runtimeForModel },
    );
    const definitions = (subagents?.definitions ?? []) as Array<Record<string, unknown>>;
    const definition = definitions[0];
    const run = subagents?.run as (request: unknown) => Promise<Record<string, unknown>>;
    const protectedRoot = "/repo/.mono-agent/process-jobs";

    expect(definition).toMatchObject({
      name: "private-reader",
      model: CLAUDE_CHILD,
      allowedTools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
    });
    const result = run({
      systemPrompt: definition?.systemPrompt,
      prompt: "Read the ProcessJobs store.",
      definition,
      maxTurns: 5,
      depth: 1,
      cwd: "/repo",
      sandboxPolicy: { mode: "native", protectedRoots: [protectedRoot] },
      sandboxEngine: { id: "srt" },
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    await expect(result).rejects.toThrow(
      "Process-job private state requires a Pi-native runtime.",
    );
    expect(runtimeForModel).toHaveBeenCalledWith(CLAUDE_CHILD, "sdk");
    expect(resolveAttempt).not.toHaveBeenCalled();
    expect(providerRun).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("keeps the Agent-child Pi gate provider-zero in unsafe posture without protectedRoots", async () => {
    harnessMock.mockClear();
    const privateState = "PRIVATE_PROCESS_JOB_STATE_MUST_NOT_ESCAPE";
    const providerRun = vi.fn(async () => ({ text: privateState, events: [], failureKind: null }));
    const resolveAttempt = vi.fn(() => ({ runtime: { run: providerRun } }));
    const childRouter = createMonoRuntime({
      routeSafety: "per-route-native",
      fallbackChain: [{ model: CLAUDE_CHILD }],
      resolveAttempt,
    });
    const runtimeForModel = vi.fn(() => childRouter);
    const runtime = { run: vi.fn(async () => ({ text: "parent", events: [] })) };
    const config = monoConfig({
      enabled: true,
      definitions: [{ name: "private-reader", description: "Reads code.", prompt: "Read state.", model: CLAUDE_CHILD }],
    });
    const responder = await createConfiguredAgentResponderForApp({
      config: {
        ...config,
        sandbox: { mode: "off", root: "/repo", readableRoots: [], writableRoots: [], network: { mode: "all" } },
      },
      runtime: runtime as never,
      runtimeForModel,
    } as never, {
      processJobs: {
        registry: {
          kind: "ready",
          generation: { id: "11111111-1111-4111-8111-111111111111", rootKeys: ["private"] },
          roots: [{}],
          protectedRoots: ["/repo/.mono-agent/process-jobs"],
        },
        protectionPosture: {
          kind: "unsafe-unprotected",
          retainedRoots: true,
          requiresPiNative: true,
          suppressSyntheticSandbox: true,
          unsafeAllowUnprotectedState: true,
          warning: "UNSAFE: ProcessJobs state and operator secret are model-accessible.",
        },
      },
    } as never);
    const options = harnessMock.mock.calls[0]?.[0] as { runtimeOptions?: Record<string, unknown> };
    const subagents = options.runtimeOptions?.subagents as Record<string, unknown>;
    const definitions = subagents.definitions as Array<Record<string, unknown>>;
    const run = subagents.run as (request: unknown) => Promise<unknown>;

    await expect(run({
      systemPrompt: "Read state.",
      prompt: "Read the ProcessJobs store.",
      definition: definitions[0],
      maxTurns: 5,
      depth: 1,
      cwd: "/repo",
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    })).rejects.toThrow("Process-job private state requires a Pi-native runtime.");
    expect(runtimeForModel).toHaveBeenCalledWith(CLAUDE_CHILD, "sdk");
    expect(resolveAttempt).not.toHaveBeenCalled();
    expect(providerRun).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
    await (responder as { dispose?: () => Promise<void> }).dispose?.();
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

describe("subagent confinement and context inheritance", () => {
  const SKILLS = [
    { name: "a8c-context", description: "Read Automattic work context." },
    { name: "pr-review", description: "Review a pull request." },
  ] as const;

  /** Runs one child and returns the (prompt, options) the runtime was called with. */
  async function runChild(
    request: Record<string, unknown> = {},
    config: MonoAgentConfig = monoConfig({ enabled: true, definitions: [RESEARCHER] }),
  ): Promise<{ prompt: string; options: Record<string, unknown> }> {
    const { runtime, subagents } = await buildSubagents(config);
    const run = subagents?.run as (request: unknown) => Promise<unknown>;
    await run({
      systemPrompt: "You research.",
      prompt: "find X",
      definition: { name: "researcher", allowedTools: ["Read", "Grep"] },
      maxTurns: 12,
      depth: 1,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
      ...request,
    });
    const [prompt, options] = runtime.run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    return { prompt, options };
  }

  it("forwards the parent's cwd, sandbox policy, and sandbox engine to the child", async () => {
    // This path runs OUTSIDE the harness, which is where the sandbox policy is
    // normally attached. Dropping any of these leaves the child unconfined, and
    // its default tools include WebFetch and WebSearch — so an unsandboxed child
    // is a network egress path, not merely a permissive one.
    const sandboxPolicy = { mode: "native", readableRoots: ["/repo"] };
    const sandboxEngine = { id: "srt" };
    const { options } = await runChild({ cwd: "/repo", sandboxPolicy, sandboxEngine });

    expect(options.cwd).toBe("/repo");
    expect(options.sandboxPolicy).toBe(sandboxPolicy);
    expect(options.sandboxEngine).toBe(sandboxEngine);
  });

  it("inherits the parent's skill index and skills root, and renders the index into the child prompt", async () => {
    const { prompt, options } = await runChild({ skills: SKILLS, skillsRoot: "/repo/skills" });

    expect(options.skills).toEqual(SKILLS);
    expect(options.skillsRoot).toBe("/repo/skills");
    // Appended after the profile prompt: the profile prompt is the child's
    // identity, and the parent's own context puts the index after identity too.
    expect(prompt.startsWith("You research.")).toBe(true);
    expect(prompt).toContain("## Skill Index");
    expect(prompt).toContain("- **a8c-context** — Read Automattic work context.");
    expect(prompt).toContain("call `ReadSkill` with its exact name");
  });

  it("stays inert when the parent disclosed no skills", async () => {
    const { prompt, options } = await runChild();

    expect(prompt).toBe("You research.");
    expect(options).not.toHaveProperty("skills");
    expect(options).not.toHaveProperty("skillsRoot");
  });

  it("needs both the entries and the root, never half the pair", async () => {
    // pi-bridge builds ReadSkill only when it has both; a half-set pair fails by
    // silently omitting the tool rather than erroring, so never send one alone.
    const noRoot = await runChild({ skills: SKILLS });
    expect(noRoot.options).not.toHaveProperty("skills");
    expect(noRoot.prompt).toBe("You research.");

    const noSkills = await runChild({ skillsRoot: "/repo/skills" });
    expect(noSkills.options).not.toHaveProperty("skills");
    expect(noSkills.prompt).toBe("You research.");
  });

  it("withholds skills from a profile that denies ReadSkill, under either spelling", async () => {
    for (const denied of ["ReadSkill", "read_skill"]) {
      const { prompt, options } = await runChild({
        skills: SKILLS,
        skillsRoot: "/repo/skills",
        definition: { name: "researcher", disallowedTools: [denied] },
      });
      expect(options, denied).not.toHaveProperty("skills");
      expect(prompt, denied).toBe("You research.");
    }
  });

  it("withholds skills when the parent agent denies ReadSkill outright", async () => {
    const { prompt, options } = await runChild(
      { skills: SKILLS, skillsRoot: "/repo/skills" },
      monoConfig(
        { enabled: true, definitions: [RESEARCHER] },
        { allowedTools: ["*"], disallowedTools: ["ReadSkill"] },
      ),
    );

    expect(options).not.toHaveProperty("skills");
    expect(prompt).toBe("You research.");
  });

  it("withholds skills from a profile pinned to a runtime that cannot use them", async () => {
    // Non-empty `skills` makes supports_skills a ROUTING REQUIREMENT, and a chain
    // entry that lacks it is skipped — so threading skills onto a direct-OpenCode
    // child turns a working subagent into skipped_capability_mismatch. Do not
    // "simplify" this guard away.
    const OPENCODE = { sdk: "opencode", provider: "opencode", model: "glm-5.2", reference: "opencode:opencode:glm-5.2" } as const;
    const overrideRuntime = { run: vi.fn(async () => ({ text: "answer", events: [] })) };
    const { subagents } = await buildSubagents(
      monoConfig({ enabled: true, definitions: [{ ...RESEARCHER, model: OPENCODE }] }),
      { runtimeForModel: vi.fn(() => overrideRuntime) },
    );
    const run = subagents?.run as (request: unknown) => Promise<unknown>;

    await run({
      systemPrompt: "You research.",
      prompt: "x",
      definition: { name: "researcher", model: OPENCODE },
      maxTurns: 5,
      depth: 1,
      skills: SKILLS,
      skillsRoot: "/repo/skills",
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    const [prompt, options] = overrideRuntime.run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(options).not.toHaveProperty("skills");
    expect(prompt).toBe("You research.");
  });
});

describe("in-flight subagent ceiling", () => {
  async function ceilingFor(
    inline: NonNullable<MonoAgentConfig["subagents"]>["inline"],
    tools?: MonoAgentConfig["tools"],
  ): Promise<readonly string[] | undefined> {
    const { subagents } = await buildSubagents(monoConfig(
      { enabled: true, definitions: [RESEARCHER], ...(inline === undefined ? {} : { inline }) },
      tools,
    ));
    return (subagents?.inline as { allowedTools?: readonly string[] } | undefined)?.allowedTools;
  }

  it("bounds an authored subagent by the parent agent's own built-ins", async () => {
    // The model must not be able to hand a helper a tool it was itself denied.
    expect(await ceilingFor(undefined, { allowedTools: ["Read", "Grep", "Agent"], disallowedTools: [] }))
      .toEqual(["Read", "Grep"]);
  });

  it("expands the allow-all wildcard to the built-in set, minus the hard-denied tools", async () => {
    const ceiling = await ceilingFor(undefined, { allowedTools: ["*"], disallowedTools: [] });
    expect(ceiling).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "Bash", "Exec"]));
    expect(ceiling).not.toContain("Agent");
  });

  it("honours the parent's deny list", async () => {
    expect(await ceilingFor(undefined, { allowedTools: ["*"], disallowedTools: ["Bash", "Exec"] }))
      .not.toEqual(expect.arrayContaining(["Bash"]));
  });

  it("lets an operator clamp below the parent's own tools", async () => {
    expect(await ceilingFor({ allowedTools: ["Read", "Edit"] }, { allowedTools: ["*"], disallowedTools: [] }))
      .toEqual(["Read", "Edit"]);
  });

  it("withholds the authoring policy entirely when disabled", async () => {
    const { subagents } = await buildSubagents(monoConfig({
      enabled: true,
      definitions: [RESEARCHER],
      inline: { enabled: false },
    }));
    expect(subagents?.inline).toBeUndefined();
  });
});
