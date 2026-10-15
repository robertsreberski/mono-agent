// Configured-host model-switch kill matrix worker. The real public config path
// (runtime.session.modelSwitch enabled), Web-shaped
// persisted delivery IDs, faux providers only, no tools. One IPC job per process.
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";
import { createConfiguredAgentResponderForApp, wrapOwnedConfiguredRuntime } from "../../../dist/configured-agent.js";
import { createRequestModelOverrideRuntimeExtension } from "../../../dist/request-model-override.js";
import { loadAppCoreConfig } from "../../../dist/app-config.js";

const root = process.argv[2], conversationId = "web:fictional-thread", successorId = "web:fictional-successor";
const historyRoot = join(root, "history"), nativeRoot = join(root, "native"), callsPath = join(root, "calls.jsonl");
const summary = JSON.stringify({ intent: ["Fictional garden plan"], constraints: ["Fictional constraint: no watering after dusk"], decisions: [],
  completedWork: ["Fictional seed answer"], failures: [], openWork: ["Fictional open work: label the trays"], nextActions: [], references: [] });
// A stable API identity: faux otherwise randomizes it per process, which a
// restarted host would correctly treat as a different recorded target.
const provider = "faux", api = "fictional-faux-api";
const faux = fauxProvider({ provider, api, models: ["A", "B"].map((id) => ({ id, api, contextWindow: id === "A" ? 1_000_000 : 100_000, maxTokens: 4096 })), tokensPerSecond: 1_000_000 });
const models = createModels();

// Every provider request is appended BEFORE the response, so a killed process
// still accounts the (possibly billed) call. A summaries are rejected as
// malformed, so a first A -> B switch exercises outgoing -> (no prior
// checkpoint) -> incoming; B summaries are valid, so a B -> A return is
// accepted from the paid outgoing slot, or from the prior validated checkpoint.
const contexts = [];
let malformedB = false; // abandon setup: both producers reject, leaving the intent pending
const original = faux.provider.streamSimple.bind(faux.provider);
faux.provider.streamSimple = (model, context, options) => {
  const kind = JSON.stringify(context.messages[0] ?? null).includes("Summarize historical evidence") || context.systemPrompt?.startsWith("Summarize historical evidence") ? "summary" : "turn";
  appendFileSync(callsPath, JSON.stringify({ pid: process.pid, model: model.id, kind, armed: globalThis.__fixtureArmed === true }) + "\n");
  if (kind === "turn") contexts.push(JSON.stringify(context.messages));
  faux.setResponses([async () => {
    await globalThis.__fixtureStop?.(`${kind}-${model.id}`);
    return fauxAssistantMessage([fauxText(kind === "turn" ? `Fictional ${model.id} answer` : model.id === "A" || malformedB ? "Fictional malformed summary" : summary)]);
  }]);
  return original(model, context, options);
};
models.setProvider(faux.provider);
const ref = (id) => ({ provider, model: id, reference: `${provider}:${id}` });
const runtimeFor = (config, id) => {
  const raw = createMonoRuntime({ workspace: root }), run = raw.run.bind(raw), prepare = raw.prepareNativeDispatch.bind(raw);
  raw.run = (prompt, options) => run(prompt, { ...options, piResolvedModel: faux.getModel(id), piResolvedModels: models });
  raw.prepareNativeDispatch = (prompt, options) => prepare(prompt, { ...options, piResolvedModel: faux.getModel(id), piResolvedModels: models });
  return wrapOwnedConfiguredRuntime(raw, config, root, undefined);
};
async function open(base = "A") {
  const configPath = join(root, "mono-agent.config.json");
  await writeFile(join(root, "IDENTITY.md"), "Fictional stable instructions");
  await writeFile(configPath, JSON.stringify({
    runtime: { model: "pi:openai-codex:gpt-5.5", workspace: root, maxTurns: 4,
      session: { root: nativeRoot, mode: "continuous", idleTimeoutMs: 600000, rollover: "none", modelSwitch: { enabled: true } } },
    providers: { piNative: {} }, context: { identityPath: join(root, "IDENTITY.md"), selectedSkills: [] },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(root, "artifacts"), retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false }, memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false } },
    traceability: { registryDir: join(root, "trace") },
  }));
  const loaded = await loadAppCoreConfig({ cwd: root, configPath, env: {} });
  // Only the provider transport is replaced; the switch policy comes from the validated config.
  const config = { ...loaded, runtime: { ...loaded.runtime, model: ref(base) } };
  /** @type {import("@mono-agent/agent-harness").ConversationHistoryStore} */
  let store;
  const responder = await createConfiguredAgentResponderForApp({ config, cwd: root, runtime: runtimeFor(config, base),
    runtimeForModel: (selected) => runtimeFor(config, selected.model), runtimeOptionsForRequest: createRequestModelOverrideRuntimeExtension({ baseModel: ref(base) }),
    runtimeOptions: { piResolvedModels: models, piMaxRetries: 0, compaction: { enabled: false } } }, { sessionRollover: "none", wrapHistoryStore: (value) => { store = value; return value; } });
  return { responder: /** @type {import("@mono-agent/agent-contracts").AgentResponder & { dispose(): Promise<void>; startNewSession(id: string): Promise<unknown> }} */ (responder), store };
}
const request = (id, model, conversation = conversationId) => ({ conversationId: conversation, text: `Fictional input ${id}`, abortSignal: new AbortController().signal,
  metadata: { source: "web", web: { threadId: conversation.slice(4), model: `${provider}:${model}`, ...(id === undefined ? {} : { userMessageId: id }) }, tui: { requestId: randomUUID() } } });
