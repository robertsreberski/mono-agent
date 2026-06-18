import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { HistoryMessage } from "@mono-agent/context";
import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/memory-store";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { AgentHarnessError, createAgentHarness, createInMemoryHistoryStore } from "../index.js";
import type { AgentHarnessSessionOptions, ConversationHistoryStore } from "../index.js";

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

function createSpyHistoryStore() {
  const appended: HistoryMessage[] = [];
  const store: ConversationHistoryStore = {
    async load(): Promise<readonly HistoryMessage[]> {
      return [];
    },
    async append(_conversationId: string, messages: readonly HistoryMessage[]): Promise<void> {
      appended.push(...messages);
    },
  };
  return { appended, store };
}

function createSpyMemoryStore() {
  let hostSummaryCalls = 0;
  let captureCalls = 0;
  const store: MemoryStore = {
    async load(): Promise<MemoryBlock | undefined> {
      return undefined;
    },
    async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
      hostSummaryCalls += 1;
      return { conversationId, source: "spy", bytesWritten: summary.length };
    },
    scheduleCapture(): void {
      captureCalls += 1;
    },
  };
  return { store, hostSummaryCalls: () => hostSummaryCalls, captureCalls: () => captureCalls };
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

  it("a cold/derived-id durable resume still sends history so create-on-miss keeps prior context (F9/Issue-2)", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-d");
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-d" }));
    // piSessionsRoot configured → the harness derives a STABLE id for durable
    // resume even on the FIRST turn (no live record).
    const harness = createAgentHarness({
      identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session,
      piSessionsRoot: join(tmpdir(), "pi-sessions-issue2"),
    });

    const first = await harness.run(request("conv-d", "first question"));
    expect(first.text).toBe("answer");
    // A derived, non-empty session id is passed so a restart can resume the on-disk
    // JSONL (rather than starting a fresh session and orphaning it).
    expect(typeof fake.calls[0]?.options.sessionId).toBe("string");
    expect((fake.calls[0]?.options.sessionId as string).length).toBeGreaterThan(0);
    // ...AND history is NOT omitted: with no confirmed live session, the harness
    // cannot assume the on-disk session exists, so it still sends history. pi-native
    // ignores it on a real resume and SEEDS it on create-on-miss — so an existing
    // conversation never loses prior context. (The Issue-2 regression keyed
    // omitHistory on the derived id, dropping history on create-on-miss.)
    expect(fake.calls[0]?.prompt).toContain(HISTORY_MARKER);

    // Once a live record exists, the warm-resume optimization omits history again.
    const second = await harness.run(request("conv-d", "second question"));
    expect(fake.calls[1]?.options.sessionId).toBe("ps-d");
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

  it("retries once with history when a resumed attempt throws a structured session miss", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        throw new AgentHarnessError("session_not_found", "session expired");
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

  it("retries once with history when the resumed session is busy", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { failureKind: "session_busy", error: "session is busy" };
      }
      return { text: "recovered", providerSessionId: "ps-next" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1", "again"));
    expect(second.text).toBe("recovered");
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-next");
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
    expect(fake.disposedSessions).toContain("ps-next");
  });

  it("does not replay history when the resumed attempt throws without session failure details", async () => {
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
    expect(second.failure).toMatchObject({ kind: "Error", message: "transport died" });
    expect(fake.calls).toHaveLength(2);
    expect(fake.disposedSessions).not.toContain("ps-next");
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

  it("dispose retires this harness's tracked sessions without touching the process-global registries", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    await harness.dispose?.();
    expect(fake.disposedSessions).toContain("ps-1");
    // Other harnesses may share the provider registries; dispose must stay
    // scoped to this harness's conversations.
    expect(fake.disposedAllCount()).toBe(0);

    // After dispose the next run starts fresh.
    await harness.run(request("conv-1"));
    expect(fake.calls[1]?.options.sessionId).toBeUndefined();
  });

  it("the stale retry keeps sessionKeepAlive and the idle timeout so a fresh provider session is captured", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { failureKind: "session_not_found", error: "gone" };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));
    const retryCall = fake.calls[2];
    expect(retryCall?.options.sessionId).toBeUndefined();
    expect(retryCall?.options.sessionKeepAlive).toBe(true);
    expect(retryCall?.options.sessionIdleTimeoutMs).toBe(60_000);
  });

  it("retries exactly once even when the retry also fails", async () => {
    const identityPath = await identityFixture();
    let seeded = false;
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (!seeded) {
        seeded = true;
        return { text: "ok", providerSessionId: "ps-1" };
      }
      return options.sessionId !== undefined
        ? { failureKind: "session_not_found", error: "gone" }
        : { failureKind: "provider_unavailable", error: "still down" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1"));
    expect(second.failure).toMatchObject({ kind: "provider_unavailable" });
    expect(fake.calls).toHaveLength(3);
  });

  it("does not replay history for non-session provider failures during resume", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { failureKind: "provider_unavailable", error: "stream disconnected" };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1", "again"));
    expect(second.failure).toMatchObject({ kind: "provider_unavailable", message: "stream disconnected" });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
    expect(fake.calls[1]?.prompt).not.toContain(HISTORY_MARKER);
    expect(fake.disposedSessions).toContain("ps-1");

    const third = await harness.run(request("conv-1", "after failure"));
    expect(third.text).toBe("ok");
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
  });

  it("does not replay history for an error-only resumed result without a session failure kind", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { error: "thread evaporated" };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1"));
    expect(second.failure).toMatchObject({ kind: "runtime_error", message: "thread evaporated" });
    expect(fake.calls).toHaveLength(2);
  });

  it("an empty resumed turn retires the session so the next message replays history", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { text: "   ", providerSessionId: options.sessionId as string };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1"));
    expect(second.failure).toMatchObject({ kind: "empty_response" });
    expect(fake.disposedSessions).toContain("ps-1");
    const third = await harness.run(request("conv-1"));
    expect(third.text).toBe("ok");
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
  });

  it("request extensions cannot clobber the harness session keys", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      session,
      runtimeOptionsForRequest: () => ({
        runtimeOptions: { sessionId: "hijacked", sessionKeepAlive: false } as Record<string, unknown>,
      }),
    });

    await harness.run(request("conv-1"));
    expect(fake.calls[0]?.options.sessionId).toBeUndefined();
    expect(fake.calls[0]?.options.sessionKeepAlive).toBe(true);
    await harness.run(request("conv-1"));
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
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

  it("does not commit a cancelled turn that returns success after a mid-turn abort (F3)", async () => {
    const identityPath = await identityFixture();
    const history = createSpyHistoryStore();
    const memory = createSpyMemoryStore();
    const controller = new AbortController();
    // The runtime ignores the abort and returns a success-shaped result, but the
    // live-session cancel signal landed mid-turn — request.abortSignal is aborted
    // by the time runRuntime() resolves. This is the TOCTOU race F3 guards.
    const fake = createSessionFakeRuntime(async () => {
      controller.abort(new Error("cancelled mid-turn"));
      return { text: "done", providerSessionId: "ps-x" };
    });
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      session,
      historyStore: history.store,
      memory: memory.store,
      memoryWriteMode: "capture",
    });

    const response = await harness.run({ conversationId: "conv-1", userMessage: "hello", abortSignal: controller.signal });

    // The response is a cancelled failure, not a committed success.
    expect(response.text).toBeUndefined();
    expect(response.failure?.kind).toBe("cancelled");
    // No history committed for the cancelled turn.
    expect(history.appended).toHaveLength(0);
    // No memory written for the cancelled turn.
    expect(memory.hostSummaryCalls()).toBe(0);
    expect(memory.captureCalls()).toBe(0);
    // The returned provider session was disposed, so the next message replays
    // history into a fresh session rather than resuming a cancelled-turn session.
    expect(fake.disposedSessions).toContain("ps-x");
  });

  it("does not retain a cancelled turn's warm session for the next turn (F3)", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    let runCount = 0;
    // Turn 1 establishes a warm session (ps-1). Turn 2 resumes it, but aborts
    // mid-turn while returning success — the cancelled turn must retire ps-1 so
    // turn 3 goes fresh (no resume of a session diverged from history).
    const abortOnSecond = new AbortController();
    const fake = createSessionFakeRuntime(async (_prompt, _options, call) => {
      runCount = call;
      if (call === 2) {
        abortOnSecond.abort(new Error("cancelled mid-turn"));
        return { text: "ignored", providerSessionId: "ps-1" };
      }
      return { text: "answer", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1", "first"));
    expect(fake.calls[0]?.options.sessionId).toBeUndefined();

    const cancelled = await harness.run({ conversationId: "conv-1", userMessage: "second", abortSignal: abortOnSecond.signal });
    expect(cancelled.failure?.kind).toBe("cancelled");
    // ps-1 was retired (evicted) on the cancelled turn.
    expect(fake.disposedSessions).toContain("ps-1");

    // Turn 3 must go fresh (no sessionId) and replay history.
    await harness.run(request("conv-1", "third"));
    expect(runCount).toBe(3);
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
  });
});
