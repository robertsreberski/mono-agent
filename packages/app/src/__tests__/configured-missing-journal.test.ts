// Opt-in prepared turns whose current native journal disappeared externally
// (deleted, moved machine, partial restore). Real public config path, Web-shaped
// persisted IDs, Codex-shaped faux provider with fictional in-memory OAuth.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { AgentRequestBase, AgentResponder } from "@mono-agent/contracts";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { type MonoRuntimeLike } from "@mono-agent/turn/host/types";
import { createConfiguredAgentResponderForApp } from "../composition/configured-agent.js";
import { wrapOwnedConfiguredRuntime } from "../composition/runtime-ownership.js";
import { createRequestModelOverrideRuntimeExtension } from "../composition/request-model-override.js";
import { loadAppCoreConfig } from "../composition/app-config.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const provider = "openai-codex", api = "openai-codex-responses";
const token = (account: string) => `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.fixture`;
const ref = (id: string) => ({ provider, model: id, reference: `${provider}:${id}` });
const isSummary = (context: unknown) => JSON.stringify(context).includes("Summarize historical evidence");
type Responder = AgentResponder & { dispose(): Promise<void> };

async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), "app-missing-journal-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const nativeRoot = join(root, "native"), identityPath = join(root, "IDENTITY.md");
  await writeFile(identityPath, "Fictional stable instructions");
  const credential = { type: "oauth", accountId: "fictional-account", access: token("fictional-account"), refresh: "fictional-refresh", expires: Date.now() + 86_400_000 };
  const definitions = [{ id: "A", api, contextWindow: 1_000_000, maxTokens: 4096 }, { id: "B", api, contextWindow: 100_000, maxTokens: 4096 }] as unknown as NonNullable<NonNullable<Parameters<typeof fauxProvider>[0]>["models"]>;
  const faux = fauxProvider({ provider, api, models: definitions, tokensPerSecond: 1_000_000 });
  const transport = vi.spyOn(faux.provider, "streamSimple");
  const models = createModels({ credentials: { read: async () => ({ ...credential }), list: async () => [provider], delete: async () => {}, modify: async () => ({ ...credential }) } as never });
  models.setProvider({ ...faux.provider, auth: { oauth: { refresh: async () => ({ ...credential }), toAuth: (value: { access: string }) => ({ apiKey: value.access }) } } } as never);
  const configPath = join(root, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify({
    runtime: { model: "pi:openai-codex:gpt-5.5", workspace: root, maxTurns: 4,
      session: { root: nativeRoot, mode: "continuous", idleTimeoutMs: 600000, rollover: "none", modelSwitch: enabled ? { enabled: true } : { enabled: false } } },
    providers: { piNative: {} }, context: { identityPath, selectedSkills: [] }, tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(root, "artifacts") }, traceability: { registryDir: join(root, "trace") },
  }));
  const loaded = await loadAppCoreConfig({ cwd: root, configPath, env: {} });
  const config = { ...loaded, runtime: { ...loaded.runtime, model: ref("A") } };
  const leaseRuns: string[] = [], preparedProbes: string[] = [];
  const runtimeFor = (id: string): MonoRuntimeLike => {
    const raw = createMonoRuntime({ workspace: root });
    const run = raw.run.bind(raw), prepare = raw.prepareNativeDispatch!.bind(raw);
    raw.run = (prompt, runOptions) => run(prompt, { ...runOptions, piResolvedModel: faux.getModel(id), piResolvedModels: models });
    raw.prepareNativeDispatch = async (prompt, runOptions) => {
      preparedProbes.push(id);
      const lease = await prepare(prompt, { ...runOptions, piResolvedModel: faux.getModel(id), piResolvedModels: models });
      return { ...lease, run: (binding) => { leaseRuns.push(id); return lease.run(binding); } };
    };
    const owned = wrapOwnedConfiguredRuntime(raw, config, root, undefined); cleanup.push(() => owned.disposeAllSessions!()); return owned;
  };
  const make = async (): Promise<Responder> => {
    const responder = await createConfiguredAgentResponderForApp({ config, cwd: root, runtime: runtimeFor("A"),
      runtimeForModel: (selected) => runtimeFor(selected.model), runtimeOptionsForRequest: createRequestModelOverrideRuntimeExtension({ baseModel: ref("A") }),
      runtimeOptions: { piResolvedModels: models, piMaxRetries: 0, compaction: { enabled: false } } }, { sessionRollover: "none" }) as Responder;
    cleanup.push(() => responder.dispose()); return responder;
  };
  const request = (id: string | undefined, model: string): AgentRequestBase => ({ conversationId: "web:fictional-thread",
    text: `Fictional input ${id ?? "wake"}`, abortSignal: new AbortController().signal,
    metadata: { source: "web", web: id === undefined ? { trigger: "job" } : { threadId: "fictional-thread", model: `${provider}:${model}`, userMessageId: id }, tui: { requestId: randomUUID() } } });
  /** Streamed warning kinds plus the returned response (or typed failure). */
  const send = async (responder: Responder, id: string | undefined, model: string) => {
    const streamed: string[] = [];
    try {
      const response = await responder.respond(request(id, model), { append: async () => {}, event: async (event: { warningKind?: string }) => { if (event.warningKind) streamed.push(event.warningKind); } } as never);
      return { text: response.text, streamed, returned: ((response.metadata?.runtime as { runtimeWarnings?: { warning_kind: string; message: string }[] } | undefined)?.runtimeWarnings ?? []) };
    } catch (error) {
      return { failure: (error as { failure?: { kind?: string } }).failure?.kind ?? (error as Error).name, streamed, returned: [] };
    }
  };
  const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);
  const record = async () => {
    for (const name of (await readdir(join(root, "history"))).filter((entry) => entry.endsWith(".history.json"))) {
      const value = JSON.parse(await readFile(join(root, "history", name), "utf8")); if (value.conversationId === "web:fictional-thread") return value;
    }
    return undefined;
  };
  const journals = join(nativeRoot, "journals");
  const contexts = () => transport.mock.calls.map(([, context]) => JSON.stringify(context.messages));
  return { root, faux, transport, leaseRuns, preparedProbes, make, send, reply, record, journals, contexts, summaryCalls: () => transport.mock.calls.filter(([, context]) => isSummary(context)).length };
}
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const ownJournals = async (directory: string) => (await readdir(directory)).filter((name) => name.endsWith(".jsonl") && !(name in foreign));
const summary = JSON.stringify({ intent: ["Fictional objective"], constraints: [], decisions: [], completedWork: [], failures: [], openWork: [], nextActions: [], references: [] });

