import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { RuntimeRunOptions, RuntimeModelReference } from "@mono-agent/runtime-adapter";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@mono-agent/agent-runtime/ai/runtime/registry.js", async (original) => ({
  ...await original<typeof import("@mono-agent/agent-runtime/ai/runtime/registry.js")>(),
  resolveRuntimeBridge: async () => ({ id: "session-attribution-test", execute }),
}));
const { createRequestModelOverrideRuntimeExtension } = await import("../request-model-override.js");
const { createConfiguredAgentHarness, createConfiguredAgentRuntime } = await import("../index.js");
const dirs: string[] = [];
afterEach(async () => { execute.mockReset(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const model = (name: string) => ({ provider: "faux", model: name, reference: `faux:${name}` });
async function config(backup: boolean): Promise<MonoAgentConfig> {
  const dir = await mkdtemp(join(tmpdir(), "configured-model-session-"));
  dirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.");
  return { runtime: { model: model("base"), maxTurns: 4, workspace: dir,
    session: { mode: "continuous", idleTimeoutMs: 60000 }, compaction: { enabled: false },
    retry: { primaryAttempts: backup ? 1 : 2, backoffMs: 0, maxBackoffMs: 0 },
    ...(backup ? { fallbacks: [{ model: model("backup") }] } : {}) },
    providers: { piNative: { piSessionsRoot: join(dir, "pi") } },
    context: { identityPath, selectedSkills: [] }, tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(dir, "artifacts"), retention: { maxAgeDays: 365, maxCount: 100, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 100, dryRun: false } },
    traceability: { registryDir: join(dir, "sources") } };
}

it("keeps override fallback answers stateless without a model-change boundary", async () => {
  const settings = await config(true);
  execute.mockImplementation(async (_prompt: string, options: RuntimeRunOptions) => options.model.model === "override"
    ? { text: null, error: "overloaded", failureKind: "provider_unavailable", events: [] }
    : { text: "backup answer", model: "faux:backup", events: [] });
  const factory = vi.fn((primary: RuntimeModelReference) => createConfiguredAgentRuntime({ config: settings, cwd: settings.runtime.workspace, model: primary }));
  const harness = await createConfiguredAgentHarness({ config: settings, cwd: settings.runtime.workspace,
    runtimeForModel: factory, runtimeOptionsForRequest: createRequestModelOverrideRuntimeExtension({ baseModel: settings.runtime.model }) });
  const events: unknown[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const result = await harness.run({ conversationId: "c", userMessage: "hello", abortSignal: new AbortController().signal,
        metadata: { web: { model: "faux:override" } }, onEvent: (event) => { events.push(event); } });
      expect(result).toMatchObject({ text: "backup answer" });
    }
    const attempts = execute.mock.calls.map((call) => call[1] as RuntimeRunOptions);
    expect(attempts.map((options) => options.model.model)).toEqual(["override", "backup", "override", "backup"]);
    for (const backup of attempts.filter((options) => options.model.model === "backup")) {
      for (const key of ["sessionId", "providerSessionId", "sessionKeepAlive", "sessionIdleTimeoutMs"]) expect(backup[key]).toBeUndefined();
    }
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(model("override"));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "session_boundary", reason: "model_change" }));
    // The binding is the requested chain primary. Whether the primary's first
    // attempt has a durable session is owned by fallback-aware-sessions.
  } finally { await harness.dispose?.(); }
});

it("keeps retry-only model overrides warm on their cached primary runtime", async () => {
  const settings = await config(false);
  const calls: RuntimeRunOptions[] = [];
  execute.mockImplementation(async (_prompt: string, options: RuntimeRunOptions) => {
    calls.push(options);
    return { text: "primary answer", providerSessionId: "primary-session", events: [] };
  });
  // A process-local store isolates cached router/handle wiring from Pi I/O.
  const { createInMemoryHistoryStore } = await import("@mono-agent/agent-harness");
  const factory = vi.fn((primary: RuntimeModelReference) => createConfiguredAgentRuntime({ config: settings, cwd: settings.runtime.workspace, model: primary }));
  const harness = await createConfiguredAgentHarness({ config: settings, cwd: settings.runtime.workspace,
    runtimeForModel: factory, runtimeOptionsForRequest: createRequestModelOverrideRuntimeExtension({ baseModel: settings.runtime.model }), historyStore: createInMemoryHistoryStore() });
  try {
    for (let i = 0; i < 3; i++) {
      expect((await harness.run({ conversationId: "c", userMessage: "hello", abortSignal: new AbortController().signal,
        metadata: { web: { model: "faux:override" } } }))).toMatchObject({ text: "primary answer" });
    }
    expect(factory).toHaveBeenCalledTimes(1);
    expect(calls.every((options) => options.model.reference === "faux:override")).toBe(true);
    expect(calls[1]?.sessionId).toBe("primary-session");
    expect(calls[2]?.sessionId).toBe("primary-session");
  } finally { await harness.dispose?.(); }
});
