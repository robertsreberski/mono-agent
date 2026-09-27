import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentHarness, createAgentResponder } from "@mono-agent/agent-harness";
import type { MemoryLoadOptions } from "@mono-agent/agent-contracts";
import { startTuiAdapter } from "@mono-agent/operator-adapter";
import { OperatorClient } from "@mono-agent/web";
import { expect, it } from "vitest";

import { MemoryRetrievalService, type SharedRecallStore } from "../memory-retrieval.js";
import { bindProcessJobWakeContextToResponder, runWithProcessJobWakeContext } from "../process-jobs-context.js";

it("suppresses only the exact host wake through web operator ingress, not the human queued behind it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recall-operator-test-"));
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are a fictional assistant.");
  const hit = { score: 0.95, record: { id: "tea", text: "Morgan likes tea.", type: "note" as const,
    status: "open" as const } };
  const service = new MemoryRetrievalService({ load: async () => undefined, recall: async () => [hit],
    close: async () => undefined } as SharedRecallStore);
  const reads: Array<{ query: string; owner: boolean; block: boolean }> = [];
  const memory = {
    load: async (conversationId: string, query?: string, options?: MemoryLoadOptions) => {
      const block = await service.load(conversationId, query, options);
      reads.push({ query: query ?? "", owner: options?.ownerTurn === true, block: block !== undefined });
      return block;
    },
    releaseTurn: (id: string) => service.releaseTurn(id),
  };
  let started!: () => void;
  const wakeStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const wakeGate = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  const harness = createAgentHarness({ identityPath, memory, cwd: dir,
    model: { provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" },
    runtime: { run: async () => {
      if (++runs === 1) { started(); await wakeGate; }
      return { text: "Noted." };
    } },
  });
  const adapter = await startTuiAdapter({ responder: bindProcessJobWakeContextToResponder(createAgentResponder({ harness })) });
  try {
    let accepted!: () => void;
    const humanAccepted = new Promise<void>((resolve) => { accepted = resolve; });
    const client = new OperatorClient({ baseUrl: adapter.baseUrl, fetchImpl: async (input, init) => {
      const response = await fetch(input, init);
      if (typeof init?.body === "string" && JSON.parse(init.body).text === "Morgan likes tea too") accepted();
      return response;
    } });
    const key = "process-job:fictional-terminal-wake";
    const turn = (text: string, turnId: string, processJobWakeDeliveryKey?: string) => client.turn({
      conversationId: "web:fictional-thread", text, attachments: [], signal: new AbortController().signal,
      metadata: { web: { threadId: "fictional-thread", turnId } },
      ...(processJobWakeDeliveryKey === undefined ? {} : { processJobWakeDeliveryKey }),
      onFrame: () => undefined,
    });
    const wake = runWithProcessJobWakeContext({ jobId: "fictional-job", chainDepth: 1 },
      () => turn("Morgan likes tea", "wake", key), key);
    await wakeStarted;
    const human = turn("Morgan likes tea too", "human");
    await humanAccepted; // The operator accepted this request while the wake's provider run is still held.
    expect(runs).toBe(1);
    release();
    await Promise.all([wake, human]);
    expect(reads).toEqual([
      { query: "Morgan likes tea", owner: true, block: false },
      { query: "Morgan likes tea too", owner: true, block: true },
    ]);
    expect(runs).toBe(2);
  } finally {
    release();
    await adapter.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
