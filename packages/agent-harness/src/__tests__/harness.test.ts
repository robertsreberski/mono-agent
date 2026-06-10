import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@worklab-ai/runtime-adapter";
import type { RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "@worklab-ai/observability";

import {
  AgentHarnessFailureError,
  createAgentHarness,
  createAgentResponder,
  createInMemoryHistoryStore,
} from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeRecorder implements RunRecorder {
  readonly events: RuntimeEventLike[] = [];
  startCount = 0;
  summaryStatus?: string;

  constructor(private readonly runId: string, private readonly conversationId: string) {}

  onEvent(event: RuntimeEventLike): void {
    this.events.push(event);
  }

  async start(): Promise<RunSummary> {
    this.startCount += 1;
    return {
      runId: this.runId,
      conversationId: this.conversationId,
      status: "running",
      durationMs: 0,
      eventCount: this.events.length,
      artifactPaths: [],
    };
  }

  async finish(result: RuntimeResultLike): Promise<RunSummary> {
    const status = result.cancelled === true ? "cancelled" : result.failureKind !== undefined || result.error !== undefined ? "failed" : "succeeded";
    this.summaryStatus = status;
    return {
      runId: this.runId,
      conversationId: this.conversationId,
      status,
      ...(result.failureKind === undefined || result.failureKind === null ? {} : { failureKind: result.failureKind }),
      durationMs: 1,
      ...(result.cost === undefined ? {} : { cost: result.cost }),
      eventCount: this.events.length,
      artifactPaths: [],
      ...(result.capabilitiesUsed === undefined ? {} : { capabilitiesUsed: result.capabilitiesUsed }),
    };
  }

  async fail(error: unknown): Promise<RunSummary> {
    this.summaryStatus = "failed";
    return {
      runId: this.runId,
      conversationId: this.conversationId,
      status: "failed",
      failureKind: error instanceof Error ? error.name : "exception",
      durationMs: 1,
      eventCount: this.events.length,
      artifactPaths: [],
    };
  }
}

function createFakeRuntime(run: (prompt: string, options: RuntimeRunOptions) => Promise<RuntimeResult>) {
  const calls: Array<{ prompt: string; options: RuntimeRunOptions }> = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return await run(prompt, options);
      },
    },
  };
}