it("v3: a deleted current journal recovers on canonical replay with one dispatch and one warning; the next turn is warm on the new epoch", async () => {
  const f = await fixture(), first = await f.make();
  f.faux.setResponses([f.reply("Fictional seed answer"), f.reply("Fictional recovered answer"), f.reply("Fictional warm answer")]);
  await f.send(first, "fictional-seed", "A");
  const before = await f.record(); expect(before.version).toBe(3);
  for (const name of await readdir(f.journals)) await unlink(join(f.journals, name));
  await first.dispose();
  const reopened = await f.make(), recovered = await f.send(reopened, "fictional-after-loss", "A");
  expect(recovered.text).toBe("Fictional recovered answer");
  expect(recovered.streamed).toEqual(["degraded_native_context"]);
  expect(recovered.returned).toEqual([expect.objectContaining({ warning_kind: "degraded_native_context", message: expect.stringContaining("was missing") })]);
  expect(f.transport).toHaveBeenCalledTimes(2); expect(f.leaseRuns).toEqual(["A", "A"]);
  // Canonical replay floor, seeded exactly once into the fresh epoch.
  const replay = f.contexts()[1]!;
  expect(occurrences(replay, "Fictional input fictional-seed")).toBe(1); expect(occurrences(replay, "Fictional seed answer")).toBe(1);
  const after = await f.record();
  expect(after.providerSession.epoch).not.toBe(before.providerSession.epoch); expect(after.providerSession.revision).toBe(1);
  expect(after.messages).toHaveLength(4);
  const warm = await f.send(reopened, "fictional-warm", "A");
  expect(warm).toMatchObject({ text: "Fictional warm answer", streamed: [], returned: [] });
  const next = await f.record();
  expect(next.providerSession.epoch).toBe(after.providerSession.epoch); expect(next.providerSession.revision).toBe(2);
  // Warm resume: prior turns come from the journal once, never reseeded twice.
  expect(occurrences(f.contexts()[2]!, "Fictional input fictional-seed")).toBe(1);
  expect(occurrences(f.contexts()[2]!, "Fictional recovered answer")).toBe(1);
  expect(next.messages).toHaveLength(6);
}, 20_000);

