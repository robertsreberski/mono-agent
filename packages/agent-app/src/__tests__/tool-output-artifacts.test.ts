import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import type { RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createToolOutputArtifactsRuntimeExtension } from "../tool-output-artifacts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function input(runId: string): AgentHarnessRuntimeOptionsInput {
  return {
    request: {
      conversationId: "conversation-1",
      userMessage: "test",
      abortSignal: new AbortController().signal,
    },
    runId,
    context: {},
  } as unknown as AgentHarnessRuntimeOptionsInput;
}

describe("createToolOutputArtifactsRuntimeExtension", () => {
  it("binds the harness run id, wins over caller wiring, and preserves cleanup hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-tool-output-"));
    roots.push(root);
    const artifactRoot = join(root, "tool-output");
    const callerSink = vi.fn(() => "/unsafe/caller-path");
    const cleanup = vi.fn(async () => undefined);
    const settleCleanup = vi.fn(async () => undefined);
    const extension = createToolOutputArtifactsRuntimeExtension(async () => ({
      runtimeOptions: { persistArtifact: callerSink, maxTurns: 3 },
      cleanup,
      settleCleanup,
    }), artifactRoot);

    const result = await extension(input("run/app 1"));
    const buffer = Buffer.from("raw untrusted output", "utf8");
    const sink = result.runtimeOptions?.persistArtifact as RuntimeRunOptions["persistArtifact"];
    const path = sink?.({
      filename: "WebSearch__call__0.txt",
      buffer,
      toolName: "WebSearch",
      toolUseId: "call",
    });

    expect(callerSink).not.toHaveBeenCalled();
    expect(result.runtimeOptions?.maxTurns).toBe(3);
    expect(path).toBe(join(await realpath(root), "tool-output", "run-app-1", "WebSearch__call__0.txt"));
    expect(await readFile(path!)).toEqual(buffer);
    if (process.platform !== "win32") expect((await lstat(path!)).mode & 0o777).toBe(0o600);
    await result.cleanup?.();
    await result.settleCleanup?.();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(settleCleanup).toHaveBeenCalledOnce();
  });

  it("returns null instead of failing when the destination is unsafe", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-tool-output-"));
    roots.push(root);
    const artifactRoot = join(root, "tool-output");
    const extension = createToolOutputArtifactsRuntimeExtension(undefined, artifactRoot);
    const result = await extension(input("run-1"));
    const sink = result.runtimeOptions?.persistArtifact as RuntimeRunOptions["persistArtifact"];
    expect(sink?.({ filename: "../escape.txt", buffer: Buffer.from("x"), toolName: "Bash", toolUseId: null })).toBeNull();
  });
});
