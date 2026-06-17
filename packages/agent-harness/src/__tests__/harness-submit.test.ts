import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { createAgentHarness } from "../index.js";
import type { AgentHarnessSessionOptions } from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;
const continuous: AgentHarnessSessionOptions = { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-submit-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

function createSessionFakeRuntime(run: (prompt: string, options: RuntimeRunOptions, call: number) => Promise<RuntimeResult>) {
  const calls: { prompt: string; options: RuntimeRunOptions }[] = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return await run(prompt, options, calls.length);
      },
      async disposeSession(): Promise<boolean> {
        return true;
      },
      async disposeAllSessions(): Promise<void> {},
    },
  };
}

function request(conversationId: string, userMessage = "hello") {
  return { conversationId, userMessage, abortSignal: new AbortController().signal };
}

describe("AgentHarness.submit (queue-after-turn)", () => {
  it("serializes same-conversation turns so the second resumes the first's provider session", async () => {
    const identityPath = await identityFixture();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fake = createSessionFakeRuntime(async (_prompt, _options, call) => {
      if (call === 1) {
        await firstGate;
      }
      return { text: `answer-${call}`, providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session: continuous });

    const p1 = harness.submit?.(request("conv-1", "first"));
    const p2 = harness.submit?.(request("conv-1", "second"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The second turn is queued, not racing: only the first runtime call exists.
    expect(fake.calls).toHaveLength(1);

    releaseFirst?.();
    await p1;
    await p2;

    expect(fake.calls).toHaveLength(2);
    // Proof the second waited: it resumed the first turn's provider session
    // instead of starting fresh (the busy-race behavior of run()).
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
  });

  it("falls back to run() (no queue) when not in continuous mode", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      session: { mode: "per-message", idleTimeoutMs: 60_000, supportsResume: true },
    });

    const res = await harness.submit?.(request("conv-1"));
    expect(res?.text).toBe("ok");
  });
});
