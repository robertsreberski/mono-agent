import { describe, expect, it, vi } from "vitest";

import {
  ChannelDeliveryError,
  ResilientMessageStream,
  type ChannelSendOutcome,
  type ChannelTransport,
  type MessageRef,
} from "../index.js";

interface RecordedPost {
  readonly op: "post";
  readonly text: string;
  readonly markdown: boolean;
}
interface RecordedEdit {
  readonly op: "edit";
  readonly ref: MessageRef;
  readonly text: string;
  readonly markdown: boolean;
}
interface RecordedDelete {
  readonly op: "delete";
  readonly ref: MessageRef;
}
type Recorded = RecordedPost | RecordedEdit | RecordedDelete;

/**
 * A scriptable in-memory transport. `failures` maps a 1-based call index (across
 * post + edit) to the outcome the transport should simulate by throwing.
 */
class FakeTransport implements ChannelTransport {
  readonly maxMessageChars: number;
  readonly calls: Recorded[] = [];
  activityCount = 0;
  private callCount = 0;
  private nextId = 0;
  private readonly failures: Map<number, ChannelSendOutcome>;
  private readonly renderMd: ((text: string) => string) | undefined;

  constructor(options?: {
    maxMessageChars?: number;
    failures?: Record<number, ChannelSendOutcome>;
    renderMarkdown?: (text: string) => string;
  }) {
    this.maxMessageChars = options?.maxMessageChars ?? 100;
    this.failures = new Map(
      Object.entries(options?.failures ?? {}).map(([k, v]) => [Number(k), v]),
    );
    this.renderMd = options?.renderMarkdown;
  }

  private maybeThrow(): void {
    this.callCount += 1;
    const outcome = this.failures.get(this.callCount);
    if (outcome !== undefined) {
      const error = new Error(`scripted:${outcome.kind}`) as Error & {
        outcome: ChannelSendOutcome;
      };
      error.outcome = outcome;
      throw error;
    }
  }

  async post(text: string, options: { markdown: boolean }): Promise<MessageRef> {
    this.maybeThrow();
    this.calls.push({ op: "post", text, markdown: options.markdown });
    this.nextId += 1;
    return { id: `m${this.nextId}` };
  }

  async edit(
    ref: MessageRef,
    text: string,
    options: { markdown: boolean },
  ): Promise<void> {
    this.maybeThrow();
    this.calls.push({ op: "edit", ref, text, markdown: options.markdown });
  }

  async delete(ref: MessageRef): Promise<void> {
    this.calls.push({ op: "delete", ref });
  }

  classifyError(error: unknown): ChannelSendOutcome {
    if (error && typeof error === "object" && "outcome" in error) {
      return (error as { outcome: ChannelSendOutcome }).outcome;
    }
    return { kind: "fatal" };
  }

  renderMarkdown(text: string): string {
    return this.renderMd ? this.renderMd(text) : text;
  }

  async indicateActivity(): Promise<void> {
    this.activityCount += 1;
  }
}

const noSleep = async (): Promise<void> => {};

function makeStream(
  transport: ChannelTransport,
  overrides?: Partial<{
    editDebounceMs: number;
    abortSignal: AbortSignal;
    sleep: (ms: number) => Promise<void>;
    maxSendRetries: number;
    initialStatusText: string;
    showHints: boolean;
    formatMarkdown: boolean;
    finalOnly: boolean;
  }>,
): ResilientMessageStream {
  return new ResilientMessageStream({
    transport,
    editDebounceMs: 0,
    sleep: noSleep,
    ...overrides,
  });
}

