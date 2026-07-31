import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import type { RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfiguredAgentResponderForApp } from "../configured-agent.js";
import { sessionRolloverForChannel } from "../app-controller-responder.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "console-rollover-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("sessionRolloverForChannel", () => {
  it("keeps a console channel on one conversation id whatever the agent configured", () => {
    expect(sessionRolloverForChannel("tui", "daily")).toBe("none");
    expect(sessionRolloverForChannel("tui", "none")).toBe("none");
    expect(sessionRolloverForChannel("tui", undefined)).toBe("none");
  });

  it("leaves every other channel on the configured policy", () => {
    expect(sessionRolloverForChannel("telegram", "daily")).toBe("daily");
    expect(sessionRolloverForChannel("cron", "daily")).toBe("daily");
    expect(sessionRolloverForChannel("slack", undefined)).toBeUndefined();
    expect(sessionRolloverForChannel(undefined, "daily")).toBe("daily");
  });
});

describe("console conversations under daily rollover", () => {
  const respondOnce = async (sessionRollover: "none" | undefined): Promise<string> => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");
    const seen: string[] = [];
    const runtime = {
      async run(_prompt: string, _options: RuntimeRunOptions): Promise<RuntimeResult> {
        return { text: "done" };
      },
      disposeAllSessions: vi.fn(async () => undefined),
    };

    const responder = await createConfiguredAgentResponderForApp({
      config: monoConfig(dir, identityPath),
      runtime,
      createRunId: () => "run-console",
      runtimeOptionsForRequest: ({ request }) => {
        seen.push(request.conversationId);
        return { runtimeOptions: {}, cleanup: async () => {} };
      },
    }, sessionRollover === undefined ? {} : { sessionRollover });

    await responder.respond(
      {
        conversationId: "web:thread-1",
        text: "Go ahead with group A.",
        abortSignal: new AbortController().signal,
      },
      { append: async () => {} },
    );
    await (responder as { dispose?: () => Promise<void> }).dispose?.();
    return seen[0] ?? "";
  };

  it("buckets an ordinary channel by local day, as configured", async () => {
    expect(await respondOnce(undefined)).toMatch(/^web:thread-1#\d{4}-\d{2}-\d{2}$/u);
  });

  // The console thread IS the session boundary: the reader opens a thread and
  // presses "New thread" when they want a fresh one. Bucketing it by day made a
  // next-morning follow-up wake with no transcript at all.
  it("leaves a console thread on its permanent conversation id across days", async () => {
    expect(await respondOnce("none")).toBe("web:thread-1");
  });
});

function monoConfig(dir: string, identityPath: string): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: dir,
      session: { mode: "continuous", idleTimeoutMs: 1_800_000, rollover: "daily" },
    },
    context: {
      identityPath,
      selectedSkills: [],
    },
    tools: {
      allowedTools: [],
      disallowedTools: [],
    },
    artifacts: {
      dir: join(dir, "artifacts"),
      retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false },
    },
    traceability: {
      registryDir: join(dir, "trace"),
    },
  };
}
