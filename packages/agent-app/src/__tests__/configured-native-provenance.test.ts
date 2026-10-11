// Opt-in pinned-lease provenance for epochs written before any switch. Matching
// provenance never selects native reuse: every model change takes a handoff.
// Real public config path, Web-shaped persisted IDs, Codex-shaped faux provider
// with fictional in-memory OAuth credentials. No network, tools or real roots.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { AgentRequestBase, AgentResponder } from "@mono-agent/agent-contracts";
import type { ConversationHistoryStore } from "@mono-agent/agent-harness";
import { createMonoRuntime, type MonoRuntimeLike } from "@mono-agent/runtime-adapter";
import { createConfiguredAgentResponderForApp, wrapOwnedConfiguredRuntime } from "../configured-agent.js";
import { createRequestModelOverrideRuntimeExtension } from "../request-model-override.js";
import { JsonlSessionRepo } from "../../../harness/dist/session-store.js";
import { loadAppCoreConfig } from "../app-config.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const provider = "openai-codex", api = "openai-codex-responses";
const token = (account: string) => `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.fixture`;
const ref = (id: string) => ({ provider, model: id, reference: `${provider}:${id}` });
const isSummary = (context: unknown) => JSON.stringify(context).includes("Summarize historical evidence");

async function fixture(options: { enabled?: boolean; fallback?: boolean; runtimeOptions?: Record<string, unknown> } = {}) {
  const enabled = options.enabled ?? true;
  const root = await mkdtemp(join(tmpdir(), "app-native-provenance-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const nativeRoot = join(root, "native"), identityPath = join(root, "IDENTITY.md");
  await writeFile(identityPath, "Fictional stable instructions");
  let credential = { type: "oauth", accountId: "fictional-account", access: token("fictional-account"), refresh: "fictional-refresh", expires: Date.now() + 86_400_000 };
  // Faux models inherit the provider API; the explicit per-model api mirrors the runtime fixture.
  const definitions = [{ id: "A", api, contextWindow: 1_000_000, maxTokens: 4096 }, { id: "B", api, contextWindow: 100_000, maxTokens: 4096 }] as unknown as NonNullable<NonNullable<Parameters<typeof fauxProvider>[0]>["models"]>;
  const faux = fauxProvider({ provider, api, models: definitions, tokensPerSecond: 1_000_000 });
  const transport = vi.spyOn(faux.provider, "streamSimple");
  const models = createModels({ credentials: { read: async () => ({ ...credential }), list: async () => [provider], delete: async () => {}, modify: async () => ({ ...credential }) } as never });
  models.setProvider({ ...faux.provider, auth: { oauth: { refresh: async () => ({ ...credential }), toAuth: (value: { access: string }) => ({ apiKey: value.access }) } } } as never);
  const configPath = join(root, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify({
    runtime: { model: "pi:openai-codex:gpt-5.5", workspace: root, maxTurns: 4,
      session: { mode: "continuous", idleTimeoutMs: 600000, rollover: "none", modelSwitch: enabled ? { enabled: true, olderWritersStopped: true } : { enabled: false } } },
    providers: { piNative: { piSessionsRoot: nativeRoot } }, context: { identityPath, selectedSkills: [] }, tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(root, "artifacts") }, traceability: { registryDir: join(root, "trace") },
  }));
  const loaded = await loadAppCoreConfig({ cwd: root, configPath, env: {} });
  const config = { ...loaded, runtime: { ...loaded.runtime, model: ref("A") } };
  const runtimeFor = (id: string): MonoRuntimeLike => {
    const raw = options.fallback
      ? createMonoRuntime({ workspace: root, fallbackChain: [{ model: ref("A"), attempts: 1 }, { model: ref("B"), attempts: 1 }], sessionTurnReconciliation: "v1",
        resolveAttempt: ({ model }) => ({ options: { piResolvedModel: faux.getModel(model.model), piResolvedModels: models } }) })
      : createMonoRuntime({ workspace: root });
    if (!options.fallback) {
      const run = raw.run.bind(raw), prepare = raw.prepareNativeDispatch!.bind(raw);
      raw.run = (prompt, runOptions) => run(prompt, { ...runOptions, piResolvedModel: faux.getModel(id), piResolvedModels: models });
      raw.prepareNativeDispatch = (prompt, runOptions) => prepare(prompt, { ...runOptions, piResolvedModel: faux.getModel(id), piResolvedModels: models });
    }
    const owned = wrapOwnedConfiguredRuntime(raw, config, root, undefined); cleanup.push(() => owned.disposeAllSessions!()); return owned;
  };
  let store: ConversationHistoryStore | undefined;
  const make = async (wrapRuntime: (runtime: MonoRuntimeLike) => MonoRuntimeLike = (runtime) => runtime) => {
    const responder = await createConfiguredAgentResponderForApp({ config, cwd: root, runtime: wrapRuntime(runtimeFor("A")),
      runtimeForModel: (selected) => wrapRuntime(runtimeFor(selected.model)), runtimeOptionsForRequest: createRequestModelOverrideRuntimeExtension({ baseModel: ref("A") }),
      runtimeOptions: { piResolvedModels: models, piMaxRetries: 0, compaction: { enabled: false }, ...options.runtimeOptions } },
    { sessionRollover: "none", wrapHistoryStore: (value) => { store = value; return value; } });
    cleanup.push(() => (responder as AgentResponder & { dispose(): Promise<void> }).dispose()); return responder;
  };
  const request = (id: string | undefined, model: string, signal = new AbortController().signal): AgentRequestBase => ({ conversationId: "web:fictional-thread",
    text: `Fictional input ${id ?? "wake"}`, abortSignal: signal,
    metadata: { source: "web", web: id === undefined ? { trigger: "job" } : { threadId: "fictional-thread", model: `${provider}:${model}`, userMessageId: id }, tui: { requestId: randomUUID() } } });
  const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);
  const record = async () => {
    for (const name of (await readdir(join(root, "history"))).filter((entry) => entry.endsWith(".history.json"))) {
      const value = JSON.parse(await readFile(join(root, "history", name), "utf8")); if (value.conversationId === "web:fictional-thread") return value;
    }
    return undefined;
  };
  const journalRecords = async () => (await Promise.all((await readdir(nativeRoot, { recursive: true }).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl"))
    .map(async (name) => (await readFile(join(nativeRoot, name), "utf8")).trim().split("\n").map((line) => JSON.parse(line))))).flat();
  const artifacts = async () => Promise.all((await readdir(join(root, "history", ".model-switches")).catch(() => [] as string[])).filter((name) => name.endsWith(".handoff.json"))
    .map(async (name) => JSON.parse(await readFile(join(root, "history", ".model-switches", name), "utf8"))));
  const summaryCalls = () => transport.mock.calls.filter(([, context]) => isSummary(context)).length;
  return { root, faux, transport, make, request, reply, record, journalRecords, artifacts, summaryCalls, getStore: () => store!,
    setAccount: (account: string) => { credential = { ...credential, accountId: account, access: token(account) }; } };
}
const summary = JSON.stringify({ intent: ["Fictional objective"], constraints: [], decisions: [], completedWork: [], failures: [], openWork: [], nextActions: [], references: [] });
const artifactOf = (artifacts: { switchId: string; artifact: Record<string, unknown> }[], switchId: string) => artifacts.find((entry) => entry.switchId === switchId)!.artifact;

it("fresh opt-in Web conversation records lease provenance from its first epoch; A->B->A still takes a structured handoff each way", async () => {
  const f = await fixture(), h = await f.make();
  f.faux.setResponses([f.reply("Fictional A answer")]); await h.respond(f.request("fictional-first", "A"), { append: async () => {} });
  const first = await f.journalRecords();
  expect(first.filter((row) => row.kind === "operation_start").map((row) => row.payload.config.nativeProvenance))
    .toEqual([{ provider, api, model: "A", account: expect.stringMatching(/^codex-account-v1:/u) }]);
  expect((await f.record()).version).toBe(3); // Recording grants no authority and does not upgrade the conversation.
  f.faux.setResponses([f.reply(summary), f.reply("Fictional B answer")]); await h.respond(f.request("fictional-switch-b", "B"), { append: async () => {} });
  let returned = "";
  f.faux.setResponses([f.reply(summary), (context) => { returned = JSON.stringify(context.messages); return f.reply("Fictional return answer"); }]);
  await h.respond(f.request("fictional-return-a", "A"), { append: async () => {} });
  const canonical = await f.record(), artifacts = await f.artifacts();
  // Matching provider, API and account no longer reuse native envelopes.
  expect(canonical.version).toBe(5); expect(canonical.providerSession.modelKey).toBe(`${provider}:A`);
  expect(artifacts).toHaveLength(1); // exactly one durable handoff remains
  expect(artifactOf(artifacts, canonical.lastSwitch.switchId)).toMatchObject({ producer: "outgoing", summary: expect.any(Object) });
  expect(artifacts.every((entry) => !Object.hasOwn(entry.artifact, "nativeProjection"))).toBe(true);
  expect(f.summaryCalls()).toBe(2); expect(f.transport).toHaveBeenCalledTimes(5);
  expect(returned).toContain("Historical handoff"); expect(returned).toContain("Fictional input fictional-switch-b"); expect(returned).toContain("Fictional B answer");
});

it("OFF keeps the original unprepared route and writes no provenance, even with codex credentials and forged caller options", async () => {
  const f = await fixture({ enabled: false, runtimeOptions: { nativeProvenance: { provider, api, model: "A", account: "codex-account-v1:forged" }, nativeProvenanceRecording: true } });
  const h = await f.make();
  f.faux.setResponses([f.reply("Fictional A answer"), f.reply("Fictional B answer")]);
  await h.respond(f.request("fictional-first", "A"), { append: async () => {} }); await h.respond(f.request("fictional-second", "B"), { append: async () => {} });
  const records = await f.journalRecords();
  expect(records.length).toBeGreaterThan(0);
  expect(records.some((row) => JSON.stringify(row).includes("nativeProvenance") || JSON.stringify(row).includes("forged"))).toBe(false);
  expect((await f.record()).version).toBe(3);
  expect((await readdir(join(f.root, "history"))).some((name) => name.includes("native-history-root") || name.includes("model-switch"))).toBe(false);
});

it("caller provenance and flags are ignored; a mixed-provenance first epoch stays unknown and takes the handoff", async () => {
  const forged = { provider, api, model: "A", account: "codex-account-v1:forged" };
  const f = await fixture({ runtimeOptions: { nativeProvenance: forged, nativeProvenanceRecording: true } }), h = await f.make();
  f.faux.setResponses([f.reply("Fictional A answer")]); await h.respond(f.request("fictional-first", "A"), { append: async () => {} });
  // A no-ID wake keeps the original unprepared path: no lease, so no provenance,
  // even though caller options carry a forged value and the recording flag.
  f.faux.setResponses([f.reply("Fictional wake answer")]); await h.respond(f.request(undefined, "A"), { append: async () => {} });
  const starts = (await f.journalRecords()).filter((row) => row.kind === "operation_start");
  expect(starts).toHaveLength(2);
  expect(starts[0].payload.config.nativeProvenance.account).toMatch(/^codex-account-v1:/u);
  expect(starts[0].payload.config.nativeProvenance.account).not.toBe(forged.account);
  expect(Object.hasOwn(starts[1].payload.config, "nativeProvenance")).toBe(false);
  f.faux.setResponses([f.reply(summary), f.reply("Fictional B answer")]);
  await h.respond(f.request("fictional-switch-b", "B"), { append: async () => {} });
  const canonical = await f.record();
  expect(JSON.stringify(await f.artifacts())).not.toContain("forged");
  expect(artifactOf(await f.artifacts(), canonical.lastSwitch.switchId)).toMatchObject({ producer: "outgoing" }); expect(f.summaryCalls()).toBe(1);
  expect(JSON.stringify(canonical)).not.toContain("forged");
});

it.each([false, true])("first persisted Web turn with a fallback chain: opt-in is primary-only, OFF fails over (enabled=%s)", async (enabled) => {
  const f = await fixture({ enabled, fallback: true }), h = await f.make();
  const overloaded = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable: overloaded" });
  f.faux.setResponses([overloaded(), overloaded(), overloaded(), overloaded(), (context) => f.reply(`Fictional backup answer ${context.messages.length}`)]);
  const result = h.respond(f.request("fictional-first", "A"), { append: async () => {} });
  // Same-model transport retries inside the attempt are unchanged; only the
  // configured backup model (router failover) is absent on the prepared route.
  if (enabled) {
    await expect(result).rejects.toMatchObject({ message: expect.stringContaining("overloaded") });
    expect(f.transport.mock.calls.every(([model]) => model.id === "A")).toBe(true);
  } else {
    expect((await result).text).toContain("Fictional backup answer");
    expect(f.transport.mock.calls.at(-1)?.[0].id).toBe("B");
  }
}, 60_000); // Real in-attempt transport backoff dominates; ~8-10s locally.

it("a cancel during first-turn preparation is reported and never appended", async () => {
  const f = await fixture(), controller = new AbortController();
  const h = await f.make((runtime) => runtime.prepareNativeDispatch === undefined ? runtime : { ...runtime,
    prepareNativeDispatch: async (prompt, options) => { controller.abort("Fictional cancel during preparation"); return await runtime.prepareNativeDispatch!(prompt, options); } });
  const preparation = vi.spyOn(f.getStore(), "beginProviderSessionPreparation");
  await expect(h.respond(f.request("fictional-first", "A", controller.signal), { append: async () => {} })).rejects.toBeDefined();
  expect(preparation).toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  expect((await f.record())?.messages ?? []).toEqual([]);
  expect(await f.getStore().load("web:fictional-thread")).toEqual([]);
});

// A prepared lease defers P2 admission. Its advisory in-process warm mapping
// must not physically retire the still-current unguarded (v3) native journal.
it.each([false, true])("consecutive persisted Web turns retain the current journal without retirement (opt-in=%s)", async (enabled) => {
  const f = await fixture({ enabled }), h = await f.make();
  f.faux.setResponses([f.reply("Fictional seed answer"), f.reply("Fictional second answer")]);
  await h.respond(f.request("fictional-seed", "A"), { append: async () => {} });
  const header = (await f.journalRecords()).find((row) => typeof row.journalId === "string" && typeof row.id === "string")!;
  const path = join(f.root, "native", "mono-v2", "journals", `${header.journalId}.jsonl`), before = await readFile(path);
  const retire = vi.spyOn(JsonlSessionRepo.prototype, "retireByHandle"), remove = vi.spyOn(JsonlSessionRepo.prototype, "delete");
  const second = await h.respond(f.request("fictional-second", "A"), { append: async () => {} });
  expect(second.text).toBe("Fictional second answer"); expect(f.transport).toHaveBeenCalledTimes(2);
  expect((await readFile(path)).subarray(0, before.length)).toEqual(before);
  expect(retire.mock.calls.filter(([id]) => id === header.id)).toEqual([]);
  expect(remove.mock.calls.filter(([metadata]) => metadata.id === header.id)).toEqual([]);
  const canonical = await f.record(); expect(canonical.messages).toHaveLength(4);
  expect(canonical.messages.filter((message: { role: string }) => message.role === "assistant").map((message: { content: string }) => message.content)).toEqual(["Fictional seed answer", "Fictional second answer"]);
}, 20_000);
it("fresh responder reopens the retained opt-in journal for the next persisted Web turn", async () => {
  const f = await fixture(), first = await f.make();
  f.faux.setResponses([f.reply("Fictional seed answer"), f.reply("Fictional reopened answer")]);
  await first.respond(f.request("fictional-seed", "A"), { append: async () => {} });
  const header = (await f.journalRecords()).find((row) => typeof row.journalId === "string" && typeof row.id === "string")!;
  const path = join(f.root, "native", "mono-v2", "journals", `${header.journalId}.jsonl`), before = await readFile(path);
  await (first as AgentResponder & { dispose(): Promise<void> }).dispose();
  const retire = vi.spyOn(JsonlSessionRepo.prototype, "retireByHandle"), remove = vi.spyOn(JsonlSessionRepo.prototype, "delete"), reopened = await f.make();
  expect((await reopened.respond(f.request("fictional-second", "A"), { append: async () => {} })).text).toBe("Fictional reopened answer");
  expect(f.transport).toHaveBeenCalledTimes(2); expect((await readFile(path)).subarray(0, before.length)).toEqual(before);
  expect(retire.mock.calls.filter(([id]) => id === header.id)).toEqual([]); expect(remove.mock.calls.filter(([metadata]) => metadata.id === header.id)).toEqual([]);
  expect((await f.record()).messages).toHaveLength(4);
}, 20_000);
it("a second same-model persisted Web turn after a v5 switch keeps the single current journal", async () => {
  const f = await fixture(), h = await f.make();
  f.faux.setResponses([f.reply("Fictional A answer"), f.reply(summary), f.reply("Fictional B answer"), f.reply("Fictional second B answer")]);
  await h.respond(f.request("fictional-seed", "A"), { append: async () => {} });
  await h.respond(f.request("fictional-switch", "B"), { append: async () => {} });
  const before = await f.record(); expect(before.version).toBe(5);
  const journals = join(f.root, "native", "mono-v2", "journals"), [current] = (await readdir(journals)).filter((name) => name.endsWith(".jsonl"));
  const currentBytes = await readFile(join(journals, current!));
  const retire = vi.spyOn(JsonlSessionRepo.prototype, "retireByHandle"), remove = vi.spyOn(JsonlSessionRepo.prototype, "delete");
  expect((await h.respond(f.request("fictional-second-b", "B"), { append: async () => {} })).text).toBe("Fictional second B answer");
  expect((await readdir(journals)).filter((name) => name.endsWith(".jsonl"))).toEqual([current]);
  expect((await readFile(join(journals, current!))).subarray(0, currentBytes.length)).toEqual(currentBytes);
  expect(retire).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  const after = await f.record(); expect(after.messages).toHaveLength(6); expect(after.lastSwitch).toEqual(before.lastSwitch);
  expect(f.transport).toHaveBeenCalledTimes(4); expect(f.summaryCalls()).toBe(1); // only the A -> B handoff
}, 20_000);
