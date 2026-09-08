import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeModelReference, RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";

import { createAgentHarness, createDurableHistoryStore, createInMemoryHistoryStore } from "../index.js";
import type { AgentHarnessRequest, AgentHarnessSessionEvent, AgentHarnessSessionOptions } from "../index.js";

const tempDirs: string[] = [];
const defaultModel = { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" } as const;
const claudeModel = { provider: "anthropic", model: "claude-opus-4-8", reference: "anthropic:claude-opus-4-8" } as const;
const codexModel = { provider: "openai-codex", model: "gpt-5.6-codex", reference: "openai-codex:gpt-5.6-codex" } as const;
// All-LOCAL default + override targets for the endpoint-block ownership tests.
const localDefaultModel = { provider: "lmstudio", model: "qwen", reference: "lmstudio:qwen" } as const;
const otherLocalModel = { provider: "ollama", model: "llama3", reference: "ollama:llama3" } as const;
const openAiCloudModel = { provider: "openai", model: "gpt-4o", reference: "openai:gpt-4o" } as const;
const lmstudioDefaultBlock = {
  customProvider: { id: "lmstudio", provider_type: "lmstudio", base_url: "http://localhost:1234" },
  customModel: { provider_id: "lmstudio", model_name: "qwen" },
  modelCapabilities: { reasoning: true },
  isPrivateProvider: true,
} as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeRuntimeCall {
  readonly prompt: string;
  readonly options: RuntimeRunOptions;
}

function createFakeRuntime(result: RuntimeResult = { text: "ok" }) {
  const calls: FakeRuntimeCall[] = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return result;
      },
    },
  };
}

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-model-override-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

function request(conversationId = "conv-1", userMessage = "hello") {
  return { conversationId, userMessage, abortSignal: new AbortController().signal };
}

describe("AgentHarness per-request model/effort override", () => {
  it("runs a different-model override on the runtimeForModel runtime", async () => {
    const identityPath = await identityFixture();
    const base = createFakeRuntime();
    const override = createFakeRuntime();
    const factoryCalls: RuntimeModelReference[] = [];

    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      effort: "low",
      runtimeForModel: (model) => {
        factoryCalls.push(model);
        return override.runtime;
      },
      runtimeOptionsForRequest: () => ({ runtimeOptions: { model: codexModel, effort: "high" } }),
    });

    await harness.run(request());

    expect(base.calls).toHaveLength(0);
    expect(override.calls).toHaveLength(1);
    expect(factoryCalls).toEqual([codexModel]);

    const options = override.calls[0]?.options as Record<string, unknown>;
    expect(options.model).toEqual(codexModel);
    expect(options.effort).toBe("high");
  });

  it("uses the shared runtime and harness defaults when no override is returned", async () => {
    const identityPath = await identityFixture();
    const base = createFakeRuntime();
    let factoryCalled = false;

    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      effort: "low",
      runtimeForModel: () => {
        factoryCalled = true;
        return base.runtime;
      },
      runtimeOptionsForRequest: () => ({ runtimeOptions: {} }),
    });

    await harness.run(request());

    expect(factoryCalled).toBe(false);
    expect(base.calls).toHaveLength(1);
    const options = base.calls[0]?.options as Record<string, unknown>;
    expect(options.model).toEqual(defaultModel);
    expect(options.effort).toBe("low");
  });

  it("keeps messages harness-owned even if an extension tries to override them", async () => {
    const identityPath = await identityFixture();
    const base = createFakeRuntime();

    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      runtimeOptionsForRequest: () => ({
        // messages is harness-owned; an extension value must not leak through.
        runtimeOptions: { messages: [{ role: "user", content: "HIJACKED" }] } as never,
      }),
    });

    await harness.run(request("conv-1", "real message"));

    const options = base.calls[0]?.options as unknown as { messages: Array<{ content: string }> };
    expect(options.messages[0]?.content).toContain("real message");
    expect(options.messages[0]?.content).not.toContain("HIJACKED");
  });
});