it("v5: a deleted current journal after a switch recovers same-model on canonical replay; the switch receipt is untouched", async () => {
  const f = await fixture(), first = await f.make();
  f.faux.setResponses([f.reply("Fictional A answer"), f.reply(summary), f.reply("Fictional B answer"), f.reply("Fictional recovered B answer"), f.reply("Fictional warm B answer")]);
  await f.send(first, "fictional-seed", "A"); await f.send(first, "fictional-switch", "B");
  const before = await f.record(); expect(before.version).toBe(3);
  const [current] = await ownJournals(f.journals); expect(await ownJournals(f.journals)).toHaveLength(1);
  await unlink(join(f.journals, current!));
  await first.dispose();
  const reopened = await f.make(), recovered = await f.send(reopened, "fictional-after-loss", "B");
  expect(recovered.text).toBe("Fictional recovered B answer");
  expect(recovered.streamed).toEqual(["degraded_native_context"]); expect(recovered.returned).toHaveLength(1);
  expect(f.transport).toHaveBeenCalledTimes(4); expect(f.summaryCalls()).toBe(1); // only the A -> B handoff
  const replay = f.contexts()[3]!;
  expect(occurrences(replay, "Fictional input fictional-seed")).toBe(1); expect(occurrences(replay, "Fictional B answer")).toBe(1);
  expect(replay).not.toContain("Historical handoff");
  const after = await f.record();
  expect(after.lastSwitch).toEqual(before.lastSwitch); expect(after.providerSession.modelKey).toBe("openai-codex:B");
  expect(after.providerSession.epoch).not.toBe(before.providerSession.epoch); expect(await ownJournals(f.journals)).toHaveLength(1);
  const warm = await f.send(reopened, "fictional-warm", "B");
  expect(warm).toMatchObject({ text: "Fictional warm B answer", streamed: [], returned: [] });
  expect((await f.record()).providerSession).toMatchObject({ epoch: after.providerSession.epoch, revision: 2 });
  expect(occurrences(f.contexts()[4]!, "Fictional input fictional-seed")).toBe(1);
}, 20_000);

it("a native-bound no-ID wake whose current journal is missing recovers through the same owned boundary", async () => {
  const f = await fixture(), h = await f.make();
  f.faux.setResponses([f.reply("Fictional A answer"), f.reply(summary), f.reply("Fictional B answer"), f.reply("Fictional wake answer")]);
  await f.send(h, "fictional-seed", "A"); await f.send(h, "fictional-switch", "B");
  const before = await f.record();
  for (const name of await ownJournals(f.journals)) await unlink(join(f.journals, name));
  const woke = await f.send(h, undefined, "B");
  expect(woke.text).toBe("Fictional wake answer"); expect(woke.streamed).toEqual(["degraded_native_context"]);
  const after = await f.record();
  expect(after.lastSwitch).toEqual(before.lastSwitch);
  expect(after.providerSession.modelKey).toBe("openai-codex:B"); expect(after.messages).toHaveLength(6);
  expect(f.leaseRuns.at(-1)).toBe("B"); expect(occurrences(f.contexts()[3]!, "Fictional input fictional-seed")).toBe(1);
}, 20_000);

it("a switch request whose current journal is missing summarizes canonical history through the same handoff order", async () => {
  const f = await fixture(), h = await f.make();
  f.faux.setResponses([f.reply("Fictional A answer"), f.reply(summary), f.reply("Fictional B answer"), f.reply(summary), f.reply("Fictional return answer")]);
  await f.send(h, "fictional-seed", "A"); await f.send(h, "fictional-switch", "B");
  const before = await f.record();
  for (const name of await ownJournals(f.journals)) await unlink(join(f.journals, name));
  const returned = await f.send(h, "fictional-return", "A");
  expect(returned.text).toBe("Fictional return answer");
  const after = await f.record();
  expect(after.lastSwitch.switchId).not.toBe(before.lastSwitch.switchId); expect(after.lastSwitch.artifact).toEqual(after.native.projection);
  expect(after.providerSession.modelKey).toBe("openai-codex:A"); expect(await ownJournals(f.journals)).toHaveLength(1);
  // Outgoing B summarizes the canonical evidence; never a summary-less change.
  expect(f.summaryCalls()).toBe(2); expect(f.transport).toHaveBeenCalledTimes(5);
  expect(f.contexts()[3]).toContain("Fictional B answer"); expect(f.leaseRuns.at(-1)).toBe("A");
}, 20_000);

it("a first switch from a v3 conversation whose current journal is missing takes the summary handoff, never a cold replay", async () => {
  const f = await fixture(), h = await f.make();
  f.faux.setResponses([f.reply("Fictional A answer"), f.reply(summary), f.reply("Fictional B answer")]);
  await f.send(h, "fictional-seed", "A");
  for (const name of await readdir(f.journals)) await unlink(join(f.journals, name));
  const switched = await f.send(h, "fictional-switch", "B");
  expect(switched.text).toBe("Fictional B answer"); expect(f.summaryCalls()).toBe(1);
  expect(f.contexts()[1]).toContain("Fictional A answer");
  const after = await f.record(); expect(after.version).toBe(3); expect(after.providerSession.modelKey).toBe("openai-codex:B");
  expect(await ownJournals(f.journals)).toHaveLength(1);
}, 20_000);

