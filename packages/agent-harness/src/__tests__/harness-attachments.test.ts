import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { createAgentHarness } from "../index.js";

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
});