describe("AgentHarness per-request override OWNS the local-provider endpoint block", () => {
  // These drive the REAL harness mergeRuntimeOptions end-to-end (host default
  // runtimeOptions vs the extension's per-request runtimeOptions) and assert the
  // options actually handed to runtime.run — no inline re-implementation of the
  // merge. `runtimeOptionsForRequest` here mirrors what the app's
  // request-model-override extension emits.

  it("an all-local-default agent overriding to a cloud model CLEARS the leaked local endpoint block", async () => {
    const identityPath = await identityFixture();
    const base = createFakeRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: localDefaultModel,
      // Host default endpoint block, computed once from the local default model.
      runtimeOptions: lmstudioDefaultBlock,
      // Cloud override: sets the cloud model and null-CLEARS the four endpoint
      // keys so the default block cannot mis-route the cloud model to localhost.
      runtimeOptionsForRequest: () => ({
        runtimeOptions: {
          model: openAiCloudModel,
          customProvider: null,
          customModel: null,
          modelCapabilities: null,
          isPrivateProvider: null,
        },
      }),
    });

    await harness.run(request());

    const options = base.calls[0]?.options as Record<string, unknown>;
    expect(options.model).toEqual(openAiCloudModel);
    // The regression: NO local endpoint block leaks into the cloud run.
    expect(options.customProvider).toBeUndefined();
    expect(options.customModel).toBeUndefined();
    expect(options.modelCapabilities).toBeUndefined();
    expect(options.isPrivateProvider).toBeUndefined();
  });

  it("an all-local-default agent overriding to a DIFFERENT local model REPLACES the endpoint block", async () => {
    const identityPath = await identityFixture();
    const base = createFakeRuntime();
    const overrideBlock = {
      customProvider: { id: "ollama", provider_type: "ollama", base_url: "http://localhost:11434" },
      customModel: { provider_id: "ollama", model_name: "llama3" },
      modelCapabilities: { reasoning: false },
      isPrivateProvider: true,
    };
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: localDefaultModel,
      runtimeOptions: lmstudioDefaultBlock,
      runtimeOptionsForRequest: () => ({ runtimeOptions: { model: otherLocalModel, ...overrideBlock } }),
    });

    await harness.run(request());

    const options = base.calls[0]?.options as Record<string, unknown>;
    expect(options.model).toEqual(otherLocalModel);
    // The override block fully replaces the default's — no lmstudio leak.
    expect(options.customProvider).toEqual(overrideBlock.customProvider);
    expect(options.customModel).toEqual(overrideBlock.customModel);
    expect((options.customProvider as Record<string, unknown>).id).toBe("ollama");
  });

  it("an effort-only override PRESERVES the host default endpoint block (no clear)", async () => {
    const identityPath = await identityFixture();
    const base = createFakeRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: localDefaultModel,
      runtimeOptions: lmstudioDefaultBlock,
      // No model → the extension emits no endpoint keys, so the default block for
      // the (unchanged) default model must survive the merge.
      runtimeOptionsForRequest: () => ({ runtimeOptions: { effort: "high" } }),
    });

    await harness.run(request());

    const options = base.calls[0]?.options as Record<string, unknown>;
    expect(options.model).toEqual(localDefaultModel);
    expect(options.effort).toBe("high");
    expect(options.customProvider).toEqual(lmstudioDefaultBlock.customProvider);
  });
});

function createSessionFakeRuntime(run: (call: number) => Promise<RuntimeResult>) {
  const calls: FakeRuntimeCall[] = [];
  const disposed: string[] = [];
  return {
    calls,
    disposed,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return await run(calls.length);
      },
      async disposeSession(providerSessionId: string): Promise<boolean> {
        disposed.push(providerSessionId);
        return true;
      },
    },
  };
}

const continuousSession: AgentHarnessSessionOptions = { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true };

function webhookOverrideRequest(conversationId: string, modelString: string) {
  return {
    conversationId,
    userMessage: "deep research",
    abortSignal: new AbortController().signal,
    metadata: { webhook: { requestId: "r1", model: modelString } },
  };
}

function effortOnlyCronRequest(conversationId: string) {
  return {
    conversationId,
    userMessage: "tick",
    abortSignal: new AbortController().signal,
    metadata: { cron: { jobId: "nightly", effort: "high" } },
  };
}

function telegramOverrideRequest(
  conversationId: string,
  override: { readonly model?: string; readonly effort?: string },
) {
  return {
    conversationId,
    userMessage: "telegram turn",
    abortSignal: new AbortController().signal,
    metadata: { telegram: { updateId: 1, chat: { id: 42 }, message: { id: 10 }, ...override } },
  };
}

