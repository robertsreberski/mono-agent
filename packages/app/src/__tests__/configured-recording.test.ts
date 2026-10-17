import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecorder, RunSummary, RuntimeResultLike } from "@mono-agent/observability";

const { createJsonlRunRecorder } = vi.hoisted(() => ({ createJsonlRunRecorder: vi.fn() }));
vi.mock("@mono-agent/observability", () => ({ createJsonlRunRecorder }));

import { composeRunRecorder } from "../composition/run-recording.js";

const summary = { runId: "fixture-run", status: "succeeded" } as RunSummary;
const result = { text: "fixture answer" } as RuntimeResultLike;
const args = { runId: "fixture-run", conversationId: "chat:fixture" };

function recorder(): RunRecorder {
  return {
    onEvent: vi.fn(),
    start: vi.fn(async () => summary),
    prepareFinish: vi.fn(async () => undefined),
    commitFinish: vi.fn(async () => summary),
    finish: vi.fn(async () => summary),
    fail: vi.fn(async () => summary),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("configured recording commit boundary", () => {
  it("returns the JSONL recorder unchanged without a hook and preserves optional projection", () => {
    const jsonl = recorder();
    createJsonlRunRecorder.mockReturnValue(jsonl);
    expect(composeRunRecorder({ artifactDir: "/fictional/artifacts" }, args)).toBe(jsonl);
    expect(createJsonlRunRecorder).toHaveBeenCalledWith({ ...args, artifactDir: "/fictional/artifacts" });
    composeRunRecorder({ artifactDir: "/fictional/artifacts" }, {
      ...args, runKind: "memory", isolated: false, userInput: "", source: "memory", sourceDetail: "extract",
    });
    expect(createJsonlRunRecorder).toHaveBeenLastCalledWith({
      ...args, artifactDir: "/fictional/artifacts", artifactKind: "memory", isolated: false,
      userInput: "", source: "memory", sourceDetail: "extract",
    });
  });

  it("notifies after commits and shares one terminal summary across finish and fail", async () => {
    const jsonl = recorder();
    const phases: string[] = [];
    let settle!: (value: RunSummary) => void;
    jsonl.commitFinish = vi.fn(() => new Promise<RunSummary>((resolve) => { settle = resolve; }));
    createJsonlRunRecorder.mockReturnValue(jsonl);
    const onRunArtifactCommitted = vi.fn(({ phase }: { phase: string }) => { phases.push(phase); });
    const wrapped = composeRunRecorder({ artifactDir: "/fictional", onRunArtifactCommitted }, args);
    await wrapped.start!();
    expect(onRunArtifactCommitted).toHaveBeenCalledWith({ ...args, phase: "started" });
    const finished = wrapped.finish(result);
    await vi.waitFor(() => expect(jsonl.commitFinish).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const failed = wrapped.fail(new Error("late fixture failure"));
    expect(phases).toEqual(["started"]);
    settle(summary);
    expect(await finished).toBe(summary);
    expect(await failed).toBe(summary);
    expect(await wrapped.commitFinish!(result)).toBe(summary);
    expect(jsonl.fail).not.toHaveBeenCalled();
    expect(onRunArtifactCommitted).toHaveBeenLastCalledWith({ ...args, phase: "finished", summary });
    expect(phases).toEqual(["started", "finished"]);
  });

  it("preserves preparation failures without committing or notifying", async () => {
    const jsonl = recorder();
    const failure = new TypeError("fictional preparation failure");
    jsonl.prepareFinish = vi.fn(async () => { throw failure; });
    createJsonlRunRecorder.mockReturnValue(jsonl);
    const onRunArtifactCommitted = vi.fn();
    const wrapped = composeRunRecorder({ artifactDir: "/fictional", onRunArtifactCommitted }, args);
    await expect(wrapped.finish(result)).rejects.toBe(failure);
    expect(jsonl.commitFinish).not.toHaveBeenCalled();
    expect(onRunArtifactCommitted).not.toHaveBeenCalled();
  });

  it.each(["commitFinish", "fail"] as const)("latches a rejected %s without a terminal notification", async (method) => {
    const jsonl = recorder();
    const failure = new Error("fictional terminal failure");
    jsonl[method] = vi.fn(async () => { throw failure; });
    createJsonlRunRecorder.mockReturnValue(jsonl);
    const onRunArtifactCommitted = vi.fn();
    const wrapped = composeRunRecorder({ artifactDir: "/fictional", onRunArtifactCommitted }, args);
    await expect(method === "fail" ? wrapped.fail(failure) : wrapped.commitFinish!(result)).rejects.toBe(failure);
    await expect(wrapped.fail(new Error("another failure"))).rejects.toBe(failure);
    expect(jsonl[method]).toHaveBeenCalledOnce();
    expect(onRunArtifactCommitted).not.toHaveBeenCalled();
  });

  it.each([false, true])("contains a failing hook (async=%s) without replacing the recorded result", async (asyncFailure) => {
    const jsonl = recorder();
    createJsonlRunRecorder.mockReturnValue(jsonl);
    const onRunArtifactCommitted = () => {
      if (asyncFailure) return Promise.reject(new Error("fictional hook failure"));
      throw new Error("fictional hook failure");
    };
    const wrapped = composeRunRecorder({ artifactDir: "/fictional", onRunArtifactCommitted }, args);
    expect(await wrapped.start!()).toBe(summary);
    expect(await wrapped.finish(result)).toBe(summary);
  });
});
