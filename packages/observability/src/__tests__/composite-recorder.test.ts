import { describe, expect, it } from "vitest";

import { createCompositeRunRecorder } from "../composite-recorder.js";
import type {
  RunExportContext,
  RunExportEventContext,
  RunExporter,
  RunRecorder,
  RunSummary,
  RuntimeEventLike,
  RuntimeResultLike,
} from "../types.js";

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    conversationId: "chat-1",
    status: "succeeded",
    durationMs: 10,
    eventCount: 0,
    artifactPaths: [],
    ...overrides,
  };
}

interface RecorderCall {
  readonly method: "start" | "onEvent" | "finish" | "fail";
  readonly arg?: unknown;
}

function makeFakeRecorder(options: {
  readonly startSummary?: RunSummary;
  readonly finishSummary?: RunSummary;
  readonly failSummary?: RunSummary;
  readonly defineStart?: boolean;
} = {}): { recorder: RunRecorder; calls: RecorderCall[] } {
  const calls: RecorderCall[] = [];
  const defineStart = options.defineStart ?? true;
  const recorder: RunRecorder = {
    onEvent(event: RuntimeEventLike): void {
      calls.push({ method: "onEvent", arg: event });
    },
    async finish(result: RuntimeResultLike): Promise<RunSummary> {
      calls.push({ method: "finish", arg: result });
      return options.finishSummary ?? makeSummary({ status: "succeeded" });
    },
    async fail(error: unknown): Promise<RunSummary> {
      calls.push({ method: "fail", arg: error });
      return options.failSummary ?? makeSummary({ status: "failed", failureKind: "internal" });
    },
  };
  if (defineStart) {
    recorder.start = async (): Promise<RunSummary> => {
      calls.push({ method: "start" });
      return options.startSummary ?? makeSummary({ status: "running" });
    };
  }
  return { recorder, calls };
}

interface ExporterCall {
  readonly method: "start" | "onEvent" | "finish" | "fail" | "flush" | "close";
  readonly event?: RuntimeEventLike;
  readonly eventIndex?: number;
  readonly summary?: RunSummary;
  readonly error?: unknown;
}

function makeFakeExporter(options: {
  readonly throwOn?: ExporterCall["method"];
  readonly hangOn?: ExporterCall["method"];
} = {}): { exporter: RunExporter; calls: ExporterCall[] } {
  const calls: ExporterCall[] = [];
  function maybe(method: ExporterCall["method"]): Promise<void> {
    if (options.throwOn === method) {
      throw new Error(`boom-${method}`);
    }
    if (options.hangOn === method) {
      return new Promise<void>(() => {
        /* never resolves */
      });
    }
    return Promise.resolve();
  }
  const exporter: RunExporter = {
    async start(context: RunExportContext): Promise<void> {
      calls.push({ method: "start" });
      void context;
      return maybe("start");
    },
    async onEvent(event: RuntimeEventLike, context: RunExportEventContext): Promise<void> {
      calls.push({ method: "onEvent", event, eventIndex: context.eventIndex });
      return maybe("onEvent");
    },
    async finish(summary: RunSummary, context: RunExportContext): Promise<void> {
      calls.push({ method: "finish", summary });
      void context;
      return maybe("finish");
    },
    async fail(summary: RunSummary, error: unknown, context: RunExportContext): Promise<void> {
      calls.push({ method: "fail", summary, error });
      void context;
      return maybe("fail");
    },
    async flush(): Promise<void> {
      calls.push({ method: "flush" });
      return maybe("flush");
    },
  };
  return { exporter, calls };
}

function makeContext(overrides: Partial<RunExportContext> = {}): RunExportContext {
  return {
    runId: "run-1",
    conversationId: "chat-1",
    includeSensitiveData: false,
    ...overrides,
  };
}