function slackOverrideRequest(conversationId: string, model: string) {
  return {
    conversationId,
    userMessage: "slack turn",
    abortSignal: new AbortController().signal,
    metadata: { slack: { channelId: "C1", model } },
  };
}

function hostWakeMetadata(
  metadata: Record<string, unknown>,
  deliveryKey: string,
  enumerable: boolean,
): Record<string, unknown> {
  Object.defineProperty(metadata, Symbol.for("mono-agent.process-job-wake.delivery-key.v1"), {
    value: deliveryKey,
    enumerable,
    configurable: true,
  });
  return metadata;
}

describe("AgentHarness per-request override session binding", () => {
  it("warms an interactive override and records same-run live input before reseeding the default", async () => {
    const identityPath = await identityFixture();
    const historyStore = createInMemoryHistoryStore({ maxMessages: 20 });
    const sessionEvents: AgentHarnessSessionEvent[] = [];
    const base = createSessionFakeRuntime(async (call) => ({
      text: `base-${String(call)}`,
      providerSessionId: `base-session-${String(call)}`,
    }));
    const overrideCalls: FakeRuntimeCall[] = [];
    const consumed: Array<{ readonly id: string | undefined; readonly body: string }> = [];
    let overrideStarted!: () => void;
    const started = new Promise<void>((resolve) => { overrideStarted = resolve; });
    const overrideRuntime = {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        overrideCalls.push({ prompt, options });
        overrideStarted();
        const iterator = options.liveInput?.[Symbol.asyncIterator]();
        if (iterator === undefined) throw new Error("Expected an interactive mailbox.");
        const next = await iterator.next();
        if (next.done) throw new Error("Interactive mailbox closed before delivery.");
        consumed.push({ id: next.value.id, body: next.value.body });
        next.value.acknowledge?.();
        return { text: "override answer", providerSessionId: "override-session" };
      },
    };
    let runNumber = 0;
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      session: {
        ...continuousSession,
        onSessionEvent: (event) => { sessionEvents.push(event); },
      },
      historyStore,
      runtimeForModel: () => overrideRuntime,
      runtimeOptionsForRequest: ({ request: activeRequest }) => {
        const web = (activeRequest.metadata as { web?: { model?: string } } | undefined)?.web;
        return { runtimeOptions: web?.model === undefined ? {} : { model: claudeModel } };
      },
      createRunId: () => `run-${String(++runNumber)}`,
    });

    await harness.run(request("conv", "warm default"));
    const running = harness.run({
      conversationId: "conv",
      userMessage: "different-model request",
      abortSignal: new AbortController().signal,
      metadata: { source: "web", web: { model: claudeModel.reference } },
    });
    await started;

    const offer = harness.offerLiveInput?.({
      conversationId: "conv",
      targetRunId: "run-2",
      id: "input-override-1",
      text: "same-run constraint",
      receivedAt: "2026-09-07T14:30:00.000Z",
    });
    expect(offer?.status).toBe("accepted");
    await expect(running).resolves.toMatchObject({
      text: "override answer",
      metadata: { runId: "run-2" },
    });
    if (offer?.status === "accepted") {
      await expect(offer.settled).resolves.toEqual({ status: "applied", runId: "run-2" });
    }

    expect(consumed).toEqual([{ id: "input-override-1", body: "same-run constraint" }]);
    expect(overrideCalls).toHaveLength(1);
    expect(overrideCalls[0]?.options).toMatchObject({ model: claudeModel });
    expect(overrideCalls[0]?.options.sessionId).toBeUndefined();
    expect(overrideCalls[0]?.options.providerSessionId).toBeUndefined();
    expect(overrideCalls[0]?.options.sessionKeepAlive).toBe(true);
    expect(overrideCalls[0]?.options.piSessionsRoot).toBeUndefined();
    expect(sessionEvents).toContainEqual(expect.objectContaining({
      kind: "cold",
      conversationId: "conv",
      reason: "model_change",
    }));
    expect((await historyStore.load("conv")).filter((message) => message.runId === "run-2")).toMatchObject([
      { role: "user", content: "different-model request", runId: "run-2" },
      { role: "user", content: "same-run constraint", runId: "run-2" },
      { role: "assistant", content: "override answer", runId: "run-2" },
    ]);

    await harness.run(request("conv", "resume default"));
    expect(base.calls[1]?.options.sessionId).toBeUndefined();
    expect(base.calls[1]?.options.providerSessionId).toBeUndefined();
    expect(JSON.stringify(base.calls[1]?.options.messages)).toContain("same-run constraint");
  });

  it.each([
    ["cron", () => ({ metadata: { cron: { model: claudeModel.reference } } })],
    ["webhook", () => ({ metadata: { webhook: { model: claudeModel.reference } } })],
    ["mixed web + cron", () => ({
      metadata: {
        source: "web",
        web: { model: claudeModel.reference },
        cron: { model: claudeModel.reference },
      },
    })],
    ["mixed web + webhook", () => ({
      metadata: {
        source: "web",
        web: { model: claudeModel.reference },
        webhook: { model: claudeModel.reference },
      },
    })],
    ["continuation", () => ({
      metadata: { source: "web", web: { model: claudeModel.reference } },
      continuation: {
        continuationId: "continuation-1",
        originRunId: "origin-run",
        toolsDisabled: true as const,
        deferHistoryCommit: true as const,
        originContextPolicy: "detached_latest" as const,
      },
    })],
    ["non-enumerable Web ProcessJob wake", () => ({
      metadata: hostWakeMetadata(
        { source: "web", web: { model: claudeModel.reference } },
        "process-job:one:1",
        false,
      ),
    })],
    ["enumerable Slack Monitor wake", () => ({
      metadata: hostWakeMetadata(
        { slack: { model: claudeModel.reference } },
        "monitor:one:1",
        true,
      ),
    })],
    ["enumerable Telegram ProcessJob wake", () => ({
      metadata: hostWakeMetadata(
        { telegram: { model: claudeModel.reference } },
        "process-job:two:1",
        true,
      ),
    })],
  ] satisfies ReadonlyArray<readonly [string, () => Pick<AgentHarnessRequest, "metadata" | "continuation">]>)(
    "uses the ordinary mailbox policy for %s model work",
    async (_name, requestFields) => {
      const identityPath = await identityFixture();
      let runtimeStarted!: () => void;
      let releaseRuntime!: () => void;
      const started = new Promise<void>((resolve) => { runtimeStarted = resolve; });
      const release = new Promise<void>((resolve) => { releaseRuntime = resolve; });
      const calls: FakeRuntimeCall[] = [];
      const runtime = {
        async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
          calls.push({ prompt, options });
          runtimeStarted();
          await release;
          return { text: "isolated result" };
        },
      };
      const harness = createAgentHarness({
        identityPath,
        runtime,
        model: defaultModel,
        runtimeForModel: () => runtime,
        runtimeOptionsForRequest: () => ({ runtimeOptions: { model: claudeModel } }),
        createRunId: () => "run-excluded",
      });
      const running = harness.run({
        conversationId: "conv-excluded",
        userMessage: "isolated work",
        abortSignal: new AbortController().signal,
        ...requestFields(),
      });
      await started;

      const isolated = _name === "continuation";
      expect(calls[0]?.options.liveInput !== undefined).toBe(!isolated);
      const offer = harness.offerLiveInput?.({
        conversationId: "conv-excluded",
        targetRunId: "run-excluded",
        id: "input-excluded",
        text: "must not be delivered",
        receivedAt: "2026-09-07T14:31:00.000Z",
      });
      expect(offer?.status).toBe(isolated ? "unavailable" : "accepted");

      releaseRuntime();
      await expect(running).resolves.toMatchObject({ text: "isolated result" });
    },
  );

  it("rotates process-local sessions for webhook model changes", async () => {
    const identityPath = await identityFixture();
    const base = createSessionFakeRuntime(async (call) => ({ text: `a${call}`, providerSessionId: `ps-${call}` }));
    const override = createFakeRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      session: continuousSession,
      piSessionsRoot: "/tmp/host-durable-pi",
      runtimeForModel: () => override.runtime,
      // Mirror the app extension: a webhook `model` in metadata → a parsed model
      // override. (Isolation itself is driven by the metadata, in the harness.)
      runtimeOptionsForRequest: (input) => {
        const webhook = (input.request.metadata as { webhook?: { model?: string } } | undefined)?.webhook;
        return {
          runtimeOptions: webhook?.model === undefined
            ? {}
            : {
              model: claudeModel,
              piSessionsRoot: "/tmp/extension-hijack",
              sessionId: "extension-session",
              providerSessionId: "extension-provider-session",
              sessionKeepAlive: true,
            } as never,
        };
      },
    });

    // An interactive turn warms the shared session on the base runtime.
    await harness.run(request("conv"));
    expect(base.calls[0]?.options.sessionKeepAlive).toBe(true);

    // A webhook model change starts a new warm-capable session on its owner:
    // no old resume id may cross the model boundary.
    await harness.run(webhookOverrideRequest("conv", claudeModel.reference));
    expect(override.calls).toHaveLength(1);
    expect(override.calls[0]?.options.sessionId).toBeUndefined();
    expect(override.calls[0]?.options.providerSessionId).toBeUndefined();
    expect(override.calls[0]?.options.sessionKeepAlive).toBe(true);
    expect(override.calls[0]?.options.piSessionsRoot).toBeUndefined();

    // Returning to the default starts a fresh model-bound epoch.
    await harness.run(request("conv"));
    expect(base.calls[1]?.options.sessionId).toBeUndefined();
    expect(base.disposed).toContain("ps-1");
  });

  it("rotates process-local sessions for Telegram model changes", async () => {
    const identityPath = await identityFixture();
    const base = createSessionFakeRuntime(async (call) => ({ text: `a${call}`, providerSessionId: `ps-${call}` }));
    const override = createFakeRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      session: continuousSession,
      runtimeForModel: () => override.runtime,
      runtimeOptionsForRequest: (input) => {
        const telegram = (input.request.metadata as {
          telegram?: { model?: string; effort?: string };
        } | undefined)?.telegram;
        return {
          runtimeOptions: telegram?.model === undefined
            ? {}
            : { model: claudeModel, ...(telegram.effort === undefined ? {} : { effort: telegram.effort }) },
        };
      },
    });

    await harness.run(request("telegram:42", "warm chat"));
    await harness.run(telegramOverrideRequest("telegram:42", {
      model: claudeModel.reference,
      effort: "high",
    }));

    expect(override.calls).toHaveLength(1);
    expect(override.calls[0]?.options.sessionId).toBeUndefined();
    expect(override.calls[0]?.options.providerSessionId).toBeUndefined();
    expect(override.calls[0]?.options.sessionKeepAlive).toBe(true);
    expect(override.calls[0]?.options.effort).toBe("high");

    await harness.run(request("telegram:42", "resume chat"));
    expect(base.calls[1]?.options.sessionId).toBeUndefined();
    expect(base.disposed).toContain("ps-1");
  });

  it("rotates process-local sessions for Slack model changes without triggering the undeclared-model guard", async () => {
    const identityPath = await identityFixture();
    const base = createSessionFakeRuntime(async (call) => ({ text: `a${call}`, providerSessionId: `ps-${call}` }));
    const override = createFakeRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      session: continuousSession,
      runtimeForModel: () => override.runtime,
      runtimeOptionsForRequest: (input) => {
        const slack = (input.request.metadata as { slack?: { model?: string } } | undefined)?.slack;
        return { runtimeOptions: slack?.model === undefined ? {} : { model: claudeModel } };
      },
    });

    await harness.run(request("slack:C1", "warm chat"));
    const response = await harness.run(slackOverrideRequest("slack:C1", claudeModel.reference));

    expect(response.failure).toBeUndefined();
    expect(override.calls).toHaveLength(1);
    expect(override.calls[0]?.options.sessionId).toBeUndefined();
    expect(override.calls[0]?.options.providerSessionId).toBeUndefined();
    expect(override.calls[0]?.options.sessionKeepAlive).toBe(true);

    await harness.run(request("slack:C1", "resume chat"));
    expect(base.calls[1]?.options.sessionId).toBeUndefined();
    expect(base.disposed).toContain("ps-1");
  });

  it("keeps same-model and effort-only Telegram turns on the shared session", async () => {
    const identityPath = await identityFixture();
    const base = createSessionFakeRuntime(async (call) => ({ text: `a${call}`, providerSessionId: `ps-${call}` }));
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      session: continuousSession,
      runtimeOptionsForRequest: (input) => {
        const telegram = (input.request.metadata as {
          telegram?: { model?: string; effort?: string };
        } | undefined)?.telegram;
        return {
          runtimeOptions: {
            ...(telegram?.model === undefined ? {} : { model: defaultModel }),
            ...(telegram?.effort === undefined ? {} : { effort: telegram.effort }),
          },
        };
      },
    });

    await harness.run(telegramOverrideRequest("telegram:42", { model: defaultModel.reference }));
    await harness.run(telegramOverrideRequest("telegram:42", { effort: "high" }));

    expect(base.calls[0]?.options.sessionKeepAlive).toBe(true);
    expect(base.calls[1]?.options.sessionId).toBe("ps-1");
    expect(base.calls[1]?.options.effort).toBe("high");
  });

  it("keeps the undeclared_model_override guard fail-closed before provider execution", async () => {
    const identityPath = await identityFixture();
    const base = createSessionFakeRuntime(async (call) => ({ text: `a${call}`, providerSessionId: `ps-${call}` }));
    const override = createFakeRuntime({ text: "wrong runtime", providerSessionId: "override-session" });
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      session: continuousSession,
      runtimeForModel: () => override.runtime,
      runtimeOptionsForRequest: ({ request: activeRequest }) => ({
        runtimeOptions: activeRequest.userMessage === "undeclared override" ? { model: claudeModel } : {},
      }),
    });

    await harness.run(request("conv", "warm base"));
    const rejected = await harness.run(request("conv", "undeclared override"));
    expect(rejected.failure).toMatchObject({ kind: "undeclared_model_override" });
    expect(override.calls).toHaveLength(0);

    await harness.run(request("conv", "base again"));
    expect(base.calls[1]?.options.sessionId).toBeUndefined();
  });

  it("a same-model override is NOT isolated — it resumes and persists the shared session", async () => {
    const identityPath = await identityFixture();
    const base = createSessionFakeRuntime(async (call) => ({ text: `a${call}`, providerSessionId: `ps-${call}` }));
    const override = createFakeRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      session: continuousSession,
      runtimeForModel: () => override.runtime,
      // Mirror the app extension: a webhook `model` that parses to the SAME model
      // as the host default is a redundant/no-op override.
      runtimeOptionsForRequest: (input) => {
        const webhook = (input.request.metadata as { webhook?: { model?: string } } | undefined)?.webhook;
        return { runtimeOptions: webhook?.model === undefined ? {} : { model: defaultModel } };
      },
    });

    // An interactive turn warms the shared session on the base runtime.
    await harness.run(request("conv"));
    expect(base.calls[0]?.options.sessionKeepAlive).toBe(true);

    // A webhook override naming the SAME model as the host default leaves the
    // model/runtime chain unchanged, so it must NOT be isolated: it stays on the
    // base runtime and resumes the shared session rather than starting fresh.
    await harness.run(webhookOverrideRequest("conv", defaultModel.reference));
    expect(override.calls).toHaveLength(0);
    expect(base.calls).toHaveLength(2);
    expect(base.calls[1]?.options.sessionId).toBe("ps-1");
    expect(base.calls[1]?.options.sessionKeepAlive).toBe(true);

    // The next interactive turn resumes the session the same-model turn PERSISTED.
    await harness.run(request("conv"));
    expect(base.calls[2]?.options.sessionId).toBe("ps-2");
  });

  it("an effort-only override is NOT isolated — it uses the shared session", async () => {
    const identityPath = await identityFixture();
    const base = createSessionFakeRuntime(async () => ({ text: "a", providerSessionId: "ps-shared" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      session: continuousSession,
      // Mirror the app extension: a cron `effort` in metadata → an effort override
      // (no model, so the turn is NOT isolated).
      runtimeOptionsForRequest: (input) => {
        const cron = (input.request.metadata as { cron?: { effort?: string } } | undefined)?.cron;
        return { runtimeOptions: cron?.effort === undefined ? {} : { effort: cron.effort } };
      },
    });

    await harness.run(effortOnlyCronRequest("conv"));
    expect(base.calls[0]?.options.sessionKeepAlive).toBe(true);
    expect(base.calls[0]?.options.effort).toBe("high");

    await harness.run(effortOnlyCronRequest("conv"));
    expect(base.calls[1]?.options.sessionId).toBe("ps-shared");
  });
});

