import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@worklab-ai/runtime-adapter";

import { createAgentHarness, createInMemoryHistoryStore } from "../index.js";
import type { AgentHarnessSessionOptions } from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;
const HISTORY_MARKER = "EARLIER-HISTORY-MARKER";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-sessions-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

interface FakeRuntimeCall {
  readonly prompt: string;
  readonly options: RuntimeRunOptions;
}

function createSessionFakeRuntime(run: (prompt: string, options: RuntimeRunOptions, call: number) => Promise<RuntimeResult>) {
  const calls: FakeRuntimeCall[] = [];
  const disposedSessions: string[] = [];
  let disposedAll = 0;
  return {
    calls,
    disposedSessions,
    disposedAllCount: () => disposedAll,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return await run(prompt, options, calls.length);
      },
      async disposeSession(providerSessionId: string): Promise<boolean> {
        disposedSessions.push(providerSessionId);
        return true;
      },
      async disposeAllSessions(): Promise<void> {
        disposedAll += 1;
      },
    },
  };
}

const session: AgentHarnessSessionOptions = { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true };

async function primedHistoryStore(conversationId: string) {
  const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
  await historyStore.append(conversationId, [
    { role: "assistant", content: HISTORY_MARKER, timestamp: "2026-06-01T00:00:00Z" },
  ]);
  return historyStore;
}

function request(conversationId: string, userMessage = "hello") {
  return { conversationId, userMessage, abortSignal: new AbortController().signal };
}

describe("AgentHarness continuous sessions", () => {
  it("first run goes fresh with history, second run resumes without history", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    const first = await harness.run(request("conv-1", "first question"));
    expect(first.text).toBe("answer");
    expect(fake.calls[0]?.options.sessionId).toBeUndefined();
    expect(fake.calls[0]?.options.sessionKeepAlive).toBe(true);
    expect(fake.calls[0]?.prompt).toContain(HISTORY_MARKER);

    const second = await harness.run(request("conv-1", "second question"));
    expect(second.text).toBe("answer");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
    expect(fake.calls[1]?.options.providerSessionId).toBe("ps-1");
    expect(fake.calls[1]?.options.sessionKeepAlive).toBe(true);
    expect(fake.calls[1]?.prompt).not.toContain(HISTORY_MARKER);
  });

  it("tracks provider session id rotation", async () => {
    const identityPath = await identityFixture();
    const ids = ["ps-1", "ps-2", "ps-3"];
    const fake = createSessionFakeRuntime(async (_p, _o, call) => ({ text: "ok", providerSessionId: ids[call - 1] ?? null }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
    expect(fake.calls[2]?.options.sessionId).toBe("ps-2");
    // Rotation retires the superseded provider session.
    expect(fake.disposedSessions).toEqual(["ps-1", "ps-2"]);
  });

  it("retries once with history when the resumed session is stale", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { failureKind: "session_not_found", error: "session expired" };
      }
      return { text: "recovered", providerSessionId: "ps-next" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    const first = await harness.run(request("conv-1"));
    expect(first.text).toBe("recovered");

    const second = await harness.run(request("conv-1", "again"));
    expect(second.text).toBe("recovered");
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-next");
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
    expect(fake.disposedSessions).toContain("ps-next");
  });

  it("retries once with history when the resumed attempt throws", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        throw new Error("transport died");
      }
      return { text: "recovered", providerSessionId: "ps-next" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1"));
    expect(second.text).toBe("recovered");
    expect(fake.calls).toHaveLength(3);
  });

  it("does not retry cancelled resumed runs", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { cancelled: true };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1"));
    expect(second.failure).toMatchObject({ kind: "cancelled" });
    expect(fake.calls).toHaveLength(2);
  });

  it("never passes session keys when resume is unsupported", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      session: { ...session, supportsResume: false },
    });

    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));
    for (const call of fake.calls) {
      expect(call.options.sessionId).toBeUndefined();
      expect(call.options.sessionKeepAlive).toBeUndefined();
    }
  });

  it("never passes session keys in per-message mode", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      session: { mode: "per-message", idleTimeoutMs: 60_000, supportsResume: true },
    });

    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));
    for (const call of fake.calls) {
      expect(call.options.sessionId).toBeUndefined();
      expect(call.options.sessionKeepAlive).toBeUndefined();
    }
  });

  it("still appends history on resumed successful turns", async () => {
    const identityPath = await identityFixture();
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1", "first"));
    await harness.run(request("conv-1", "second"));
    const history = await historyStore.load("conv-1");
    expect(history).toHaveLength(4);
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("a concurrent second run goes fresh instead of resuming a busy session", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fake = createSessionFakeRuntime(async (_prompt, _options, call) => {
      if (call === 2) {
        await firstGate;
      }
      return { text: `answer-${call}`, providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1", "seed"));
    const inFlight = harness.run(request("conv-1", "long"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const concurrent = await harness.run(request("conv-1", "while busy"));
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
    expect(concurrent.text).toBe("answer-3");
    releaseFirst?.();
    await inFlight;
  });

  it("dispose retires store records and provider sessions", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    await harness.dispose?.();
    expect(fake.disposedSessions).toContain("ps-1");
    expect(fake.disposedAllCount()).toBe(1);

    // After dispose the next run starts fresh.
    await harness.run(request("conv-1"));
    expect(fake.calls[1]?.options.sessionId).toBeUndefined();
  });

  it("emits a session_resume_retry warning on stale retry", async () => {
    const identityPath = await identityFixture();
    const events: unknown[] = [];
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { failureKind: "session_not_found", error: "gone" };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    await harness.run({ ...request("conv-1"), onEvent: (event) => events.push(event) });
    expect(events).toContainEqual(expect.objectContaining({
      type: "runtime_warning",
      warning_kind: "session_resume_retry",
      provider_session_id: "ps-1",
    }));
  });
});