describe("AgentHarness", () => {
  it("assembles context, memory, history, selected skills, tool policy, and runtime metadata", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    const skillsRoot = join(dir, "skills");
    await writeFile(identityPath, "You are Mono.", "utf8");
    await mkdir(join(skillsRoot, "research"), { recursive: true });
    await writeFile(join(skillsRoot, "research", "SKILL.md"), "# Research\n\nFind evidence.", "utf8");
    const recorder = new FakeRecorder("run-1", "telegram:1");
    const memory = {
      async load() {
        return { kind: "markdown" as const, content: "Remember: terse.", source: join(dir, "memory.md"), truncated: false };
      },
      async appendHostSummary() {
        throw new Error("memory writes should be disabled by default");
      },
    };
    const historyStore = createInMemoryHistoryStore({ maxMessages: 4 });
    await historyStore.append("telegram:1", [{ role: "assistant", content: "Earlier answer", timestamp: "2026-05-15T18:00:00Z" }]);
    const fake = createFakeRuntime(async (_prompt, options) => {
      options.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "delta" }] } });
      return {
        text: "Final answer",
        providerSessionId: "session-1",
        usage: { inputTokens: 1 },
        cost: { totalUsd: 0.01 },
        capabilitiesUsed: ["tools:read"],
      };
    });

    const harness = createAgentHarness({
      identityPath,
      skillsRoot,
      selectedSkills: ["research"],
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      cwd: dir,
      maxTurns: 3,
      memory,
      historyStore,
      toolPolicy: { allowedTools: ["Read"], disallowedTools: ["Bash"] },
      recorderFactory: () => recorder,
      createRunId: () => "run-1",
    });

    const response = await harness.run({
      conversationId: "telegram:1",
      userMessage: "What changed?",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe("Final answer");
    expect(response.failure).toBeUndefined();
    expect(response.metadata.summary).toMatchObject({
      status: "succeeded",
      eventCount: 1,
      cost: { totalUsd: 0.01 },
      capabilitiesUsed: ["tools:read"],
    });
    expect(recorder.startCount).toBe(1);
    expect(response.metadata.runtime).toMatchObject({ cost: { totalUsd: 0.01 }, capabilitiesUsed: ["tools:read"] });
    expect(response.metadata.contextSectionIds).toEqual(["core", "identity", "memory", "history", "skills", "skill-instructions", "user-message"]);
    expect(response.metadata.contextSources).toEqual([join(dir, "IDENTITY.md"), join(dir, "memory.md"), join(skillsRoot, "research", "SKILL.md")]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.prompt).toContain("Remember: terse.");
    expect(fake.calls[0]?.prompt).toContain("Earlier answer");
    expect(fake.calls[0]?.prompt).toContain("# Skill: research");
    expect(fake.calls[0]?.options).toMatchObject({ allowedTools: ["Read"], disallowedTools: ["Bash"], maxTurns: 3 });
    await expect(historyStore.load("telegram:1")).resolves.toHaveLength(3);
  });

  it("propagates runtime failure results without success text", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ error: "Provider limit", failureKind: "usage_limit" }));

    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      createRunId: () => "run-fail",
    }).run({ conversationId: "c", userMessage: "hi", abortSignal: new AbortController().signal });

    expect(response.text).toBeUndefined();
    expect(response.failure).toMatchObject({ kind: "usage_limit", message: "Provider limit" });
    expect(response.metadata.summary).toMatchObject({ status: "failed", failureKind: "usage_limit" });
  });

  it("merges request-scoped runtime options and cleans them up after runtime execution", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const cleanupCalls: string[] = [];
    const fake = createFakeRuntime(async () => ({ text: "Final answer" }));

    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      runtimeOptions: {
        allowedTools: ["Read"],
        mcpServers: {
          static: { command: "static-mcp" },
        },
      },
      toolPolicy: { allowedTools: ["Grep"], disallowedTools: ["Write"] },
      createRunId: () => "run-extension",
      runtimeOptionsForRequest: ({ request, runId, context }) => {
        expect(request.conversationId).toBe("conversation-extension");
        expect(runId).toBe("run-extension");
        expect(context.sections.map((section) => section.id)).toContain("identity");
        return {
          runtimeOptions: {
            allowedTools: ["ask_collaborator"],
            mcpServers: {
              collaborators: { type: "http", url: "http://127.0.0.1:9876/mcp" },
            },
          },
          cleanup: async () => {
            cleanupCalls.push("cleaned");
          },
        };
      },
    }).run({
      conversationId: "conversation-extension",
      userMessage: "Who should help?",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe("Final answer");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options.allowedTools).toEqual(["Grep", "Read", "ask_collaborator"]);
    expect(fake.calls[0]?.options.disallowedTools).toEqual(["Write"]);
    expect(fake.calls[0]?.options.mcpServers).toEqual({
      static: { command: "static-mcp" },
      collaborators: { type: "http", url: "http://127.0.0.1:9876/mcp" },
    });
    expect(cleanupCalls).toEqual(["cleaned"]);
  });

  it("appends a deterministic host summary when memoryWriteMode is append-host-summary", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const summaries: Array<{ conversationId: string; summary: string }> = [];
    const memory = {
      async load() {
        return undefined;
      },
      async appendHostSummary(conversationId: string, summary: string) {
        summaries.push({ conversationId, summary });
        return { conversationId, source: "memory.md", bytesWritten: summary.length };
      },
    };
    const fake = createFakeRuntime(async () => ({ text: "The build is green." }));

    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      memory,
      memoryWriteMode: "append-host-summary",
      createRunId: () => "run-summary",
    }).run({ conversationId: "telegram:9", userMessage: "Is the build ok?", abortSignal: new AbortController().signal });

    expect(response.text).toBe("The build is green.");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.conversationId).toBe("telegram:9");
    expect(summaries[0]?.summary).toBe(
      [
        "Host-observed completed turn.",
        "User: Is the build ok?",
        "Assistant: The build is green.",
      ].join("\n"),
    );
  });

  it("does not write a host summary when memoryWriteMode is omitted", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    let appendCount = 0;
    const memory = {
      async load() {
        return undefined;
      },
      async appendHostSummary() {
        appendCount += 1;
        return { conversationId: "c", source: "memory.md", bytesWritten: 0 };
      },
    };
    const fake = createFakeRuntime(async () => ({ text: "Done." }));

    await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      memory,
      createRunId: () => "run-no-summary",
    }).run({ conversationId: "c", userMessage: "hi", abortSignal: new AbortController().signal });

    expect(appendCount).toBe(0);
  });

  it("resolves scalar and mcpServers precedence collisions last-wins across merge layers", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const fake = createFakeRuntime(async () => ({ text: "ok" }));

    const response = await createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      // tool policy (first merge layer) seeds mcpServers + allowedTools
      toolPolicy: {
        allowedTools: ["Read"],
        disallowedTools: [],
        mcpServers: { shared: { url: "policy" }, policyOnly: { url: "p" } },
      },
      // static runtimeOptions (second layer) sets a scalar + overrides one server
      runtimeOptions: {
        mcpConfigPath: "/from-static",
        mcpServers: { shared: { url: "static" }, staticOnly: { url: "s" } },
      },
      createRunId: () => "run-merge",
      // request extension (last layer) wins scalar + the shared server key
      runtimeOptionsForRequest: () => ({
        runtimeOptions: {
          mcpConfigPath: "/from-request",
          allowedTools: ["Grep"],
          mcpServers: { shared: { url: "request" }, requestOnly: { url: "r" } },
        },
      }),
    }).run({ conversationId: "c", userMessage: "hi", abortSignal: new AbortController().signal });

    expect(response.text).toBe("ok");
    const options = fake.calls[0]?.options;
    // scalar: last layer wins
    expect(options?.mcpConfigPath).toBe("/from-request");
    // allowedTools: list-merged + de-duplicated across layers
    expect(options?.allowedTools).toEqual(["Read", "Grep"]);
    // mcpServers: shallow merge per key, last layer wins on the shared key
    expect(options?.mcpServers).toEqual({
      shared: { url: "request" },
      policyOnly: { url: "p" },
      staticOnly: { url: "s" },
      requestOnly: { url: "r" },
    });
  });

  it("handles cancellation before runtime execution", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const controller = new AbortController();
    controller.abort();
    const fake = createFakeRuntime(async () => {
      throw new Error("runtime should not run");
    });

    const response = await createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk" }).run({
      conversationId: "c",
      userMessage: "hi",
      abortSignal: controller.signal,
    });

    expect(fake.calls).toHaveLength(0);
    expect(response.failure).toMatchObject({ kind: "cancelled" });
    expect(response.metadata.summary).toMatchObject({ status: "cancelled" });
  });

  it("exposes harness failures through the structural responder and streams runtime deltas", async () => {
    const harness = {
      async run(request: { readonly onEvent?: (event: RuntimeEventLike) => void }) {
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "hello " }] } });
        return {
          text: "done",
          metadata: {
            runId: "run",
            conversationId: "c",
            contextSources: [],
            contextSectionIds: [],
          },
        };
      },
    };
    const streamText: string[] = [];
    const response = await createAgentResponder({ harness }).respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async (delta) => { streamText.push(delta); } },
    );

    expect(streamText).toEqual(["hello "]);
    expect(response.text).toBe("done");
  });

  it("forwards thoughts and internal tool activity as stream events without appending them to answer text", async () => {
    const harness = {
      async run(request: { readonly onEvent?: (event: RuntimeEventLike) => void }) {
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "thinking", text: "checking tools" }] } });
        request.onEvent?.({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "mcp__context_a8c__search",
                input: { query: "release plan" },
              },
            ],
          },
        });
        request.onEvent?.({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: { matches: 2 },
                is_error: false,
              },
            ],
          },
        });
        request.onEvent?.({ type: "runtime_warning", warning_kind: "config_warning", message: "minor config warning" });
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "final " }] } });
        return {
          text: "final answer",
          metadata: {
            runId: "run",
            conversationId: "c",
            contextSources: [],
            contextSectionIds: [],
          },
        };
      },
    };
    const streamText: string[] = [];
    const streamEvents: unknown[] = [];
    const response = await createAgentResponder({ harness }).respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      {
        append: async (delta) => { streamText.push(delta); },
        event: async (event) => { streamEvents.push(event); },
      },
    );

    expect(streamText).toEqual(["final "]);
    expect(streamEvents).toEqual([
      { type: "assistant_thought", text: "checking tools" },
      {
        type: "tool_call_started",
        id: "tool-1",
        name: "mcp__context_a8c__search",
        arguments: { query: "release plan" },
      },
      {
        type: "tool_call_completed",
        id: "tool-1",
        content: { matches: 2 },
        isError: false,
      },
      {
        type: "runtime_warning",
        warningKind: "config_warning",
        message: "minor config warning",
      },
    ]);
    expect(response.text).toBe("final answer");
  });

  it("throws AgentHarnessFailureError from the structural responder", async () => {
    const harness = {
      async run() {
        return {
          metadata: {
            runId: "run",
            conversationId: "c",
            contextSources: [],
            contextSectionIds: [],
          },
          failure: { kind: "usage_limit", message: "No quota" },
        };
      },
    };

    await expect(createAgentResponder({ harness }).respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => undefined },
    )).rejects.toBeInstanceOf(AgentHarnessFailureError);
  });
});
