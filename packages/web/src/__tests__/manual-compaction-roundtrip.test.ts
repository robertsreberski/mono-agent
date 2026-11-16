import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startTuiAdapter } from "@mono-agent/channel-operator";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it } from "vitest";
import { OperatorClient } from "../operator-client.js";
import { WebStore } from "../store.js";

it("keeps a silent operator compaction alive and records its success past the parser deadline", async () => {
  const root = await mkdtemp(join(process.cwd(), ".compaction-roundtrip-"));
  const store = await WebStore.open({ stateDir: join(root, "state") });
  let observed: AbortSignal | undefined;
  const operator = await startTuiAdapter({ responder: {
    respond: async () => ({ text: "unused" }),
    compactConversation: async (_id, _options, signal) => {
      observed = signal;
      await new Promise(resolve => setTimeout(resolve, 1500));
      expect(signal?.aborted).toBe(false);
      return { status: "succeeded", trigger: "manual", operationId: "fictional-long-summary" };
    },
  } });
  const previous = getGlobalDispatcher();
  const agent = new Agent();
  setGlobalDispatcher(agent.compose(dispatch => (options, handler) => dispatch({
    ...options, headersTimeout: options.headersTimeout === 0 ? 0 : 100,
  }, handler)));
  try {
    store.replaceAgents([{
      sourceId: "fictional", label: "Fictional agent", status: "online", health: "running",
      supportsAttachments: false, models: [], efforts: [], modelOptions: {},
      runSettings: { config: {}, override: null, effective: { modelSource: "config", effortSource: "config" } },
      updatedAt: "2026-01-15T10:00:00Z",
    }]);
    const thread = store.createThread("fictional");
    const client = new OperatorClient({ baseUrl: operator.baseUrl });
    const result = await client.compactConversation(`web:${thread.id}`);
    store.recordManualCompaction(thread.id, result);
    expect(observed?.aborted).toBe(false);
    expect(store.getThreadDetail(thread.id)?.messages[0]?.parts[0]).toMatchObject({
      type: "conversation-marker", kind: "compaction", status: "succeeded", operationId: "fictional-long-summary",
    });
  } finally {
    setGlobalDispatcher(previous);
    await agent.close();
    await operator.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