describe("model binding admission and attribution", () => {
  it.each([codexModel, defaultModel])("rejects a declared override executed as $reference before provider execution", async (executedModel) => {
    const base = createFakeRuntime();
    const alternate = createFakeRuntime();
    const harness = createAgentHarness({ identityPath: await identityFixture(), model: defaultModel, runtime: base.runtime,
      session: { mode: "continuous", supportsResume: true, idleTimeoutMs: 60_000 }, runtimeForModel: () => alternate.runtime,
      runtimeOptionsForRequest: () => ({ runtimeOptions: { model: executedModel } }) });
    const response = await harness.run({ ...request(), metadata: { web: { model: claudeModel.reference } } });
    expect(response.failure?.kind).toBe("undeclared_model_override");
    expect(base.calls).toEqual([]);
    expect(alternate.calls).toEqual([]);
    await harness.dispose?.();
  });

  it("keeps a requested primary binding when a runtime reports a backup answer", async () => {
    const calls: RuntimeRunOptions[] = [];
    const events: AgentHarnessSessionEvent[] = [];
    const base = createFakeRuntime();
    const identityPath = await identityFixture();
    const harness = createAgentHarness({ identityPath, model: defaultModel, runtime: base.runtime,
      historyStore: createDurableHistoryStore({ root: join(identityPath, "..", "history"), retireProviderSession: async () => undefined }),
      piSessionsRoot: join(identityPath, "..", "pi"),
      session: { mode: "continuous", supportsResume: true, idleTimeoutMs: 60_000,
        onSessionEvent: (event) => { events.push(event); } },
      runtimeForModel: () => ({ refreshSession: async () => undefined, syncSession: async () => true, run: async (_prompt, options) => {
        calls.push(options);
        // This fake explicitly returns the coordinated handle as synchronized.
        // Warm reuse here proves attribution, not real fallback-chain policy.
        return { text: "backup answer", model: codexModel.reference, providerSessionId: String(options.sessionId ?? "primary-id") };
      } }),
      runtimeOptionsForRequest: () => ({ runtimeOptions: { model: claudeModel } }) });
    for (let i = 0; i < 3; i++) {
      expect((await harness.run({ ...request(), metadata: { web: { model: claudeModel.reference } } })).text).toBe("backup answer");
    }
    expect(calls[1]?.sessionId).toBe(calls[0]?.sessionId);
    expect(calls[2]?.sessionId).toBe(calls[0]?.sessionId);
    expect(events.filter((event) => event.reason === "model_change")).toEqual([]);
    expect(events.filter((event) => event.modelKey !== undefined).every((event) => event.modelKey === claudeModel.reference)).toBe(true);
    await harness.dispose?.();
  });
});


