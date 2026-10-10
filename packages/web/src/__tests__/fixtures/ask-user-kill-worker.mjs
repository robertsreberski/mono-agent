// Real native journal/matcher, host receipts, Web SQLite and interaction bridge.
// Provider transport is fictional; recovery must never enter it or register a tool.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTurnBinding, digestTurnInput } from "@mono-agent/harness";
import { JsonlSessionRepo } from "@mono-agent/harness/session-store.js";
import { createMonoRuntime, parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import { createAgentHarness, createDurableHistoryStore } from "../../../../agent-harness/dist/index.js";
import { startInteractionBridge } from "../../../../agent-app/dist/interaction-bridge.js";
import { WebStore } from "../../../dist/store.js";

const [root, mode] = process.argv.slice(2), timestamp = "2000-01-01T00:00:00.000Z";
const nativeRoot = join(root, "native"), bucket = "web:fictional-thread";
const model = { provider: "openai", id: "fictional-model", api: "openai-responses" };
const runtime = createMonoRuntime({ workspace: root });
let providers = 0, tools = 0, inspections = 0;
runtime.run = async () => { providers++; throw new Error("Unexpected provider execution during storage recovery"); };
const host = createDurableHistoryStore({ root: join(root, "history"), now: () => Date.parse(timestamp),
  retireProviderSession: async () => {},
  reconcileProviderSessionTurn: async (request) => {
    inspections++;
    return runtime.reconcileSessionTurn({ ...request, sessionsRoot: nativeRoot, expectedModel: model });
  },
});
const web = await WebStore.open({ stateDir: join(root, "web"), clock: () => new Date(timestamp) });
const bridge = await startInteractionBridge({ port: 0, now: () => new Date(timestamp), askTimeoutMs: null });
if (mode === "produce") {
  web.replaceAgents([{ sourceId: "fictional-agent", label: "Fictional Agent", status: "online", health: "running", supportsAttachments: false,
    models: ["openai:fictional-model"], efforts: [], updatedAt: timestamp }]);
  const thread = web.createThread("fictional-agent");
  const turn = web.beginTurn({ threadId: thread.id, text: "Fictional initial task.", attachmentIds: [] });
  const held = await host.beginProviderSessionTurn(bucket, "fictional-turn", { modelKey: "openai:fictional-model",
    reconciliation: { purpose: "execution", ownerKey: bucket, initial: { persistText: "Fictional initial task.", timestamp } } });
  const descriptor = held.reconciliation.descriptor;
  const repo = new JsonlSessionRepo({ sessionsRoot: nativeRoot }), raw = await repo.create({ id: descriptor.handleId, cwd: root });
  await raw.beginTurn(descriptor.turnId, { model }, "host", createTurnBinding(descriptor, model));
  await raw.openOperation("fictional-operation", { model });
  const initialId = await raw.appendMessage({ role: "user", content: "Fictional initial task.", timestamp: Date.parse(timestamp) }, undefined,
    { id: descriptor.reconciliation.initialInputId, complete: true, placement: "initial", requestDigest: digestTurnInput("Fictional initial task.") });
  if (!raw.validator.turns.get(descriptor.turnId).inputs.size) await raw.write("input_consumed", { inputId: descriptor.reconciliation.initialInputId, messageId: initialId }, { operationId: "fictional-operation" });
  const args = { message: "Fictional question.", questions: [{ id: "q0", header: "Choice", question: "Which fictional option?",
    options: [{ id: "q0o0", label: "Maple", description: "Fictional option." }, { id: "q0o1", label: "Birch", description: "Another fictional option." }], multiSelect: false }] };
  const messageId = await raw.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fictional-ask", name: "AskUser", arguments: args }], stopReason: "toolUse", timestamp: Date.parse(timestamp) });
  for (const admission of ["observed", "admitted", "started"]) await raw.write("tool_call", { callId: "fictional-ask", name: "AskUser", messageId, admission }, { operationId: "fictional-operation" });
  await raw.sync();
  let presented;
  bridge.registerSink("web", { async presentAsk(_conversationId, snapshot) {
    presented = snapshot;
    web.applyStreamFrames(turn.turnId, [{ kind: "event", event: { type: "tool_call_started", id: "fictional-ask", name: "AskUser", arguments: args } }]);
  } });
  tools++;
  const response = await fetch(`${bridge.url}/v1/asks`, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ conversationId: bucket, runId: "fictional-turn", ...args }) });
  if (response.status !== 201) throw new Error(`Ask registration failed: ${await response.text()}`);
  const { interactionId } = await response.json();
  await writeFile(join(root, "ask-coordinates.json"), JSON.stringify({ threadId: thread.id, assistantId: turn.assistantMessageId, interactionId }));
  process.send({ phase: "presented-and-persisted", presented, activeAsks: bridge.pendingAskCount(), part: web.getMessage(turn.assistantMessageId).parts[0], tools, providers });
  // The bridge server and owned native journal keep this barrier alive until SIGKILL.
} else {
  const coordinates = JSON.parse(await readFile(join(root, "ask-coordinates.json"), "utf8"));
  await host.recoverProviderSessionTurn(bucket); await host.recoverProviderSessionTurn(bucket);
  const history = await host.load(bucket), message = web.getMessage(coordinates.assistantId);
  const staleReply = await bridge.submitAskAnswers({ conversationId: bucket, interactionId: coordinates.interactionId, answers: [] });
  const recovery = { history, message, activeAsks: bridge.pendingAskCount(), oldAsk: bridge.getAsk(coordinates.interactionId) ?? null, staleReply, providers, tools, inspections };
  if (mode === "continue") {
    await writeFile(join(root, "IDENTITY.md"), "Fictional stable instructions.");
    const harness = createAgentHarness({ identityPath: join(root, "IDENTITY.md"), cwd: root, historyStore: host,
      createRunId: () => "fictional-explicit-next", model: parseMonoRuntimeModelReference("openai:fictional-model"),
      runtime: { async run() { providers++; return { text: "Fictional new reply." }; } } });
    const next = web.beginTurn({ threadId: coordinates.threadId, text: "Fictional explicit new answer.", attachmentIds: [] });
    const result = await harness.run({ conversationId: bucket, userMessage: next.text, abortSignal: new AbortController().signal });
    if (result.failure) throw new Error(`Explicit turn failed: ${result.failure.kind}`);
    web.completeTurn(next.turnId, result.text); await harness.dispose?.();
    recovery.continuedHistory = await host.load(bucket); recovery.continuedMessages = web.getThreadDetail(coordinates.threadId).messages;
    recovery.afterProviders = providers; recovery.afterTools = tools;
  }
  await bridge.stop(); web.close();
  process.send(recovery); process.disconnect();
}