describe("ResilientMessageStream", () => {
  it("does not invoke hostile error accessors while logging activity failures", async () => {
    const messageGetter = vi.fn(() => { throw new Error("hostile message getter"); });
    const proxyDescriptorGetter = vi.fn(() => { throw new Error("hostile descriptor getter"); });
    const proxyPrototypeGetter = vi.fn(() => { throw new Error("hostile prototype getter"); });
    const hostileError = new Error("safe");
    Object.defineProperty(hostileError, "message", {
      configurable: true,
      get: messageGetter,
    });
    const transport = new FakeTransport();
    transport.indicateActivity = async () => { throw hostileError; };
    const debug = vi.fn();
    const stream = new ResilientMessageStream({
      transport,
      editDebounceMs: 0,
      sleep: noSleep,
      finalOnly: true,
      logger: { debug },
    });

    await stream.status("Thinking...");

    const proxyTransport = new FakeTransport();
    const proxyPrototype = new Proxy({}, {
      getOwnPropertyDescriptor: proxyDescriptorGetter,
      getPrototypeOf: proxyPrototypeGetter,
    });
    proxyTransport.indicateActivity = async () => {
      throw Object.create(proxyPrototype) as object;
    };
    const proxyStream = new ResilientMessageStream({
      transport: proxyTransport,
      editDebounceMs: 0,
      sleep: noSleep,
      finalOnly: true,
      logger: { debug },
    });
    await proxyStream.status("Still thinking...");

    expect(messageGetter).not.toHaveBeenCalled();
    expect(proxyDescriptorGetter).not.toHaveBeenCalled();
    expect(proxyPrototypeGetter).not.toHaveBeenCalled();
    expect(debug).toHaveBeenNthCalledWith(
      1,
      "Resilient stream activity indicator failed (ignored).",
      { error: "[Error details unavailable]" },
    );
    expect(debug).toHaveBeenNthCalledWith(
      2,
      "Resilient stream activity indicator failed (ignored).",
      { error: "[Error details unavailable]" },
    );
  });

  it("finalOnly mode: posts one tool status and replaces it with the final answer", async () => {
    const transport = new FakeTransport();
    const stream = new ResilientMessageStream({
      transport,
      editDebounceMs: 0,
      sleep: noSleep,
      finalOnly: true,
    });

    await stream.status("Thinking...");
    await stream.event({
      type: "tool_call_started",
      id: "t1",
      name: "WebSearch",
      arguments: { query: "release notes" },
    });
    await stream.append("the ");
    await stream.append("answer");

    expect(transport.calls).toEqual([
      { op: "post", text: "🌐 Searching the web for release notes", markdown: false },
    ]);
    expect(transport.activityCount).toBeGreaterThanOrEqual(1);

    await stream.finish();

    const posts = transport.calls.filter((c) => c.op === "post") as RecordedPost[];
    expect(posts).toHaveLength(1);
    expect(transport.calls[0]?.op).toBe("post");
    const edits = transport.calls.filter((c) => c.op === "edit") as RecordedEdit[];
    expect(edits).toHaveLength(1);
    expect(edits[0]?.text).toContain("the answer");
  });

  it("finalOnly mode: accumulates tool calls, dedupes adjacent repeats, and ignores hidden answer deltas", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    const search = {
      type: "tool_call_started" as const,
      name: "WebSearch",
      arguments: { query: "mono agent" },
    };
    await stream.event({ ...search, id: "t1" });
    await stream.append("hidden draft");
    await stream.event({ ...search, id: "t2" });
    await stream.event({
      type: "tool_call_started",
      id: "t3",
      name: "Bash",
      arguments: { command: "pnpm test" },
    });
    await stream.finish("final answer");

    expect(transport.calls.map((call) => call.op === "delete" ? "delete" : call.text)).toEqual([
      "🌐 Searching the web for mono agent",
      "🌐 Searching the web for mono agent (×2)",
      "🌐 Searching the web for mono agent (×2)\n🖥️ Running pnpm test",
      "final answer",
    ]);
    expect(transport.calls.map((call) => call.op === "delete" ? "" : call.text).join("\n"))
      .not.toContain("hidden draft");
  });

  it("finalOnly mode: keeps distinct argv commands on distinct ledger lines", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    const exec = (id: string, args: readonly string[]) => stream.event({
      type: "tool_call_started" as const,
      id,
      name: "Exec",
      arguments: { executable: "git", args },
    });

    await exec("t1", ["status", "--short"]);
    await exec("t2", ["diff", "--stat"]);
    await exec("t3", ["diff", "--stat"]);
    await stream.finish("done");

    // Only genuinely repeated calls collapse; the ledger never hides distinct work
    // behind a bare `🖥️ Running (×N)`.
    expect(transport.calls.map((call) => call.op === "delete" ? "delete" : call.text)).toEqual([
      "🖥️ Running git status --short",
      "🖥️ Running git status --short\n🖥️ Running git diff --stat",
      "🖥️ Running git status --short\n🖥️ Running git diff --stat (×2)",
      "done",
    ]);
  });

  it("finalOnly mode: relocates the cumulative ledger after applied live guidance", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    await stream.event({
      type: "tool_call_started",
      id: "t1",
      name: "Read",
      arguments: { path: "/repo/a.ts" },
    });
    await stream.event({
      type: "tool_call_started",
      id: "live-input:follow-up-1",
      name: "↪️ Steered: “Use the API instead”",
      metadata: { liveInput: true, synthetic: true },
    });

    expect(transport.calls).toEqual([
      { op: "post", text: "📖 Reading /repo/a.ts", markdown: false },
      { op: "delete", ref: { id: "m1" } },
      {
        op: "post",
        text: "📖 Reading /repo/a.ts\n↪️ Steered: “Use the API instead”",
        markdown: false,
      },
    ]);
  });

  it("finalOnly mode: edits the existing ledger when relocation deletion fails", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const debug = vi.fn();
    transport.delete = async (ref: MessageRef) => {
      transport.calls.push({ op: "delete", ref });
      throw new Error("delete failed");
    };
    const stream = new ResilientMessageStream({
      transport,
      editDebounceMs: 0,
      sleep: noSleep,
      finalOnly: true,
      showHints: true,
      logger: { debug },
    });

    await stream.event({ type: "tool_call_started", id: "t1", name: "Read", arguments: { path: "a.ts" } });
    await stream.event({
      type: "tool_call_started",
      id: "live-input:follow-up-1",
      name: "↪️ Steered: “Keep the current approach”",
      metadata: { liveInput: true, synthetic: true },
    });
    await stream.finish("final answer");

    expect(transport.calls.slice(0, 3)).toEqual([
      { op: "post", text: "📖 Reading a.ts", markdown: false },
      { op: "delete", ref: { id: "m1" } },
      {
        op: "edit",
        ref: { id: "m1" },
        text: "📖 Reading a.ts\n↪️ Steered: “Keep the current approach”",
        markdown: false,
      },
    ]);
    expect(debug).toHaveBeenCalledWith(
      "Resilient stream live-input activity relocation failed (editing in place).",
      { error: "delete failed" },
    );
  });

  it("streaming mode uses the explicit steering label instead of a generic tool hint", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: false, showHints: true });

    await stream.event({
      type: "tool_call_started",
      id: "live-input:follow-up-1",
      name: "↪️ Steered: “Focus on tests”",
      metadata: { liveInput: true, synthetic: true },
    });

    expect(transport.calls).toEqual([
      { op: "post", text: "↪️ Steered: “Focus on tests”", markdown: false },
    ]);
  });

  it("finalOnly mode: showHints false preserves the previous answer-only behavior", async () => {
    const transport = new FakeTransport();
    const stream = makeStream(transport, { finalOnly: true, showHints: false });

    await stream.event({ type: "tool_call_started", id: "t1", name: "WebSearch" });
    expect(transport.calls).toHaveLength(0);
    await stream.finish("answer only");
    expect(transport.calls).toEqual([
      { op: "post", text: "answer only", markdown: true },
    ]);
  });

  it("dismisses only a confirmed transient status and is idempotent", async () => {
    const transport = new FakeTransport();
    const stream = makeStream(transport, { finalOnly: true });

    await stream.event({ type: "tool_call_started", id: "t1", name: "Read", arguments: { path: "/repo/a.ts" } });
    await stream.dismissTransient();
    await stream.dismissTransient();
    await stream.finish("must not land");

    expect(transport.calls).toEqual([
      { op: "post", text: "📖 Reading /repo/a.ts", markdown: false },
      { op: "delete", ref: { id: "m1" } },
    ]);
  });

  it("never deletes a message after an answer delivery was attempted", async () => {
    const transport = new FakeTransport();
    const stream = makeStream(transport, { finalOnly: false });

    await stream.replace("answer");
    await stream.finish("answer");
    await stream.dismissTransient();

    expect(transport.calls.some((call) => call.op === "delete")).toBe(false);
    expect((transport.calls.filter((call) => call.op === "edit") as RecordedEdit[]).at(-1)?.text)
      .toBe("answer");
  });

  it("finalOnly mode: retries a transient first-post failure and still delivers the answer", async () => {
    // The first transport call (the final post) fails retryably; delivery must
    // recover instead of dropping the answer (the stream is finalOnly, so this is
    // the only send).
    const transport = new FakeTransport({ failures: { 1: { kind: "retry" } } });
    const stream = new ResilientMessageStream({
      transport,
      editDebounceMs: 0,
      sleep: noSleep,
      finalOnly: true,
    });

    await stream.append("the answer");
    await expect(stream.finish()).resolves.toBeUndefined();

    const posts = transport.calls.filter((c) => c.op === "post") as RecordedPost[];
    expect(posts).toHaveLength(1); // the retry succeeded
    expect(posts[0]?.text).toContain("the answer");
  });

  it("finalOnly mode: falls back to plain text when the markdown first-post is rejected", async () => {
    const transport = new FakeTransport({
      failures: { 1: { kind: "reformat_plain" } },
      renderMarkdown: (text) => `MD(${text})`,
    });
    const stream = new ResilientMessageStream({
      transport,
      editDebounceMs: 0,
      sleep: noSleep,
      finalOnly: true,
    });

    await stream.append("the answer");
    await stream.finish();

    const posts = transport.calls.filter((c) => c.op === "post") as RecordedPost[];
    expect(posts).toHaveLength(1);
    expect(posts[0]?.markdown).toBe(false); // fell back to plain
    expect(posts[0]?.text).toBe("the answer"); // not MD(the answer)
  });

  it.each([
    ["permanent", { kind: "fatal", failureCertainty: "not_delivered" } as const],
    ["retryable", { kind: "retry", failureCertainty: "not_delivered" } as const],
    ["unknown", { kind: "retry", failureCertainty: "unknown" } as const],
  ])("preserves a %s exhausted-delivery disposition", async (disposition, failure) => {
    const transport = new FakeTransport({ failures: { 1: failure, 2: failure } });
    const stream = new ResilientMessageStream({
      transport,
      finalOnly: true,
      maxSendRetries: 0,
      sleep: noSleep,
    });

    await expect(stream.finish("undelivered answer")).rejects.toMatchObject({ disposition });
  });

  it("does not post anything until the first write (lazy first send)", async () => {
    const transport = new FakeTransport();
    const stream = makeStream(transport);
    expect(transport.calls).toHaveLength(0);

    await stream.append("hello");
    expect(transport.calls.some((c) => c.op === "post")).toBe(true);
  });

  it("posts the initial status text on first send, then edits with answer", async () => {
    const transport = new FakeTransport();
    const stream = makeStream(transport, { initialStatusText: "Thinking..." });

    await stream.append("answer text");
    const post = transport.calls.find((c) => c.op === "post") as RecordedPost;
    expect(post.text).toBe("Thinking...");
    const edit = transport.calls.find((c) => c.op === "edit") as RecordedEdit;
    expect(edit.text).toContain("answer text");
  });

  it("debounces interim edits", async () => {
    const transport = new FakeTransport();
    const stream = new ResilientMessageStream({
      transport,
      editDebounceMs: 1000,
      sleep: noSleep,
    });

    await stream.append("a");
    await stream.append("b");
    await stream.append("c");
    // Debounced: the message exists (post) but no interim edit has flushed yet.
    expect(transport.calls.filter((c) => c.op === "edit")).toHaveLength(0);

    await stream.finish();
    const edits = transport.calls.filter((c) => c.op === "edit") as RecordedEdit[];
    expect(edits.at(-1)?.text).toContain("abc");
  });

  it("retries a failed final delivery then succeeds", async () => {
    // First send is the post; edit during append is call 2; final edit is call 3.
    const transport = new FakeTransport({
      failures: { 3: { kind: "retry", retryAfterMs: 10 } },
    });
    const stream = makeStream(transport);

    await stream.replace("final answer");
    await stream.finish();

    const edits = transport.calls.filter((c) => c.op === "edit") as RecordedEdit[];
    expect(edits.at(-1)?.text).toContain("final answer");
  });

  it("recreates (posts a new message) when the edit target is gone", async () => {
    // Post=1, interim edit=2, final edit=3 -> recreate -> post=4.
    const transport = new FakeTransport({
      failures: { 3: { kind: "recreate" } },
    });
    const stream = makeStream(transport);

    await stream.replace("recovered");
    await stream.finish();

    const posts = transport.calls.filter((c) => c.op === "post") as RecordedPost[];
    expect(posts).toHaveLength(2);
    expect(posts.at(-1)?.text).toContain("recovered");
  });

  it("after an interim-edit recreate, the next send posts a fresh message (not the stale deleted ref)", async () => {
    // Post=1 (m1), interim edit=2 -> recreate (interim has a single attempt, so
    // the post branch does not run this pass). The next write must post a NEW
    // message rather than reviving the deleted m1 via a stale sendMessagePromise.
    const transport = new FakeTransport({ failures: { 2: { kind: "recreate" } } });
    const stream = makeStream(transport, { initialStatusText: "..." });

    await stream.append("first");
    await stream.append("second");

    const posts = transport.calls.filter((c) => c.op === "post") as RecordedPost[];
    const edits = transport.calls.filter((c) => c.op === "edit") as RecordedEdit[];
    // A fresh message (m2) was posted after the recreate.
    expect(posts.length).toBeGreaterThanOrEqual(2);
    // No edit ever targets the stale, deleted m1.
    for (const edit of edits) {
      expect(edit.ref.id).not.toBe("m1");
    }
  });

  it("falls back to plain text when markdown cannot be parsed", async () => {
    // Final delivery uses markdown; reformat_plain forces a plain retry.
    const transport = new FakeTransport({
      renderMarkdown: (t) => `*${t}*`,
      failures: { 3: { kind: "reformat_plain" } },
    });
    const stream = makeStream(transport, { formatMarkdown: true });

    await stream.replace("bold answer");
    await stream.finish();

    const edits = transport.calls.filter((c) => c.op === "edit") as RecordedEdit[];
    const finalEdit = edits.at(-1) as RecordedEdit;
    expect(finalEdit.markdown).toBe(false);
    expect(finalEdit.text).toBe("bold answer");
  });

  it("treats not_modified as success", async () => {
    const transport = new FakeTransport({
      failures: { 3: { kind: "not_modified" } },
    });
    const stream = makeStream(transport);

    await stream.replace("same");
    // Should not throw.
    await expect(stream.finish()).resolves.toBeUndefined();
  });

  it("chunks overflow text into continuation posts", async () => {
    const transport = new FakeTransport({ maxMessageChars: 40 });
    const stream = makeStream(transport);
    const long = "x".repeat(95);

    await stream.replace(long);
    await stream.finish();

    // First chunk lands on the streamed message (edit); remaining chunks are posts.
    const overflowPosts = (transport.calls.filter((c) => c.op === "post") as RecordedPost[]).filter(
      (p) => p.text.includes("x"),
    );
    expect(overflowPosts.length).toBeGreaterThanOrEqual(2);
  });

  it("fails final delivery when an overflow chunk cannot be posted", async () => {
    const transport = new FakeTransport({
      maxMessageChars: 32,
      failures: { 2: { kind: "fatal" } },
    });
    const stream = new ResilientMessageStream({
      transport,
      finalOnly: true,
      maxSendRetries: 0,
      sleep: noSleep,
    });

    await expect(stream.finish("x".repeat(70))).rejects.toBeInstanceOf(ChannelDeliveryError);
    expect(transport.calls).toEqual([
      { op: "post", text: "x".repeat(32), markdown: true },
    ]);
  });

  it("stops retrying once aborted", async () => {
    const controller = new AbortController();
    let sleepCalls = 0;
    const transport = new FakeTransport({
      failures: {
        3: { kind: "retry", retryAfterMs: 10 },
        4: { kind: "retry", retryAfterMs: 10 },
        5: { kind: "retry", retryAfterMs: 10 },
        6: { kind: "retry", retryAfterMs: 10 },
      },
    });
    const stream = makeStream(transport, {
      abortSignal: controller.signal,
      sleep: async () => {
        sleepCalls += 1;
        controller.abort();
      },
    });

    await stream.replace("never lands");
    await stream.finish();
    // After the abort fires during the first retry wait, no further retries run.
    expect(sleepCalls).toBe(1);
  });

  it("is idempotent on finish (no double delivery)", async () => {
    const transport = new FakeTransport();
    const stream = makeStream(transport);

    await stream.replace("once");
    await stream.finish();
    const afterFirst = transport.calls.length;
    await stream.finish();
    expect(transport.calls.length).toBe(afterFirst);
  });

  it("renders a tool activity hint while there is no answer text yet", async () => {
    const transport = new FakeTransport();
    const stream = makeStream(transport, { showHints: true });

    // No message exists yet, so the hint lands as the first post's status text.
    await stream.event?.({ type: "tool_call_started", id: "1", name: "websearch" });
    const rendered = transport.calls
      .map((call) => call.op === "delete" ? "" : call.text)
      .join("\n");
    expect(rendered).toContain("Searching the web");
  });

  it("does not render reasoning (assistant_thought) as prose", async () => {
    const transport = new FakeTransport();
    const stream = makeStream(transport);

    await stream.event?.({ type: "assistant_thought", text: "secret reasoning" });
    const everySeen = transport.calls
      .map((call) => call.op === "delete" ? "" : call.text)
      .join("\n");
    expect(everySeen).not.toContain("secret reasoning");
  });

  it("does not let a tool hint clobber answer text once it has arrived", async () => {
    const transport = new FakeTransport();
    const stream = makeStream(transport, { showHints: true });

    await stream.append("the answer");
    await stream.event?.({ type: "tool_call_started", id: "1", name: "websearch" });
    await stream.finish();

    const lastEdit = (transport.calls.filter((c) => c.op === "edit") as RecordedEdit[]).at(-1);
    expect(lastEdit?.text).toContain("the answer");
    expect(lastEdit?.text).not.toContain("Searching the web");
  });
});

