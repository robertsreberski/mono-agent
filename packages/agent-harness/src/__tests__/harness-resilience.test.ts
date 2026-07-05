import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { MemoryStore } from "@mono-agent/agent-contracts";
import type { RuntimeResult } from "@mono-agent/runtime-adapter";
import type { SkillsCache } from "../skills/index.js";

import { createAgentHarness } from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-resilience-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

function fakeRuntime(result: RuntimeResult = { text: "ok", providerSessionId: "ps-1" }) {
  return {
    async run(): Promise<RuntimeResult> {
      return result;
    },
    async disposeSession(): Promise<boolean> {
      return true;
    },
    async disposeAllSessions(): Promise<void> {},
  };
}

function request(conversationId: string, userMessage = "hello") {
  return { conversationId, userMessage, abortSignal: new AbortController().signal };
}

describe("AgentHarness resilience + caching", () => {
  it("degrades to empty memory and warns (does not fail the turn) when memory.load throws", async () => {
    const identityPath = await identityFixture();
    const events: Array<Record<string, unknown>> = [];
    const memory = {
      load: async () => {
        throw new Error("ollama embeddings timed out");
      },
      appendHostSummary: async () => ({ ok: true }),
      scheduleCapture: () => {},
    } as unknown as MemoryStore;

    const harness = createAgentHarness({
      identityPath,
      runtime: fakeRuntime(),
      model,
      executionMode: "sdk",
      memory,
    });

    const response = await harness.run({
      ...request("conv-1"),
      onEvent: (event) => events.push(event as Record<string, unknown>),
    });

    // The turn still succeeds — a memory backend failure must not fail the request.
    expect(response.text).toBe("ok");
    expect(response.failure).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "runtime_warning", warning_kind: "memory_degraded" }),
    );
  });

  it("loads skills through the injected skills cache on every turn", async () => {
    const identityPath = await identityFixture();
    let calls = 0;
    const skillsCache: SkillsCache = {
      loadSelectedSkillsCached: async () => {
        calls += 1;
        return { index: [], instructions: [], loaded: [] };
      },
      clear: () => {},
    };

    const harness = createAgentHarness({
      identityPath,
      runtime: fakeRuntime(),
      model,
      executionMode: "sdk",
      skillsRoot: "/skills-root",
      selectedSkills: ["alpha"],
      skillsCache,
    });

    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));

    // loadSkills delegates to the cache (which dedupes disk reads internally).
    expect(calls).toBe(2);
  });
});