it.each([
  ["v3 header", 3, (lines: string[]) => ["{not json", ...lines.slice(1)]],
  ["v3 record", 3, (lines: string[]) => [...lines.slice(0, 2), "{\"broken\":", ...lines.slice(3)]],
  ["v5 record", 5, (lines: string[]) => [...lines.slice(0, 2), "{\"broken\":", ...lines.slice(3)]],
  ["v5 record on a switch", 5, (lines: string[]) => [...lines.slice(0, 2), "{\"broken\":", ...lines.slice(3)]],
] as const)("an unreadable %s current journal fails closed with a typed refusal, never as missing", async (kind, version, corrupt) => {
  const f = await fixture(), h = await f.make();
  f.faux.setResponses([f.reply("Fictional A answer"), f.reply(summary), f.reply("Fictional B answer"), f.reply("Fictional never answer")]);
  await f.send(h, "fictional-seed", "A"); if (version === 5) await f.send(h, "fictional-switch", "B");
  const before = await f.record(), current = (await ownJournals(f.journals))[0]!;
  const bytes = corrupt((await readFile(join(f.journals, current), "utf8")).split("\n")).join("\n");
  await writeFile(join(f.journals, current), bytes);
  const calls = f.transport.mock.calls.length;
  const refused = await f.send(h, "fictional-after-corruption", version === 5 && !kind.endsWith("switch") ? "B" : "A");
  expect(refused).toMatchObject({ failure: "native_journal_unreadable", streamed: [] });
  expect(f.transport).toHaveBeenCalledTimes(calls);
  expect((await readdir(join(f.root, "history"))).some((name) => name.startsWith(".native-history-op"))).toBe(false);
  expect(await readFile(join(f.journals, current), "utf8")).toBe(bytes);
  expect(await f.record()).toEqual(before);
}, 20_000);

it("v3: a staged-only restore of the current journal refuses typed and is never rotated or reclaimed", async () => {
  const f = await fixture(), first = await f.make();
  f.faux.setResponses([f.reply("Fictional seed answer"), f.reply("Fictional never answer")]);
  await f.send(first, "fictional-seed", "A");
  const before = await f.record(), [name] = (await readdir(f.journals)).filter((entry) => entry.endsWith(".jsonl"));
  const staged = join(f.journals, `${name}.upgrading`), bytes = await readFile(join(f.journals, name!));
  await first.dispose(); await rename(join(f.journals, name!), staged);
  const reopened = await f.make(), calls = f.transport.mock.calls.length;
  expect(await f.send(reopened, "fictional-after-partial-restore", "A")).toMatchObject({ failure: "native_journal_unreadable", streamed: [] });
  expect(f.transport).toHaveBeenCalledTimes(calls); expect(await f.record()).toEqual(before);
  expect(await readFile(staged)).toEqual(bytes); expect(await readdir(f.journals)).toEqual([`${name}.upgrading`]);
}, 20_000);

// Stray non-journal entries are covered at probe level (native-journal-storage
// test): the probe skips them, but the pre-existing native inventory used by
// retention accounting still rejects them for every opt-in turn (recorded limit).
it("deterministic missing-journal recovery ignores and preserves misnamed foreign damage", async () => {
  const f = await fixture(true), first = await f.make();
  f.faux.setResponses([f.reply("Fictional seed answer"), f.reply("Fictional recovered answer")]);
  await f.send(first, "fictional-seed", "A");
  for (const name of await ownJournals(f.journals)) await unlink(join(f.journals, name));
  const damaged = join(f.journals, "11111111-1111-4111-8111-111111111111.jsonl");
  await writeFile(damaged, "", { mode: 0o600 }); await first.dispose();
  const reopened = await f.make();
  expect(await f.send(reopened, "fictional-known-missing", "A")).toMatchObject({ text: "Fictional recovered answer", streamed: ["degraded_native_context"] });
  expect(await readFile(damaged, "utf8")).toBe("");
}, 20_000);

