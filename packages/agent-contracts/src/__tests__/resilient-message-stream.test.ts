import { describe, expect, it } from "vitest";

import {
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
type Recorded = RecordedPost | RecordedEdit;

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
  it("finalOnly mode: no interim posts/edits, indicates activity, posts the final answer once", async () => {
    const transport = new FakeTransport();
    const stream = new ResilientMessageStream({
      transport,
      editDebounceMs: 0,
      sleep: noSleep,
      finalOnly: true,
    });

    await stream.status("Thinking...");
    await stream.event({ type: "tool_call_started", id: "t1", name: "WebSearch" });
    await stream.append("the ");
    await stream.append("answer");

    // Nothing is posted or edited while the agent works.
    expect(transport.calls).toHaveLength(0);
    // A working affordance (typing/seen) was surfaced instead.
    expect(transport.activityCount).toBeGreaterThanOrEqual(1);

    await stream.finish();

    // The answer is delivered as a single post (no interim edits at all).
    const posts = transport.calls.filter((c) => c.op === "post") as RecordedPost[];
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("the answer");
    expect(transport.calls[0]?.op).toBe("post");
    expect(transport.calls.filter((c) => c.op === "edit")).toHaveLength(0);
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
    const rendered = transport.calls.map((c) => c.text).join("\n");
    expect(rendered).toContain("Searching the web");
  });

  it("does not render reasoning (assistant_thought) as prose", async () => {
    const transport = new FakeTransport();
    const stream = makeStream(transport);

    await stream.event?.({ type: "assistant_thought", text: "secret reasoning" });
    const everySeen = transport.calls.map((c) => c.text).join("\n");
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
