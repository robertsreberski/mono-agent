import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/memory-store";
import type { HistoryMessage } from "@mono-agent/context";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { createAgentHarness } from "../index.js";
import type { ConversationHistoryStore } from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-att-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

async function attachmentsDirFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-attdir-"));
  tempDirs.push(dir);
  return dir;
}

function createCapturingRuntime() {
  const calls: { prompt: string; options: RuntimeRunOptions }[] = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return { text: "ok" };
      },
      async disposeSession(): Promise<boolean> {
        return true;
      },
      async disposeAllSessions(): Promise<void> {},
    },
  };
}

function userContent(call: { options: RuntimeRunOptions }): string {
  const messages = call.options.messages as Array<{ role: string; content: unknown }> | undefined;
  return typeof messages?.[0]?.content === "string" ? (messages[0].content as string) : "";
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
  const hostSummaries: string[] = [];
  const captures: string[] = [];
  const store: MemoryStore = {
    async load(): Promise<MemoryBlock | undefined> {
      return undefined;
    },
    async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
      hostSummaries.push(summary);
      return { conversationId, source: "spy", bytesWritten: summary.length };
    },
    scheduleCapture(_conversationId: string, text: string): void {
      captures.push(text);
    },
  };
  return { hostSummaries, captures, store };
}