describe("createCompositeRunRecorder", () => {
  it("calls recorder.onEvent synchronously and does NOT call exporter.onEvent on the hot path", () => {
    const { recorder, calls: recorderCalls } = makeFakeRecorder();
    const { exporter, calls: exporterCalls } = makeFakeExporter();
    const composite = createCompositeRunRecorder({
      recorder,
      exporter,
      context: makeContext(),
      timeoutMs: 1000,
    });

    composite.onEvent({ type: "assistant_message" });

    expect(recorderCalls).toEqual([{ method: "onEvent", arg: { type: "assistant_message" } }]);
    expect(exporterCalls.some((c) => c.method === "onEvent")).toBe(false);
  });

  it("calls recorder.finish FIRST and returns its summary even if exporter.finish throws", async () => {
    const finishSummary = makeSummary({ status: "succeeded", eventCount: 1 });
    const { recorder } = makeFakeRecorder({ finishSummary });
    const { exporter } = makeFakeExporter({ throwOn: "finish" });
    const warnings: Array<{ phase: string; message: string }> = [];
    const composite = createCompositeRunRecorder({
      recorder,
      exporter,
      context: makeContext(),
      timeoutMs: 1000,
      onWarning: (w) => warnings.push(w),
    });

    composite.onEvent({ type: "tool_call" });
    const summary = await composite.finish({});

    expect(summary).toBe(finishSummary);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.phase).toBe("finish");
  });

  it("never rejects when the exporter throws in start/finish/fail and surfaces the warning phase", async () => {
    const startThrows = makeFakeExporter({ throwOn: "start" });
    const r1 = makeFakeRecorder();
    const warnings: Array<{ phase: string; message: string }> = [];
    const composite = createCompositeRunRecorder({
      recorder: r1.recorder,
      exporter: startThrows.exporter,
      context: makeContext(),
      timeoutMs: 1000,
      onWarning: (w) => warnings.push(w),
    });

    await expect(composite.start?.()).resolves.toBeDefined();
    expect(warnings.some((w) => w.phase === "start")).toBe(true);
  });

  it("does not reject terminal commit when both the exporter and warning callback throw", async () => {
    const finishSummary = makeSummary({ status: "succeeded" });
    const { recorder } = makeFakeRecorder({ finishSummary });
    const { exporter } = makeFakeExporter({ throwOn: "finish" });
    const composite = createCompositeRunRecorder({
      recorder,
      exporter,
      context: makeContext(),
      timeoutMs: 1000,
      onWarning: () => { throw new Error("diagnostic sink failed"); },
    });

    await expect(composite.finish({})).resolves.toBe(finishSummary);
  });

  it("resolves a hanging exporter.finish within timeoutMs via injected clock and emits a timeout warning", async () => {
    const finishSummary = makeSummary({ status: "succeeded" });
    const { recorder } = makeFakeRecorder({ finishSummary });
    const { exporter } = makeFakeExporter({ hangOn: "finish" });
    const warnings: Array<{ phase: string; message: string }> = [];

    // Capture the timeout callback instead of using a real timer; fire it once
    // the composite has registered it (after microtasks flush).
    const pending: Array<() => void> = [];
    const setTimer = (fn: () => void): void => {
      pending.push(fn);
    };

    const composite = createCompositeRunRecorder({
      recorder,
      exporter,
      context: makeContext(),
      timeoutMs: 50,
      onWarning: (w) => warnings.push(w),
      setTimer,
    });

    composite.onEvent({ type: "tool_call" });
    const finishPromise = composite.finish({});

    // Let recorder.finish + replayEvents microtasks settle so withTimeout has
    // registered its timer, then fire the captured timeout callback.
    for (let i = 0; i < 10 && pending.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(pending).toHaveLength(1);
    pending[0]?.();

    const summary = await finishPromise;
    expect(summary).toBe(finishSummary);
    expect(warnings.some((w) => w.phase === "finish")).toBe(true);
  });

  it("replays buffered events to exporter.onEvent with monotonically increasing eventIndex", async () => {
    const { recorder } = makeFakeRecorder();
    const { exporter, calls } = makeFakeExporter();
    const composite = createCompositeRunRecorder({
      recorder,
      exporter,
      context: makeContext(),
      timeoutMs: 1000,
    });

    composite.onEvent({ type: "a" });
    composite.onEvent({ type: "b" });
    composite.onEvent({ type: "c" });
    await composite.finish({});

    const onEventCalls = calls.filter((c) => c.method === "onEvent");
    expect(onEventCalls.map((c) => c.event?.type)).toEqual(["a", "b", "c"]);
    expect(onEventCalls.map((c) => c.eventIndex)).toEqual([0, 1, 2]);
    expect(calls.find((c) => c.method === "finish")).toBeDefined();
  });

  it("keeps prepare non-terminal and exports late warnings before one idempotent terminal", async () => {
    const order: string[] = [];
    const summary = makeSummary({ eventCount: 1 });
    let innerTerminalCalls = 0;
    const recorder: RunRecorder = {
      onEvent(): void {},
      async prepareFinish(): Promise<void> { order.push("prepare"); },
      async commitFinish(): Promise<RunSummary> {
        innerTerminalCalls += 1;
        order.push("inner-terminal");
        return summary;
      },
      async finish(): Promise<RunSummary> { throw new Error("one-shot finish must not be used"); },
      async fail(): Promise<RunSummary> { return makeSummary({ status: "failed" }); },
    };
    const exporter: RunExporter = {
      onEvent(event): void { order.push(`event:${String(event.type)}`); },
      finish(): void { order.push("export-terminal"); },
    };
    const composite = createCompositeRunRecorder({ recorder, exporter, context: makeContext(), timeoutMs: 1000 });

    await composite.prepareFinish?.({});
    composite.onEvent({ type: "runtime_warning", warning_kind: "memory_persistence_degraded" });
    const first = await composite.commitFinish?.({});
    const second = await composite.commitFinish?.({});

    expect(first).toBe(summary);
    expect(second).toBe(summary);
    expect(innerTerminalCalls).toBe(1);
    expect(order).toEqual(["prepare", "inner-terminal", "event:runtime_warning", "export-terminal"]);
  });

  it("fail path returns recorder.fail summary unchanged and exports under best-effort", async () => {
    const failSummary = makeSummary({ status: "failed", failureKind: "boom" });
    const { recorder } = makeFakeRecorder({ failSummary });
    const { exporter, calls } = makeFakeExporter();
    const composite = createCompositeRunRecorder({
      recorder,
      exporter,
      context: makeContext(),
      timeoutMs: 1000,
    });

    composite.onEvent({ type: "x" });
    const summary = await composite.fail(new Error("kaboom"));

    expect(summary).toBe(failSummary);
    const failCall = calls.find((c) => c.method === "fail");
    expect(failCall?.summary).toBe(failSummary);
    expect((failCall?.error as Error).message).toBe("kaboom");
    expect(calls.filter((c) => c.method === "onEvent")).toHaveLength(1);
  });

  it("exports a CANCELLED run on the finish path and returns the recorder summary unchanged", async () => {
    // The harness early-cancel path calls recorder.finish on cancellation.
    const cancelledSummary = makeSummary({ status: "cancelled", eventCount: 1 });
    const { recorder } = makeFakeRecorder({ finishSummary: cancelledSummary });
    const { exporter, calls } = makeFakeExporter();
    const composite = createCompositeRunRecorder({
      recorder,
      exporter,
      context: makeContext(),
      timeoutMs: 1000,
    });

    composite.onEvent({ type: "user_message" });
    const summary = await composite.finish({ cancelled: true });

    expect(summary).toBe(cancelledSummary);
    const finishCall = calls.find((c) => c.method === "finish");
    expect(finishCall?.summary).toBe(cancelledSummary);
    expect(finishCall?.summary?.status).toBe("cancelled");
    // buffered events still replayed before finish
    expect(calls.filter((c) => c.method === "onEvent")).toHaveLength(1);
  });
});