async function respond(responder, id, model, conversation) {
  const warnings = [];
  try {
    const result = await responder.respond(request(id, model, conversation), { append: async () => {}, event: async (event) => { if (event.warningKind) warnings.push(event.warningKind); } });
    return { text: result.text, warnings };
  } catch (error) { return { failure: error?.failure?.kind ?? error?.name ?? "error", message: String(error?.failure?.message ?? error?.message ?? error).slice(0, 300), warnings }; }
}
async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) out.push(...await files(join(dir, entry.name))); else out.push(join(dir, entry.name));
  }
  return out;
}
async function canonical(id = conversationId) {
  for (const name of (await readdir(historyRoot).catch(() => [])).filter((name) => name.endsWith(".history.json"))) {
    const record = JSON.parse(await readFile(join(historyRoot, name), "utf8"));
    if (record.conversationId === id) return record;
  }
  return null;
}
async function snapshot(store) {
  const journals = (await files(join(nativeRoot, "journals"))).filter((path) => path.endsWith(".jsonl")).sort();
  const records = await Promise.all(journals.map(async (path) => (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))));
  return {
    canonical: await canonical(), successor: await canonical(successorId),
    journals: Object.fromEntries(await Promise.all(journals.map(async (path) => [path.split("/").at(-1), createHash("sha256").update(await readFile(path)).digest("hex")]))),
    modelChanges: records.flat().filter((record) => record.kind === "model_change").length,
    toolRecords: records.flat().filter((record) => record.kind === "tool_call" || record.kind === "tool_result").length,
    switchFiles: (await readdir(join(historyRoot, ".model-switches")).catch(() => [])).sort(),
    ...await switchStorage(),
    operations: (await readdir(historyRoot).catch(() => [])).filter((name) => name.startsWith(".native-history-op.")),
    pending: (await readdir(join(historyRoot, ".pending-turns")).catch(() => [])),
    dirty: (await readdir(join(historyRoot, ".locks")).catch(() => [])).filter((name) => name.endsWith(".dirty.json")),
    stats: store ? await store.stats() : null,
  };
}
// Durable billing/artifact evidence: every retained switch state and handoff.
async function switchStorage() {
  const dir = join(historyRoot, ".model-switches"), names = await readdir(dir).catch(() => []);
  const read = async (name) => JSON.parse(await readFile(join(dir, name), "utf8"));
  const states = await Promise.all(names.filter((name) => name.endsWith(".state.json")).map(read));
  const handoffs = await Promise.all(names.filter((name) => name.endsWith(".handoff.json")).map(read));
  return {
    switchStates: states.map((state) => ({ switchId: state.identity.switchId, phase: state.phase, from: state.identity.fromModelKey, to: state.identity.toModelKey,
      generation: state.authorizationGeneration, authorizations: state.authorizations.length,
      attempts: state.attempts.map(({ producer, outcome, generation }) => ({ producer, outcome, generation })) })),
    artifacts: handoffs.map(({ switchId, artifact }) => ({ switchId, producer: artifact.producer,
      summary: artifact.summary !== null, ledger: artifact.ledger.length, recent: artifact.recent.length, budget: artifact.budget })),
  };
}
function calls() {
  try { return readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.pid === process.pid); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
globalThis.__fixtureCalls = calls;

// External loss of the current journal (P4 PR D): the producer deletes it, then
// the killed turn establishes the owner-approved cold boundary. Recovery is
// storage-only; "resume" is one later explicit message on a fresh process.
async function missingJob(scenario, mode) {
  // missing: the switched current journal lost; missing-v3: never switched;
  // missing-root: the whole native root is gone before a fresh process.
  const opened = await open(), results = [], model = scenario === "missing-v3" ? "A" : "B";
  try {
    if (mode === "produce") {
      results.push(await respond(opened.responder, "fictional-seed", "A"));
      if (scenario !== "missing-v3") results.push(await respond(opened.responder, "fictional-switch", "B"));
      const journals = join(nativeRoot, "journals");
      if (scenario === "missing-root") {
        const report = { results, calls: calls(), contexts, ...await snapshot(opened.store) };
        await opened.responder.dispose(); await rm(nativeRoot, { recursive: true, force: true });
        process.send(report, () => process.exit(0)); return;
      }
      for (const name of (await readdir(journals)).filter((name) => name.endsWith(".jsonl"))) await unlink(join(journals, name));
      const bytes = Object.fromEntries(await Promise.all((await files(journals)).filter((path) => path.endsWith(".jsonl")).map(async (path) => [path.split("/").at(-1), (await readFile(path)).toString("base64")])));
      await writeFile(join(root, "before.json"), JSON.stringify({ ...await snapshot(opened.store), bytes }));
      globalThis.__fixtureArmed = true;
      results.push(await respond(opened.responder, "fictional-after-loss", model));
      throw new Error("Missing-journal producer was not killed");
    }
    const recovery = mode === "recover" ? await opened.store.recoverProviderSessionTurn(conversationId) : undefined;
    if (mode === "resume") results.push(await respond(opened.responder, "fictional-resume", model));
    await opened.responder.dispose();
    process.send({ results, recovery, calls: calls(), contexts, ...await snapshot(opened.store) }, () => process.exit(0));
  } finally { await opened.responder.dispose(); }
}
process.once("message", async ({ scenario, mode }) => {
  let opened;
  try {
    await mkdir(root, { recursive: true });
    if (scenario.startsWith("missing") && scenario !== "missing-switch") { await missingJob(scenario, mode); return; }
    const results = [];
    if (mode === "produce") {
      opened = await open();
      results.push(await respond(opened.responder, "fictional-seed", "A"));
      malformedB = scenario === "abandon";
      if (scenario !== "structured") results.push(await respond(opened.responder, "fictional-switch-b", "B"));
      malformedB = false;
      if (scenario === "return" || scenario === "missing-switch") results.push(await respond(opened.responder, "fictional-b-turn", "B"));
      if (scenario === "missing-switch") {
        // External loss before an explicit switch: canonical history is the outgoing evidence.
        const journals = join(nativeRoot, "journals");
        for (const name of (await readdir(journals)).filter((name) => name.endsWith(".jsonl"))) await unlink(join(journals, name));
      }
      if (scenario === "retention") {
        const old = new Date("2000-01-01T00:00:00Z");
        for (const name of (await readdir(historyRoot)).filter((name) => name.endsWith(".history.json"))) await utimes(join(historyRoot, name), old, old);
      }
      const journals = (await files(join(nativeRoot, "journals"))).filter((path) => path.endsWith(".jsonl"));
      const bytes = Object.fromEntries(await Promise.all(journals.map(async (path) => [path.split("/").at(-1), (await readFile(path)).toString("base64")])));
      await writeFile(join(root, "before.json"), JSON.stringify({ ...await snapshot(opened.store), bytes }));
      globalThis.__fixtureArmed = true;
    } else opened = await open();
    // "recover" redelivers the killed persisted message; "resume" is a new explicit delivery.
    if (scenario === "structured") results.push(await respond(opened.responder, mode === "resume" ? "fictional-next" : "fictional-switch", "B"));
    else if (scenario === "return" || scenario === "missing-switch") results.push(await respond(opened.responder, mode === "resume" ? "fictional-next" : "fictional-return", "A"));
    // abandon: the killed delivery asks for the pending intent's source model.
    else if (scenario === "abandon") results.push(await respond(opened.responder, mode === "resume" ? "fictional-next" : "fictional-abandon", mode === "resume" ? "B" : "A"));
    else if (scenario === "reset") { await opened.responder.startNewSession(conversationId); results.push({ text: "reset" }); }
    else results.push(await respond(opened.responder, "fictional-successor-message", "A", successorId));
    globalThis.__fixtureArmed = false;
    await opened.responder.dispose(); const store = opened.store; opened = undefined;
    process.send({ results, calls: calls(), contexts, ...await snapshot(store) }, () => process.exit(0));
  } catch (error) { console.error(error); await opened?.responder.dispose().catch(() => {}); process.exit(1); }
});