it("keeps a pinned proactive override isolated and mailbox-ineligible", async () => {
  const calls: RuntimeRunOptions[] = [];
  const events: Array<Record<string, unknown>> = [];
  const harness = createAgentHarness({ identityPath: await identityFixture(), model: defaultModel,
    historyStore: createInMemoryHistoryStore(),
    session: { mode: "continuous", supportsResume: true, idleTimeoutMs: 60000, isolateProactive: true },
    runtime: { run: async (_prompt, options) => { calls.push(options); return { text: "ok", providerSessionId: "base-id" }; } },
    runtimeOptionsForRequest: ({ request: current }) => ({ runtimeOptions: { model: current.metadata?.cron ? claudeModel : defaultModel } }) });
  try {
    await harness.run(request());
    const result = await harness.run({ ...request(), metadata: { cron: { model: claudeModel.reference } },
      onLiveInputOwnership: (event) => { expect(event).toMatchObject({ status: "closed", reason: "unsupported" }); },
      onEvent: (event) => { if (event.type === "session_boundary") events.push(event); } });
    expect(result.text).toBe("ok");
    expect(calls[1]?.sessionId).toBeUndefined();
    expect(calls[1]?.sessionKeepAlive).toBeUndefined();
    expect(events).toMatchObject([{ kind: "isolated", reason: "proactive" }]);
    await harness.run(request());
    expect(calls[2]?.sessionId).toBe("base-id");
  } finally { await harness.dispose?.(); }
});
