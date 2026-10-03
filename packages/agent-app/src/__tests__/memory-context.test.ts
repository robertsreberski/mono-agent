import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryLoadOptions } from "@mono-agent/agent-contracts";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { createInMemoryHistoryStore } from "@mono-agent/agent-harness";
import type { RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { describe, expect, it } from "vitest";
import { createConfiguredAgentHarness } from "../configured-agent.js";
import { ensureSharedMemoryRetrieval, type MemoryControllerPort } from "../app-controller-memory.js";
import { formatMemoryProfile, type LabelRecallStore } from "../memory-guidance.js";
import { MemoryRetrievalService, type SharedRecallStore } from "../memory-retrieval.js";

type LabelHit = ReturnType<NonNullable<LabelRecallStore["labelsForEntity"]>>[number];
const fact = (id: string, text: string, overrides: Partial<LabelHit> = {}): LabelHit => ({
  memoryId: id, ordinal: 0, text, type: "note", status: "open", active: true, currentAt: true,
  conflict: false, createdAt: "2026-04-03T10:00:00.000Z",
  label: { v: 1, kind: "fact", entityId: "person:owner", attribution: "user-stated" }, ...overrides,
});
const preference = (id: string, text: string): LabelHit => fact(id, text, {
  label: { v: 1, kind: "preference", scope: "agent", attribution: "user-stated" },
});
function storeFixture(tier: "bujo" | "journal" | "lite" = "bujo") {
  const queries: string[] = [];
  const facts = [fact("owner-fact", "Morgan enjoys sketching geometric patterns.")];
  const guidance = [preference("owner-pref", "Use compact numbered explanations.")];
  let recalledText = "The bicycle repair uses a six millimetre wrench.";
  const store: SharedRecallStore = {
    tier: () => tier, async load() { return undefined; }, async close() {},
    labelsForEntity: (id) => id === "person:owner" ? facts : [],
    guidanceForScope: (scope) => scope === "agent" ? guidance : [],
    async recall(query) {
      queries.push(query);
      return [{ score: 0.9, record: { id: "repair", text: recalledText, type: "note", status: "open" } }];
    },
  };
  return { store, queries, facts, guidance, changeRecall: (text: string) => { recalledText = text; } };
}
const owner = (turnId: string, minutes = 0, retainedContext = false): MemoryLoadOptions => ({
  turnId, ownerTurn: true, retainedContext, hostDate: "2026-04-03", hostLocalDate: "2026-04-03",
  hostInstant: new Date(Date.parse("2026-04-03T10:00:00.000Z") + minutes * 60_000).toISOString(),
});

describe("opt-in volatile memory context", () => {
  it.each(["remember", "details", "partial-details"])("preserves pending warm invocation receipts across %s query invalidation", async (write) => {
    const f = storeFixture();
    f.store.supportsRemember = () => true;
    f.store.supportsRememberDetails = () => true;
    f.store.remember = async (_conversationId, text) => ({ id: "written", source: "memory", text, duplicate: false });
    f.store.rememberDetails = async (_conversationId, text) => {
      if (write === "partial-details") throw Object.assign(new Error("fictional partial projection"), { rememberIntentWritten: true });
      return { id: "written", source: "memory", text, duplicate: false };
    };
    const service = new MemoryRetrievalService(f.store, { profileEnabled: true });
    const query = "Describe the ceramic glaze materials";
    await service.load("conversation", query, owner("cold"));
    service.recordInvocation("cold");
    f.changeRecall("The ceramic glaze uses a fictional cobalt pigment.");
    expect((await service.load("conversation", query, owner("warm", 1, true)))?.content).toContain("fictional cobalt");
    if (write === "remember") await service.remember("conversation", "Morgan enjoys geometric sketches.");
    else if (write === "details") await service.rememberDetails("conversation", "Morgan enjoys geometric sketches.", {});
    else await expect(service.rememberDetails("conversation", "Morgan enjoys geometric sketches.", {})).rejects.toThrow("fictional partial projection");
    const before = f.queries.length;
    await service.recallOutcomeForTurn("warm", query);
    expect(f.queries).toHaveLength(before + 1); // Stale searches really were invalidated.
    service.recordInvocation("warm");
    expect(await service.load("conversation", query, owner("next", 2, true))).toBeUndefined();
  });

  it("preserves a receipt prepared after a concurrent Remember invalidates an in-flight lookup", async () => {
    const f = storeFixture();
    f.store.remember = async (_id, text) => ({ id: "written", source: "memory", text, duplicate: false });
    const service = new MemoryRetrievalService(f.store, { profileEnabled: true });
    const query = "Describe the ceramic glaze materials";
    await service.load("conversation", query, owner("cold"));
    service.recordInvocation("cold");
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let pending = true;
    f.store.recall = async () => {
      if (pending) { pending = false; start(); await held; }
      return [{ score: 0.9, record: { id: "new-glaze", text: "The fictional glaze uses ochre pigment." } }];
    };
    const loading = service.load("conversation", query, owner("warm", 1, true));
    await started;
    await service.remember("other-conversation", "Morgan enjoys geometric sketches.");
    release();
    expect((await loading)?.content).toContain("ochre pigment");
    service.recordInvocation("warm");
    expect(await service.load("conversation", query, owner("next", 2, true))).toBeUndefined();
  });

  it.each([{ profileEnabled: true }, { intentExpiry: true }, { profileEnabled: true, intentExpiry: true }])("fences pre-write graph lookups from fresh expansion caches with %o", async (flags) => {
    const f = storeFixture();
    const hit = (id: string) => ({ score: 0.9, record: { id, text: `Fictional ceramic glaze evidence ${id}.` } });
    const before = [hit("glaze-before-write")];
    const after = [hit("glaze-after-write")];
    let start!: () => void;
    let release!: (hits: typeof before) => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const held = new Promise<typeof before>((resolve) => { release = resolve; });
    let written = false;
    f.store.recall = async (query) => {
      f.queries.push(query);
      if (!written) { start(); return await held; }
      return after;
    };
    f.store.remember = async (_id, text) => {
      written = true;
      return { id: "written", source: "memory", text, duplicate: false };
    };
    f.store.supportsGraphExpansion = () => true;
    const expandedSeeds: string[] = [];
    f.store.expandGraph = async (_query, direct) => {
      const seed = direct[0]!.record.id;
      expandedSeeds.push(seed);
      return [...direct, hit(`${seed}-related`)];
    };
    const service = new MemoryRetrievalService(f.store, flags);
    const query = "Which fictional ceramic glaze is current?";
    const options = { expandHops: 1 as const, trackAccess: false };
    const pending = service.recallOutcomeForTurn("graph-turn", query, options);
    await started;
    await service.remember("conversation", "Morgan uses a fictional ochre glaze.");
    release(before);
    expect((await pending).hits.map((item) => item.record.id)).toEqual(["glaze-before-write", "glaze-before-write-related"]);
    const fresh = await service.recallOutcomeForTurn("graph-turn", query, options);
    expect(fresh.hits.map((item) => item.record.id)).toEqual(["glaze-after-write", "glaze-after-write-related"]);
    expect(await service.recallOutcomeForTurn("graph-turn", query, options)).toEqual(fresh);
    expect(f.queries).toHaveLength(2);
    expect(expandedSeeds).toEqual(["glaze-before-write", "glaze-after-write"]);
  });

  it("uses the observation instant for same-day profile record expiry and preserves inclusive civil dates", async () => {
    const f = storeFixture();
    f.facts.splice(0, f.facts.length,
      fact("ended", "Expired geometric sketch fact.", { validTo: "2026-04-03T09:00:00.000Z" }),
      fact("offset-ended", "Expired offset sketch fact.", { validTo: "2026-04-03T09:00:00+02:00" }),
      fact("today", "The fictional sketch preference remains current today.", { validTo: "2026-04-03" }),
      fact("instant", "The fictional sketch fact is current at its exact boundary.", { validTo: "2026-04-03T10:00:00.000Z" }));
    const service = new MemoryRetrievalService(f.store, { profileEnabled: true });
    const content = (await service.load("conversation", "Which sketches?", owner("expiry")))?.content;
    expect(content).not.toContain("Expired");
    expect(content).toContain("current today");
    expect(content).toContain("exact boundary");
  });

  it("requires actual invocation receipts, suppresses unchanged warm lines, and permits changed sources and cold reseeds", async () => {
    const f = storeFixture();
    const service = new MemoryRetrievalService(f.store, { profileEnabled: true });
    const cold = await service.load("conversation", "Describe bicycle repair components", owner("cold"));
    expect(cold?.content).toContain("Owner profile");
    expect(cold?.content).toContain("six millimetre");
    // Prepared but never invoked cannot prove the provider has anything.
    expect(await service.load("conversation", "Describe bicycle repair components", owner("unreceipted", 1, true))).toBeUndefined();
    service.recordInvocation("cold");
    expect(await service.load("conversation", "Describe bicycle repair components", owner("warm", 2, true))).toBeUndefined();
    f.changeRecall("The bicycle repair now uses an eight millimetre wrench.");
    const changedRecall = await service.load("conversation", "Describe bicycle repair components", owner("changed", 3, true));
    expect(changedRecall?.content).toContain("eight millimetre");
    expect(changedRecall?.content).not.toContain("Owner profile");
    service.recordInvocation("changed");
    f.facts[0] = fact("replaced-source", f.facts[0]!.text);
    expect((await service.load("conversation", "Describe bicycle repair components", owner("source", 4, true)))?.content).toContain("Owner profile");
    expect((await service.load("conversation", "Describe bicycle repair components", owner("reseed", 5)))?.content).toContain("eight millimetre");
  });

  it("bounds served-line receipts conservatively instead of forgetting retained lines", async () => {
    const f = storeFixture();
    const service = new MemoryRetrievalService(f.store, { profileEnabled: true });
    await service.load("conversation", "Which repair components?", owner("cold"));
    service.recordInvocation("cold");
    for (let index = 0; index < 256; index++) {
      f.changeRecall(`Fictional repair component number ${index}.`);
      await service.load("conversation", "Which repair components?", owner(`warm-${index}`, 1, true));
      service.recordInvocation(`warm-${index}`);
    }
    f.changeRecall("A final fictional repair component.");
    expect(await service.load("conversation", "Which repair components?", owner("saturated", 2, true))).toBeUndefined();
    expect((await service.load("conversation", "Which repair components?", owner("reseed", 3)))?.content).toContain("final fictional");
  });

  it("fences late receipts from an abandoned cold epoch", async () => {
    const f = storeFixture();
    const service = new MemoryRetrievalService(f.store, { profileEnabled: true });
    await service.load("conversation", "Which repair components?", owner("abandoned"));
    await service.load("conversation", "Which repair components?", owner("reseed", 1));
    service.recordInvocation("abandoned");
    expect(await service.load("conversation", "Which repair components?", owner("warm", 2, true))).toBeUndefined();
    service.recordInvocation("reseed");
    f.changeRecall("A different fictional component.");
    expect((await service.load("conversation", "Which repair components?", owner("fresh", 3, true)))?.content).toContain("different fictional component");
  });

  it("publishes an empty replacement when all previously served profile sources end", async () => {
    const f = storeFixture();
    const service = new MemoryRetrievalService(f.store, { profileEnabled: true });
    await service.load("conversation", "Which repair components?", owner("cold"));
    service.recordInvocation("cold");
    f.facts.length = 0;
    f.guidance.length = 0;
    expect((await service.load("conversation", "Which repair components?", owner("empty", 1, true)))?.content).toContain("No active supported profile entries.");
    service.recordInvocation("empty");
    expect(await service.load("conversation", "Which repair components?", owner("next", 2, true))).toBeUndefined();
  });

  it("conservatively suppresses on receipt-cache loss while deliberate tools remain available", async () => {
    const f = storeFixture();
    const service = new MemoryRetrievalService(f.store, { profileEnabled: true });
    await service.load("conversation", "Describe bicycle repair components", owner("cold"));
    service.recordInvocation("cold");
    service.resetRecallContext();
    expect(await service.load("conversation", "Describe bicycle repair components", owner("lost", 1, true))).toBeUndefined();
    expect(await service.recallOriginalOutcomeForTurn("lost")).toMatchObject({ available: true });
    expect((await service.load("conversation", "Describe bicycle repair components", owner("reseed", 2)))?.content).toContain("Owner profile");
  });

  it("deduplicates labelled guidance lines as well as similarity lines", async () => {
    const f = storeFixture();
    f.store.recall = async () => [{ score: 0.9, record: { id: "owner-pref", text: f.guidance[0]!.text } }];
    const service = new MemoryRetrievalService(f.store, { profileEnabled: true });
    expect((await service.load("conversation", "Explain the bicycle repair", owner("cold")))?.content).toContain("compact numbered");
    service.recordInvocation("cold");
    expect(await service.load("conversation", "Explain the bicycle repair", owner("warm", 1, true))).toBeUndefined();
  });

  it.each(["throw", "degraded"])("loads profile independently during an embedding %s, with only a stable warning", async (failure) => {
    const f = storeFixture();
    if (failure === "throw") f.store.recall = async () => { throw new Error("FICTIONAL_PRIVATE_RECORD /fictional/private/record.md"); };
    else f.store.recallWithOutcome = async () => ({ hits: [], retrievalMode: "lexical_only", degradation: { code: "embedding_unavailable" } });
    const warnings: string[] = [];
    const service = new MemoryRetrievalService(f.store, { profileEnabled: true });
    const block = await service.load("conversation", "Which material should I use?", { ...owner("outage"), onWarning: (code) => warnings.push(code) });
    expect(block?.content).toContain(f.facts[0]!.text);
    expect(block?.traceContent).toBe(false);
    expect(warnings).toEqual(["memory_recall_unavailable"]);
    expect(JSON.stringify(warnings)).not.toMatch(/FICTIONAL_PRIVATE_RECORD|\/fictional\/private/u);
  });

  it("keeps recall available when the label profile fails with a code-only diagnostic", async () => {
    const f = storeFixture();
    f.store.guidanceForScope = () => { throw new Error("FICTIONAL_PRIVATE_RECORD /fictional/private/record.md"); };
    const warnings: string[] = [];
    const block = await new MemoryRetrievalService(f.store, { profileEnabled: true }).load("conversation", "Which repair components?",
      { ...owner("labels-failed"), onWarning: (code) => warnings.push(code) });
    expect(block?.content).toContain("six millimetre");
    expect(warnings).toEqual(["memory_profile_unavailable"]);
    expect(JSON.stringify(warnings)).not.toMatch(/FICTIONAL_PRIVATE_RECORD|\/fictional\/private/u);
  });

  it("does not duplicate profile source entries in the ordinary block", async () => {
    const f = storeFixture();
    f.store.recall = async () => [{ score: 0.9, record: { id: "owner-fact", text: f.facts[0]!.text } }];
    const block = await new MemoryRetrievalService(f.store, { profileEnabled: true }).load("conversation", "Which sketches do I enjoy?", owner("cold"));
    expect(block?.content.split(f.facts[0]!.text)).toHaveLength(2);
  });

  it.each(["bujo", "lite", "journal"] as const)("preserves disabled flags and the %s compatibility path", async (tier) => {
    const f = storeFixture(tier);
    const baseline = new MemoryRetrievalService(f.store);
    const disabled = new MemoryRetrievalService(f.store, { profileEnabled: false });
    const input = owner("same", 0, true);
    const expected = await baseline.load("conversation", "Describe bicycle repair components", input);
    expect(await disabled.load("conversation", "Describe bicycle repair components", input)).toEqual(expected);
    if (tier !== "bujo") {
      const forced = new MemoryRetrievalService(f.store, { profileEnabled: true });
      expect(await forced.load("conversation", "Describe bicycle repair components", input)).toEqual(expected);
    }
  });
});

describe("deterministic supported profile", () => {
  it("omits ended, conflicting, inferred, other-person, episode and intention entries", () => {
    const rows = [fact("ok", "Morgan enjoys geometric sketches."), fact("ended", "Old text", { active: false }),
      fact("conflict", "Conflicting text", { conflict: true }), fact("past", "Past text", { currentAt: false }),
      fact("episode", "Episode text", { type: "event" }), fact("intention", "Dated intention", { dueAt: "2026-04-04" }),
      fact("done", "Completed intention", { status: "done" }), fact("superseded", "Superseded text", { supersededBy: "ok" }),
      fact("inferred", "Inferred text", { label: { v: 1, kind: "fact", entityId: "person:owner", attribution: "assistant-inferred" } }),
      fact("other", "Avery text", { label: { v: 1, kind: "fact", entityId: "person:avery", attribution: "user-stated" } })];
    const result = formatMemoryProfile({ labelsForEntity: () => rows, guidanceForScope: () => [preference("pref", "Use concise numbered steps.")] }, "2026-04-03");
    expect(result.entries.map((entry) => entry.id)).toEqual(["ok", "pref"]);
    expect(result.content).not.toMatch(/ended|conflict|Past|Episode|intention|Superseded|Inferred|Avery/u);
  });

  it.each(["EN: geometric sketches", "PL: geometryczne szkice", "IT: schizzi geometrici", "ES: bocetos geométricos", "🧩🪁"])("keeps whole entries within 600 code points for %s", (text) => {
    const rows = Array.from({ length: 24 }, (_, index) => fact(`entry-${index.toString().padStart(2, "0")}`, `${index}: ${text.repeat(16)}`));
    const store = { labelsForEntity: () => rows };
    const first = formatMemoryProfile(store, "2026-04-03");
    const reverse = formatMemoryProfile({ labelsForEntity: () => [...rows].reverse() }, "2026-04-03");
    expect(first).toEqual(reverse);
    expect(Array.from(first.content).length).toBeLessThanOrEqual(600);
    expect(first.truncated).toBe(true);
    for (const entry of first.entries) expect(rows.some((row) => row.memoryId === entry.id && row.text === entry.text)).toBe(true);
  });
});

const configFor = (cwd: string, enabled: boolean) => resolveJsonMonoAgentConfig({ cwd, json: {
  runtime: { model: "pi:openai-codex:gpt-5.5", session: { mode: "continuous" } }, context: { identityPath: "IDENTITY.md" },
  tools: { allowedTools: [] },
  memory: { path: "memory", mode: "bujo", embeddings: { provider: "ollama" },
    llm: { provider: "ollama", model: "fictional-local-model" }, recallTool: { enabled: false }, rememberTool: { enabled: false },
    profile: { enabled } },
} });

it("flows config-only arms through configured harness and shared-controller wiring, with invocation-confirmed warm suppression", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-context-"));
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "You are a fictional test assistant.");
    for (const enabled of [false, true]) {
      const f = storeFixture();
      const config = configFor(cwd, enabled);
      const controller = { sharedMemoryRetrieval: undefined } as unknown as MemoryControllerPort;
      const shared = ensureSharedMemoryRetrieval(controller, config, f.store);
      expect(shared).toBeDefined();
      expect((await shared!.load("shared", "Which repair components?", owner("shared")))?.content.includes("Owner profile")).toBe(enabled);
      const calls: RuntimeRunOptions[] = [];
      const events: unknown[] = [];
      const history = createInMemoryHistoryStore();
      const harness = await createConfiguredAgentHarness({ config, cwd, memory: f.store, historyStore: history,
        runtime: { async run(_prompt, options) { calls.push(options); return { text: "Fictional response.", providerSessionId: "fictional-session" }; } },
      });
      try {
        for (const userMessage of ["Which wrench fits the bicycle repair?", "And the size?"]) await harness.run({
          conversationId: "configured", userMessage, captureSpeakerKind: "human-turn", metadata: { source: "web" },
          abortSignal: new AbortController().signal, onEvent: (event) => events.push(event),
        });
        const first = String(calls[0]!.messages!.at(-1)!.content);
        const second = String(calls[1]!.messages!.at(-1)!.content);
        expect(first.includes("Owner profile")).toBe(enabled);
        expect(second).not.toContain("Owner profile");
        expect(second).not.toContain("six millimetre");
        expect(f.queries.at(-1)).toBe("and the size?");
        const traces = events.filter((event) => (event as { type?: string }).type === "turn_context");
        if (enabled) expect(JSON.stringify(traces)).not.toContain("geometric patterns");
        expect(JSON.stringify(await history.load("configured"))).not.toContain("Owner profile");
        await harness.resetConversation!("configured");
        await harness.run({ conversationId: "configured", userMessage: "Which size?", captureSpeakerKind: "human-turn", metadata: { source: "web" }, abortSignal: new AbortController().signal });
        expect(f.queries.at(-1)).toBe("which size?");
      } finally { await harness.dispose!(); }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("preserves shared warm profile receipts across isolated cron", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-isolation-"));
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "You are a fictional test assistant.");
    const f = storeFixture();
    const base = configFor(cwd, true);
    const config = { ...base, runtime: { ...base.runtime, session: { ...base.runtime.session, isolateProactive: true } },
      memory: { ...base.memory!, profile: { enabled: true } } };
    const calls: RuntimeRunOptions[] = [];
    const harness = await createConfiguredAgentHarness({ config, cwd, memory: f.store, historyStore: createInMemoryHistoryStore(),
      runtime: { async run(_prompt, options) { calls.push(options); return { text: "Fictional response.",
        providerSessionId: options.sessionKeepAlive ? "shared-fictional-session" : "isolated-fictional-session" }; } },
    });
    const runOwner = (userMessage: string) => harness.run({ conversationId: "owner-isolation", userMessage,
      captureSpeakerKind: "human-turn", metadata: { source: "web" }, abortSignal: new AbortController().signal });
    try {
      await runOwner("Describe the ceramic glaze materials");
      await runOwner("Describe the ceramic glaze materials");
      await harness.run({ conversationId: "owner-isolation", userMessage: "Fictional scheduled check.", captureSpeakerKind: "trigger",
        metadata: { source: "cron", cron: { jobId: "fictional-check", expression: "0 3 * * *" } }, abortSignal: new AbortController().signal });
      await runOwner("Describe the ceramic glaze materials");
      expect(calls[2]!.sessionId).toBeUndefined();
      expect(calls[3]!.sessionId).toBe("shared-fictional-session");
      expect(String(calls[3]!.messages.at(-1)!.content)).not.toContain("Owner profile");
      expect(String(calls[3]!.messages.at(-1)!.content)).not.toContain("bicycle wrench");
      expect(f.queries.at(-1)).toBe("describe the ceramic glaze materials"); // The current query is never augmented.
      f.facts[0] = fact("owner-fact", "Morgan now enjoys folded paper patterns.");
      f.changeRecall("The ceramic glaze now uses a fictional ochre pigment.");
      await runOwner("Describe the folded paper patterns");
      expect(calls[4]!.sessionId).toBe("shared-fictional-session");
      const final = String(calls[4]!.messages.at(-1)!.content);
      expect(final).toContain("folded paper patterns");
      expect(final).toContain("Owner profile");
      expect(f.queries.at(-1)).toBe("describe the folded paper patterns");
    } finally { await harness.dispose!(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it.each([false, true])("uses attachment evidence only for the current query with profile=%s", async (enabled) => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-attachment-query-"));
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "You are a fictional test assistant.");
    const f = storeFixture();
    const calls: RuntimeRunOptions[] = [];
    const harness = await createConfiguredAgentHarness({ config: configFor(cwd, enabled), cwd, memory: f.store,
      runtime: { async run(_prompt, options) { calls.push(options); return { text: "Fictional response.", providerSessionId: "fictional-session" }; } },
    });
    try {
      await harness.run({ conversationId: "attached", userMessage: "Compare the ceramic glazes.", captureSpeakerKind: "human-turn",
        metadata: { source: "web" }, abortSignal: new AbortController().signal,
        attachments: [{ kind: "document", mimeType: "text/plain", name: "fictional-sample.txt",
          data: Buffer.from("FICTIONAL_DOCUMENT_SENTINEL").toString("base64"), text: "FICTIONAL_DOCUMENT_SENTINEL" }],
      });
      expect(f.queries[0]).toContain("fictional_document_sentinel"); // Current turn still sees one-shot evidence.
      await harness.run({ conversationId: "attached", userMessage: "And now?", captureSpeakerKind: "human-turn",
        metadata: { source: "web" }, abortSignal: new AbortController().signal });
      expect(f.queries.at(-1)).toBe("and now?");
      expect(f.queries.at(-1)).not.toContain("fictional_document_sentinel");
      expect(f.queries.at(-1)).not.toContain("fictional-sample.txt");
      expect(f.queries.at(-1)).not.toContain(cwd.toLowerCase());
    } finally { await harness.dispose!(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("skips memory on host continuation synthesis without losing warm profile receipts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-continuation-"));
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "You are a fictional test assistant.");
    const f = storeFixture();
    const calls: RuntimeRunOptions[] = [];
    const harness = await createConfiguredAgentHarness({ config: configFor(cwd, true), cwd, memory: f.store, historyStore: createInMemoryHistoryStore(),
      runtime: { async run(_prompt, options) { calls.push(options); return { text: "Fictional response.",
        providerSessionId: options.sessionKeepAlive ? "shared-fictional-session" : "synthesis-fictional-session" }; } },
    });
    try {
      const runOwner = (userMessage: string) => harness.run({ conversationId: "continuation", userMessage,
        captureSpeakerKind: "human-turn", metadata: { source: "web" }, abortSignal: new AbortController().signal });
      await runOwner("Describe the ceramic glaze materials");
      await harness.run({ conversationId: "continuation", userMessage: "FICTIONAL_SYNTHESIS_PAYLOAD", abortSignal: new AbortController().signal,
        continuation: { continuationId: "fictional-continuation", originRunId: "fictional-origin", originContextPolicy: "detached_latest",
          toolsDisabled: true, deferHistoryCommit: true } });
      expect(f.queries).toHaveLength(1);
      expect(String(calls[1]!.messages.at(-1)!.content)).not.toContain("Owner profile");
      f.facts[0] = fact("owner-fact", "Morgan now enjoys folded paper patterns.");
      await runOwner("And now?");
      expect(f.queries.at(-1)).toBe("and now?");
      expect(calls[2]!.sessionId).toBe("shared-fictional-session");
      expect(String(calls[2]!.messages.at(-1)!.content)).toContain("folded paper patterns");
    } finally { await harness.dispose!(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