describe("AgentHarness attachments", () => {
  it("persists an image attachment to attachmentsDir and references its saved path in the message", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", attachmentsDir });

    const bytes = Buffer.from("\x89PNG\r\n fake image bytes");
    await harness.run({
      conversationId: "c1",
      userMessage: "what is in this image?",
      abortSignal: new AbortController().signal,
      attachments: [{ kind: "image", mimeType: "image/png", data: bytes.toString("base64"), name: "photo.png", sizeBytes: bytes.length }],
    });

    const files = await readdir(attachmentsDir);
    expect(files).toHaveLength(1);
    // The saved bytes round-trip.
    const saved = await readFile(join(attachmentsDir, files[0] as string));
    expect(saved.equals(bytes)).toBe(true);

    const content = userContent(fake.calls[0] as { options: RuntimeRunOptions });
    expect(content).toContain("what is in this image?"); // original preserved
    expect(content).toContain(attachmentsDir); // saved path referenced
    expect(content).toContain("image/png");
  });

  it("inlines extracted document text alongside the saved-path reference", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", attachmentsDir });

    await harness.run({
      conversationId: "c1",
      userMessage: "summarize",
      abortSignal: new AbortController().signal,
      attachments: [{ kind: "document", mimeType: "text/plain", data: Buffer.from("HELLO-DOC-BODY").toString("base64"), name: "note.txt", text: "HELLO-DOC-BODY" }],
    });

    const content = userContent(fake.calls[0] as { options: RuntimeRunOptions });
    expect(content).toContain("summarize");
    expect(content).toContain("HELLO-DOC-BODY"); // extracted text inlined
  });

  it("leaves the message unchanged when there are no attachments", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", attachmentsDir });

    await harness.run({ conversationId: "c1", userMessage: "plain message", abortSignal: new AbortController().signal });

    expect(userContent(fake.calls[0] as { options: RuntimeRunOptions })).toContain("plain message");
    expect(await readdir(attachmentsDir)).toHaveLength(0);
  });

  it("sanitizes a path-traversal runId so attachments cannot escape attachmentsDir", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      attachmentsDir,
      createRunId: () => "../../etc/evil",
    });

    const bytes = Buffer.from("data");
    await harness.run({
      conversationId: "c1",
      userMessage: "hi",
      abortSignal: new AbortController().signal,
      attachments: [{ kind: "document", mimeType: "text/plain", data: bytes.toString("base64"), name: "n.txt" }],
    });

    // Exactly one file, written as a direct child of attachmentsDir (readdir on
    // attachmentsDir proves it did not escape), with no path separators or
    // leading dots in its name (so no traversal / hidden-file escape).
    const files = await readdir(attachmentsDir);
    expect(files).toHaveLength(1);
    const name = files[0] as string;
    expect(name.includes("/")).toBe(false);
    expect(name.includes("\\")).toBe(false);
    expect(name.startsWith(".")).toBe(false);
  });

  it("emits a provider_bridge_latency event around the provider call", async () => {
    const identityPath = await identityFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk" });

    const events: Array<{ type?: string; durationMs?: number }> = [];
    await harness.run({
      conversationId: "c1",
      userMessage: "hi",
      abortSignal: new AbortController().signal,
      onEvent: (event) => events.push(event as { type?: string; durationMs?: number }),
    });

    const latency = events.find((event) => event.type === "provider_bridge_latency");
    expect(latency).toBeDefined();
    expect(typeof latency?.durationMs).toBe("number");
    expect(latency?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes piSessionsRoot through to the runtime when configured", async () => {
    const identityPath = await identityFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      piSessionsRoot: "/tmp/pi-sessions",
    });

    await harness.run({ conversationId: "c1", userMessage: "hi", abortSignal: new AbortController().signal });

    expect((fake.calls[0]?.options as { piSessionsRoot?: string }).piSessionsRoot).toBe("/tmp/pi-sessions");
  });

  it("accepts an attachment-only request (empty userMessage) and synthesizes a prompt", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", attachmentsDir });

    const response = await harness.run({
      conversationId: "c1",
      userMessage: "", // file upload with no caption (e.g. a Slack file_share)
      abortSignal: new AbortController().signal,
      attachments: [{ kind: "image", mimeType: "image/png", data: Buffer.from("img").toString("base64"), name: "shot.png" }],
    });

    // The empty-text request is NOT rejected; the runtime runs with a synthesized
    // prompt that references the attachment.
    expect(response.failure).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(userContent(fake.calls[0] as { options: RuntimeRunOptions })).toContain("shot.png");
  });

  it("runs requestExtension.cleanup even when concurrency admission is aborted while queued", async () => {
    const identityPath = await identityFixture();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let runCount = 0;
    const runtime = {
      async run(): Promise<RuntimeResult> {
        runCount += 1;
        if (runCount === 1) {
          markFirstStarted();
          await firstGate; // hold the only concurrency slot
        }
        return { text: "ok" };
      },
      async disposeSession(): Promise<boolean> { return true; },
      async disposeAllSessions(): Promise<void> {},
    };
    const cleanups: string[] = [];
    const harness = createAgentHarness({
      identityPath,
      runtime,
      model,
      executionMode: "sdk",
      concurrency: { maxConcurrentRuns: 1 },
      runtimeOptionsForRequest: ({ request }) => ({
        cleanup: async () => { cleanups.push(request.conversationId); },
      }),
    });

    // First run takes the only slot and blocks inside runtime.run.
    const first = harness.run({ conversationId: "c1", userMessage: "first", abortSignal: new AbortController().signal });
    await firstStarted;

    // Second run queues for admission, then is aborted before it can acquire.
    const secondAbort = new AbortController();
    const second = harness.run({ conversationId: "c2", userMessage: "second", abortSignal: secondAbort.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    secondAbort.abort(new Error("cancelled"));
    const secondResult = await second;

    // It never ran the provider, but its request-scoped cleanup still fired.
    expect(secondResult.failure?.kind).toBe("cancelled");
    expect(cleanups).toContain("c2");

    releaseFirst();
    await first;
  });

  it("persists the original caption + redacted metadata to history/memory, never the extracted document body (F8)", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const history = createSpyHistoryStore();
    const memory = createSpyMemoryStore();
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      attachmentsDir,
      historyStore: history.store,
      memory: memory.store,
      memoryWriteMode: "capture",
    });

    const SECRET = "SECRET-DOC-BODY";
    const CAPTION = "summarize this for me";
    await harness.run({
      conversationId: "c1",
      userMessage: CAPTION,
      abortSignal: new AbortController().signal,
      attachments: [{
        kind: "document",
        mimeType: "text/plain",
        data: Buffer.from(SECRET).toString("base64"),
        name: "secret.txt",
        text: SECRET,
        sizeBytes: SECRET.length,
      }],
    });

    // (a) The PROVIDER call still receives the expanded prompt with the extracted
    // body and the saved-path reference — the current turn is unchanged.
    const prompt = userContent(fake.calls[0] as { options: RuntimeRunOptions });
    expect(prompt).toContain(CAPTION);
    expect(prompt).toContain(SECRET);
    expect(prompt).toContain(attachmentsDir);

    // (b) The persisted history user message keeps the original caption +
    // redacted metadata (path/type/size/name) but NOT the extracted body.
    const persistedUser = history.appended.find((message) => message.role === "user");
    expect(persistedUser).toBeDefined();
    const persistedText = persistedUser?.content ?? "";
    expect(persistedText).toContain(CAPTION);
    expect(persistedText).not.toContain(SECRET);
    expect(persistedText).not.toContain("--- extracted text ---");
    // Redacted metadata IS retained so a follow-up can re-open the file.
    expect(persistedText).toContain(attachmentsDir);
    expect(persistedText).toContain("secret.txt");

    // (c) The intelligent-capture payload must not carry the extracted body.
    expect(memory.captures).toHaveLength(1);
    expect(memory.captures[0]).not.toContain(SECRET);
    expect(memory.captures[0]).toContain(CAPTION);

    // (d) The deterministic host summary must not carry the extracted body.
    expect(memory.hostSummaries).toHaveLength(1);
    expect(memory.hostSummaries[0]).not.toContain(SECRET);
  });
});