it("OFF keeps the ordinary session-resume replay for a missing journal, without the prepared probe or degradation warning", async () => {
  const f = await fixture(false), first = await f.make();
  f.faux.setResponses([f.reply("Fictional seed answer"), f.reply("Fictional replayed answer")]);
  await f.send(first, "fictional-seed", "A");
  for (const name of await readdir(f.journals)) await unlink(join(f.journals, name));
  await first.dispose();
  const reopened = await f.make(), replayed = await f.send(reopened, "fictional-after-loss", "A");
  expect(replayed.text).toBe("Fictional replayed answer"); expect(replayed.streamed).toEqual(["session_resume_retry"]);
  expect(replayed.returned.some((warning) => warning.warning_kind === "degraded_native_context")).toBe(false);
  expect(f.leaseRuns).toEqual([]); expect(f.preparedProbes).toEqual([]);
  expect(f.transport).toHaveBeenCalledTimes(2); expect((await f.record()).version).toBe(3);
  // Model-switch OFF does not disable default-on cold packs. The historical
  // quotation is legitimate extra evidence, not a second ordinary replay.
  const messages: unknown[] = JSON.parse(f.contexts().at(-1)!);
  const isPack = (message: unknown) => JSON.stringify(message).includes("### Conversation continuity pack");
  const packs = messages.filter(isPack), replay = JSON.stringify(messages.filter(message => !isPack(message)));
  expect(packs).toHaveLength(1);
  expect(occurrences(JSON.stringify(packs), "Fictional input fictional-seed")).toBe(1);
  expect(occurrences(replay, "Fictional input fictional-seed")).toBe(1);
  expect(occurrences(replay, "Fictional seed answer")).toBe(1);
}, 20_000);

// P4 PR E: the journal directory tolerates unrelated entries (shared skip rule).
const strays = { ".DS_Store": "fictional", "notes.txt~": "fictional" };
const foreign = { "11111111-1111-4111-8111-111111111111.jsonl": "", "22222222-2222-4222-8222-222222222222.jsonl": "{not json\n" };
async function plant(directory: string, entries: Record<string, string>) {
  for (const [name, text] of Object.entries(entries)) await writeFile(join(directory, name), text, { mode: 0o600 });
}
async function untouched(directory: string, entries: Record<string, string>) {
  for (const [name, text] of Object.entries(entries)) expect(await readFile(join(directory, name), "utf8")).toBe(text);
}

it.each([true, false])("stray entries never block present or missing journals, and reset leaves them (opt-in=%s)", async (enabled) => {
  const f = await fixture(enabled), first = await f.make();
  f.faux.setResponses([f.reply("Fictional seed answer"), f.reply("Fictional present answer"), f.reply("Fictional recovered answer")]);
  await f.send(first, "fictional-seed", "A");
  await plant(f.journals, strays); await mkdir(join(f.journals, "scratch"));
  await first.dispose();
  const reopened = await f.make();
  expect(await f.send(reopened, "fictional-present", "A")).toMatchObject({ text: "Fictional present answer", streamed: [] });
  for (const name of await ownJournals(f.journals)) await unlink(join(f.journals, name));
  const recovered = await f.send(reopened, "fictional-after-loss", "A");
  expect(recovered.text).toBe("Fictional recovered answer");
  expect(recovered.streamed).toEqual([enabled ? "degraded_native_context" : "session_resume_retry"]);
  await (reopened as unknown as { startNewSession(id: string): Promise<void> }).startNewSession("web:fictional-thread");
  await untouched(f.journals, strays); expect((await readdir(join(f.journals, "scratch")))).toEqual([]);
}, 20_000);

it.each([true, false])("misnamed foreign damage blocks neither present nor deterministically missing journals and is never deleted (opt-in=%s)", async (enabled) => {
  const f = await fixture(enabled), first = await f.make();
  f.faux.setResponses([f.reply("Fictional seed answer"), f.reply("Fictional present answer"), f.reply("Fictional later answer")]);
  await f.send(first, "fictional-seed", "A"); await plant(f.journals, foreign);
  await first.dispose();
  const reopened = await f.make();
  expect(await f.send(reopened, "fictional-present", "A")).toMatchObject({ text: "Fictional present answer", streamed: [] });
  for (const name of await ownJournals(f.journals)) await unlink(join(f.journals, name));
  const calls = f.transport.mock.calls.length;
  expect(await f.send(reopened, "fictional-after-loss", "A")).toMatchObject({ text: "Fictional later answer", streamed: [enabled ? "degraded_native_context" : "session_resume_retry"] });
  expect(f.transport).toHaveBeenCalledTimes(calls + 1);
  await (reopened as unknown as { startNewSession(id: string): Promise<void> }).startNewSession("web:fictional-thread");
  await untouched(f.journals, foreign);
}, 20_000);