/** The events one subagent produces, in the order the runtime emits them. */
const launch = (id: string, name: string) => ({
  type: "tool_call_started" as const,
  id,
  name: "Agent",
  arguments: { name, prompt: "do the thing", description: "a task" },
});
const bookend = (id: string, name: string) => ({
  type: "tool_call_started" as const,
  id: `agent:${id}`,
  name: `Agent(${name})`,
  arguments: { name },
  metadata: { subagent: { id, name, callIndex: 0 }, synthetic: true, subagentLifecycle: true },
});
const childCall = (id: string, name: string, toolId: string, tool: string, args: unknown) => ({
  type: "tool_call_started" as const,
  id: `agent:${id}:${toolId}`,
  name: `${name}▸${tool}`,
  arguments: args,
  metadata: { subagent: { id, name, callIndex: 0 }, synthetic: true },
});

const lastLedger = (transport: FakeTransport): string => {
  const writes = transport.calls.filter(
    (call): call is RecordedPost | RecordedEdit => call.op !== "delete",
  );
  return writes.at(-1)?.text ?? "";
};

describe("ResilientMessageStream subagent activity", () => {
  it("nests a subagent's tool calls under one header", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    await stream.event(launch("call-1", "researcher"));
    await stream.event(bookend("call-1", "researcher"));
    await stream.event(childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/foo.ts" }));
    await stream.event(childCall("call-1", "researcher", "t2", "Grep", { pattern: "createTool" }));

    expect(lastLedger(transport)).toBe(
      [
        '🤖 Starting agent "researcher"',
        "  ↳ 📖 Reading /repo/foo.ts",
        '  ↳ 🔎 Searching files for createTool',
      ].join("\n"),
    );
  });

  it("keeps concurrent subagents in their own groups as their events interleave", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    await stream.event(launch("a", "researcher"));
    await stream.event(launch("b", "reviewer"));
    // Interleaved on purpose: chronological appending would shuffle both agents'
    // work into one list, which is exactly what grouping exists to prevent.
    await stream.event(childCall("a", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }));
    await stream.event(childCall("b", "reviewer", "t2", "Read", { file_path: "/repo/b.ts" }));
    await stream.event(childCall("a", "researcher", "t3", "Read", { file_path: "/repo/c.ts" }));

    expect(lastLedger(transport)).toBe(
      [
        '🤖 Starting agent "researcher"',
        "  ↳ 📖 Reading /repo/a.ts",
        "  ↳ 📖 Reading /repo/c.ts",
        '🤖 Starting agent "reviewer"',
        "  ↳ 📖 Reading /repo/b.ts",
      ].join("\n"),
    );
  });

  it("collapses repeats within a group without merging two agents' work", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    await stream.event(launch("a", "researcher"));
    await stream.event(launch("b", "researcher"));
    await stream.event(childCall("a", "researcher", "t1", "Grep", { pattern: "x" }));
    await stream.event(childCall("a", "researcher", "t2", "Grep", { pattern: "x" }));
    await stream.event(childCall("b", "researcher", "t3", "Grep", { pattern: "x" }));

    // Two launches of the SAME profile stay two headers: identical rendered text
    // must not collapse them, or the attribution of each child is lost.
    expect(lastLedger(transport)).toBe(
      [
        '🤖 Starting agent "researcher"',
        "  ↳ 🔎 Searching files for x (×2)",
        '🤖 Starting agent "researcher"',
        "  ↳ 🔎 Searching files for x",
      ].join("\n"),
    );
  });

  it("settles the header when the subagent finishes", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    await stream.event(launch("call-1", "researcher"));
    await stream.event(childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }));
    await stream.event({
      type: "tool_call_completed",
      id: "agent:call-1",
      name: "Agent(researcher)",
      executionMs: 12_400,
      metadata: { subagent: { id: "call-1", name: "researcher" }, synthetic: true, subagentLifecycle: true },
    });

    expect(lastLedger(transport)).toBe(
      ['🤖 Agent "researcher" · 1 tool call · 12.4s', "  ↳ 📖 Reading /repo/a.ts"].join("\n"),
    );
  });

  it("marks a failed subagent in its header", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    await stream.event(launch("call-1", "researcher"));
    await stream.event({
      type: "tool_call_completed",
      id: "call-1",
      name: "Agent",
      isError: true,
      executionMs: 800,
    });

    expect(lastLedger(transport)).toBe('⚠️ Agent "researcher" · 0 tool calls · 800ms');
  });

  it("settles a launch the runtime rejected before the subagent existed", async () => {
    // A call whose arguments fail schema validation never reaches the runtime,
    // so no lifecycle bookend arrives and no child activity ever nests. The
    // parent tool completion is the only signal there is; without settling on
    // it the header sits at "Starting agent" forever and a launch that never
    // happened reads as one still running.
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    await stream.event(launch("Agent_11", "tracks-vigilante-timeline"));
    expect(lastLedger(transport)).toBe('🤖 Starting agent "tracks-vigilante-timeline"');

    // Exactly what the responder maps a rejected tool_result to: no arguments,
    // no subagent metadata, no lifecycle flag.
    await stream.event({
      type: "tool_call_completed",
      id: "Agent_11",
      name: "Agent",
      content: 'Validation failed for tool "Agent":\n  - root: must not have additional properties',
      isError: true,
      executionMs: 5,
    });

    expect(lastLedger(transport)).toBe('⚠️ Agent "tracks-vigilante-timeline" · 0 tool calls · 5ms');
  });

  it("opens a group from child activity alone when the launch was never observed", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    await stream.event(childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }));

    expect(lastLedger(transport)).toBe(
      ['🤖 Starting agent "researcher"', "  ↳ 📖 Reading /repo/a.ts"].join("\n"),
    );
  });

  it("renders a flat line when subagent metadata is malformed", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    await stream.event({
      type: "tool_call_started",
      id: "t1",
      name: "Read",
      arguments: { file_path: "/repo/a.ts" },
      // `metadata` is an open record arriving over the operator wire: a
      // non-string id must degrade, never key a group.
      metadata: { subagent: { id: 42, name: "researcher" }, synthetic: true },
    });

    expect(lastLedger(transport)).toBe("📖 Reading /repo/a.ts");
  });

  it("keeps the agent's own activity flat alongside a subagent group", async () => {
    const transport = new FakeTransport({ maxMessageChars: 500 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    await stream.event({
      type: "tool_call_started",
      id: "own",
      name: "WebSearch",
      arguments: { query: "pi agent core" },
    });
    await stream.event(launch("call-1", "researcher"));
    await stream.event(childCall("call-1", "researcher", "t1", "Read", { file_path: "/repo/a.ts" }));

    expect(lastLedger(transport)).toBe(
      [
        '🌐 Searching the web for pi agent core',
        '🤖 Starting agent "researcher"',
        "  ↳ 📖 Reading /repo/a.ts",
      ].join("\n"),
    );
  });

  it("bounds the ledger by evicting the oldest lines, header included", async () => {
    const transport = new FakeTransport({ maxMessageChars: 100_000 });
    const stream = makeStream(transport, { finalOnly: true, showHints: true });

    await stream.event(launch("a", "noisy"));
    for (let index = 0; index < 600; index += 1) {
      await stream.event(childCall("a", "noisy", `t${index}`, "Read", { file_path: `/repo/f${index}.ts` }));
    }

    const lines = lastLedger(transport).split("\n");
    expect(lines).toHaveLength(512);
    // The group shed its own oldest children first, so the header survived and
    // the newest work is what remains visible.
    expect(lines[0]).toBe('🤖 Starting agent "noisy"');
    expect(lines.at(-1)).toBe("  ↳ 📖 Reading /repo/f599.ts");
  });
});
