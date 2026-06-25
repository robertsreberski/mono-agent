import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeModelReference, RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";

import { createAgentHarness } from "../index.js";
import type { AgentHarnessSessionOptions } from "../index.js";

const tempDirs: string[] = [];
const defaultModel = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;
const claudeModel = { sdk: "claude", model: "claude-opus-4-8", reference: "claude:claude-opus-4-8" } as const;
const codexModel = { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" } as const;

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
  it("runs an override on the runtimeForModel runtime; an incompatible host mode falls back to the model default", async () => {
    const identityPath = await identityFixture();
    const base = createFakeRuntime();
    const override = createFakeRuntime();
    const factoryCalls: Array<{ model: RuntimeModelReference; executionMode: string | undefined }> = [];

    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      executionMode: "sdk",
      effort: "low",
      runtimeForModel: (model, executionMode) => {
        factoryCalls.push({ model, executionMode });
        return override.runtime;
      },
      // codex override under an sdk host → codex is cli-only, so the harness
      // derives executionMode "cli" (model default), not the host's "sdk".
      runtimeOptionsForRequest: () => ({ runtimeOptions: { model: codexModel, effort: "high" } }),
    });

    await harness.run(request());

    expect(base.calls).toHaveLength(0);
    expect(override.calls).toHaveLength(1);
    expect(factoryCalls).toEqual([{ model: codexModel, executionMode: "cli" }]);

    const options = override.calls[0]?.options as Record<string, unknown>;
    expect(options.model).toEqual(codexModel);
    expect(options.effort).toBe("high");
    expect(options.executionMode).toBe("cli");
  });

  it("preserves a compatible host executionMode across a same-family override", async () => {
    const identityPath = await identityFixture();
    const base = createFakeRuntime();
    const override = createFakeRuntime();
    const factoryCalls: Array<{ model: RuntimeModelReference; executionMode: string | undefined }> = [];

    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      // Host runs in cli mode; claude supports cli, so the override keeps cli
      // rather than being flipped to the model default (sdk).
      executionMode: "cli",
      runtimeForModel: (model, executionMode) => {
        factoryCalls.push({ model, executionMode });
        return override.runtime;
      },
      runtimeOptionsForRequest: () => ({ runtimeOptions: { model: claudeModel } }),
    });

    await harness.run(request());

    expect(factoryCalls).toEqual([{ model: claudeModel, executionMode: "cli" }]);
    expect((override.calls[0]?.options as Record<string, unknown>).executionMode).toBe("cli");
  });

  it("uses the shared runtime and harness defaults when no override is returned", async () => {
    const identityPath = await identityFixture();
    const base = createFakeRuntime();
    let factoryCalled = false;

    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      executionMode: "sdk",
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
    expect(options.executionMode).toBe("sdk");
    expect(options.effort).toBe("low");
  });

  it("keeps messages harness-owned even if an extension tries to override them", async () => {
    const identityPath = await identityFixture();
    const base = createFakeRuntime();

    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      executionMode: "sdk",
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

describe("AgentHarness per-trigger override session isolation", () => {
  it("a model-override turn neither resumes nor persists the shared session", async () => {
    const identityPath = await identityFixture();
    const base = createSessionFakeRuntime(async (call) => ({ text: `a${call}`, providerSessionId: `ps-${call}` }));
    const override = createFakeRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      executionMode: "sdk",
      session: continuousSession,
      runtimeForModel: () => override.runtime,
      // Mirror the app extension: a webhook `model` in metadata → a parsed model
      // override. (Isolation itself is driven by the metadata, in the harness.)
      runtimeOptionsForRequest: (input) => {
        const webhook = (input.request.metadata as { webhook?: { model?: string } } | undefined)?.webhook;
        return { runtimeOptions: webhook?.model === undefined ? {} : { model: claudeModel } };
      },
    });

    // An interactive turn warms the shared session on the base runtime.
    await harness.run(request("conv"));
    expect(base.calls[0]?.options.sessionKeepAlive).toBe(true);

    // A webhook model-override turn runs on the override runtime and is isolated:
    // no resume keys, so it cannot inherit or corrupt the base-model session.
    await harness.run(webhookOverrideRequest("conv", "claude:claude-opus-4-8"));
    expect(override.calls).toHaveLength(1);
    expect(override.calls[0]?.options.sessionId).toBeUndefined();
    expect(override.calls[0]?.options.providerSessionId).toBeUndefined();

    // A following interactive turn resumes the FIRST interactive turn's session —
    // the override turn persisted nothing into the shared store.
    await harness.run(request("conv"));
    expect(base.calls[1]?.options.sessionId).toBe("ps-1");
  });

  it("an effort-only override is NOT isolated — it uses the shared session", async () => {
    const identityPath = await identityFixture();
    const base = createSessionFakeRuntime(async () => ({ text: "a", providerSessionId: "ps-shared" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: base.runtime,
      model: defaultModel,
      executionMode: "sdk",
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
