// Real Web service/SQLite and harness admission/settlement; faux operator and
// runtime transports. Native evidence is absent at this pre-consumption cut.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebService } from "../../../dist/service.js";
import { createAgentHarness, createDurableHistoryStore } from "../../../../agent-harness/dist/index.js";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

const [root, mode] = process.argv.slice(2), timestamp = "2000-01-01T00:00:00.000Z";
const historyRoot = join(root, "history"), stateDir = join(root, "web");
let providers = 0, tools = 0, dispatches = 0, inspections = 0;
const dispatchRoutes = [];
let ready, admitted;
const runtimeReady = new Promise((resolve) => { ready = resolve; });
const hostAdmitted = new Promise((resolve) => { admitted = resolve; });
const store = createDurableHistoryStore({ root: historyRoot, now: () => Date.parse(timestamp),
  retireProviderSession: async () => {},
  reconcileProviderSessionTurn: async () => { inspections++; return { status: "absent" }; },
});
await writeFile(join(root, "IDENTITY.md"), "Fictional stable instructions.");
const harness = createAgentHarness({ identityPath: join(root, "IDENTITY.md"), cwd: root,
  historyStore: store, model: parseMonoRuntimeModelReference("openai:fictional-model"),
  createRunId: () => "fictional-turn", piSessionsRoot: join(root, "native"),
  session: { mode: "continuous", idleTimeoutMs: 60_000 },
  runtime: {
    sessionTurnReconciliation: "v1", async reconcileSessionTurn() { return { status: "absent" }; },
    async refreshSession() {}, async syncSession() { return true; },
    // All faux provider/tool effects are reachable only through runtime entry.
    configureTools() {}, executeTool() { tools++; throw new Error("Unexpected tool execution"); },
    async run(_prompt, options) {
      providers++; ready();
      const next = await options.liveInput[Symbol.asyncIterator]().next();
      if (next.done) throw new Error("Missing input");
      next.value.accepted?.(); // Admission completed; deliberately no acknowledge.
      admitted();
      return new Promise(() => {}); // IPC channel holds worker until SIGKILL.
    },
  },
});
const agent = { source: { schema: "agent-runtime.trace-source.v1", sourceId: "fictional-agent", label: "Fictional Agent",
  // Keep the faux agent generation stable: this tests storage recovery, not
  // Web's separate agent-generation continuity-wake collector.
  artifactDir: join(root, "artifacts"), pid: 123, status: "running", health: "running",
  startedAt: timestamp, updatedAt: timestamp, warnings: [] }, baseUrl: "http://127.0.0.1:45123/gui" };
const fetchImpl = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/v1/info")) return Response.json({ schema: 1, label: "Fictional Agent", model: "openai:fictional-model", capabilities: { liveInput: true } });
  if (url.endsWith("/v1/turns")) {
    dispatches++; dispatchRoutes.push({ url, body: init.body });
    if (mode !== "produce") throw new Error("Recovery dispatched a turn");
    const body = JSON.parse(init.body);
    void harness.run({ conversationId: body.conversationId, userMessage: body.text, abortSignal: new AbortController().signal }).then((result) => { throw new Error(`Unexpected harness completion: ${JSON.stringify(result)}`); });
    return new Response(new ReadableStream(), { headers: { "content-type": "application/x-ndjson" } });
  }
  if (url.endsWith("/live-input")) {
    dispatches++; dispatchRoutes.push({ url, body: init.body });
    if (mode !== "produce") throw new Error("Recovery dispatched input");
    const body = JSON.parse(init.body);
    const encoded = url.split("/v1/conversations/")[1].split("/live-input")[0];
    const offer = harness.offerLiveInput({ ...body, conversationId: decodeURIComponent(encoded) });
    if (offer.status !== "accepted") throw new Error(`Offer unavailable: ${offer.reason}`);
    await hostAdmitted;
    await offer.settled; // Neither HTTP settlement nor consumed evidence exists.
    throw new Error("Unexpected live settlement");
  }
  throw new Error(`Unexpected operator route: ${new URL(url).pathname}`);
};
const web = await WebService.create({ stateDir, clock: () => new Date(timestamp), discoveryIntervalMs: 0, purgeIntervalMs: 0,
  discoverImpl: async () => [agent], fetchImpl });
if (mode === "produce") {
  process.on("message", () => {}); // Keep the IPC barrier alive, without sleeps.
  const thread = web.createThread("fictional-agent");
  await web.startTurn(thread.id, { text: "Fictional initial task." });
  await runtimeReady;
  const receipt = web.submitLiveInput(thread.id, "Fictional preserved correction.");
  await hostAdmitted;
  const reader = new DatabaseSync(join(stateDir, "state.sqlite"), { readOnly: true });
  const row = reader.prepare("SELECT id, dispatch_started_at FROM live_inputs WHERE message_id = ?").get(receipt.message.id);
  reader.close();
  const pending = await Promise.all((await readdir(join(historyRoot, ".pending-turns"))).filter((name) => name.endsWith(".json"))
    .map(async (name) => JSON.parse(await readFile(join(historyRoot, ".pending-turns", name), "utf8"))));
  await writeFile(join(root, "coordinates.json"), JSON.stringify({ bucket: `web:${thread.id}`, threadId: thread.id, messageId: receipt.message.id }));
  process.send({ phase: "admitted-unconsumed", receipt, dispatch: row, pendingIds: pending.flatMap((payload) => payload.inputs.map((input) => input.id)), providers, tools, dispatches });
} else {
  const coordinates = JSON.parse(await readFile(join(root, "coordinates.json"), "utf8"));
  const recovery = await store.recoverProviderSessionTurn(coordinates.bucket);
  const canonicalPath = (await readdir(historyRoot)).find((name) => name.endsWith(".history.json"));
  const bytes = await readFile(join(historyRoot, canonicalPath), "utf8");
  // Allow any already-scheduled service delivery work to enter the guarded transport.
  await new Promise(setImmediate);
  const message = web.store.getMessage(coordinates.messageId), queued = web.store.queuedLiveInputThreadIds();
  await web.stop(); await harness.dispose?.();
  process.send({ recovery, bytes, canonical: JSON.parse(bytes), message, queued, providers, tools, dispatches, inspections, dispatchRoutes });
  process.disconnect();
}
