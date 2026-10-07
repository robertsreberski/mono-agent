import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createHandoffBudget } from "@mono-agent/harness";
import { generatePiNativeResponse } from "../../ai/providers/pi-native.js";
import { refreshProviderSession } from "../../ai/runtime/sessions.js";
import { createPiSessionAdapter, createHarnessAdapter } from "../../ai/providers/pi-native/harness-adapter.js";
import { JsonlSessionRepo } from "@mono-agent/harness/session-store.js";

const roots = [];
afterEach(async () => { await refreshProviderSession(handle); for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
const handle = "a".repeat(64);
const hostAuthority = { version: 1, canonicalVersion: 4, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" };
const coverage = { version: 1, sources: [{ journalId: "retained-A", sourceTipId: "frozen-tip", sourceSeq: 7, sourceDigest: "3".repeat(64) }] };
const inherited = { messages: [{ role: "user", content: "Historical handoff: Morgan chose amber; approval remains read-only; unknown effect requires checking.", timestamp: 1 }], coverage };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "native-projection-")); roots.push(root);
  const faux = fauxProvider({ provider: "faux", models: [{ id: "projection", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
  const assertCurrent = vi.fn(async () => {});
  const options = (turn = 1, extra = {}) => ({ model: { provider: model.provider, model: model.id, reference: `${model.provider}:${model.id}` },
    piResolvedModel: model, piResolvedModels: models, effort: "none", allowedTools: [],
    sessionId: handle, providerSessionId: handle, sessionKeepAlive: true, piSessionsRoot: root,
    sessionTurn: { kind: "host", ownerKey: hostAuthority.ownerKey, historyBucket: hostAuthority.historyBucket, turnId: `turn-${turn}`, handleId: handle, baseRevision: turn - 1,
      reconciliation: { version: 1, purpose: "execution", fenceDigest: "c".repeat(64), initialInputId: `input-${turn}` } },
    nativeSessionAuthority: { version: 1, currentHandleId: handle, hostAuthority, assertCurrent },
    nativeSessionProjection: { version: 1, artifact: { id: "4".repeat(64), hash: "5".repeat(64) }, inherited },
    messages: [{ role: "user", content: `current-${turn}` }], ...extra });
  return { root, faux, model, models, options, assertCurrent };
}
async function journal(root) {
  const directory = join(root, "mono-v2/journals");
  const name = (await readdir(directory)).find((name) => name.endsWith(".jsonl"));
  return (await readFile(join(directory, name), "utf8")).trim().split("\n").map(JSON.parse);
}

it("creates only an authorized current guarded handle and dispatches inherited + current delta on true warm/cold resumes without seeding copies", async () => {
  const f = await setup(), requests = [];
  f.faux.setResponses(Array.from({ length: 3 }, (_, index) => (context) => {
    requests.push(structuredClone(context)); return fauxAssistantMessage([fauxText(`reply-${index + 1}`)]);
  }));
  for (let turn = 1; turn <= 3; turn++) {
    if (turn === 3) await refreshProviderSession(handle);
    const result = await generatePiNativeResponse("Current fictional rules", f.options(turn));
    expect(result.error).toBeNull(); expect(result.text).toBe(`reply-${turn}`);
  }
  expect(requests).toHaveLength(3);
  for (const [index, request] of requests.entries()) {
    const wire = JSON.stringify(request);
    expect(wire.match(/Morgan chose amber/g)).toHaveLength(1);
    expect(wire).toContain(`current-${index + 1}`);
    if (index > 0) expect(wire).toContain(`reply-${index}`);
  }
  const records = await journal(f.root);
  expect(records[0]).toMatchObject({ ownershipSchemaVersion: 2, hostAuthority });
  expect(JSON.stringify(records)).not.toContain("Morgan chose amber");
  expect(records.filter((record) => record.kind === "message" && record.payload.message.role === "user")).toHaveLength(3);
  expect(f.assertCurrent.mock.calls.some(([request]) => request.action === "create")).toBe(true);
});

it.each(["predecessor", "lost-claim", "projection-without-authority", "foreign-header"])("refuses %s before provider dispatch or mutation", async (variant) => {
  const f = await setup(), provider = vi.fn(() => fauxAssistantMessage([fauxText("not admitted")])); f.faux.setResponses([provider]);
  let opts = f.options();
  if (variant === "predecessor") opts.nativeSessionAuthority.currentHandleId = "b".repeat(64);
  if (variant === "lost-claim") f.assertCurrent.mockRejectedValue(new Error("Ownership lost"));
  if (variant === "projection-without-authority") delete opts.nativeSessionAuthority;
  let before;
  if (variant === "foreign-header") {
    const repo = new JsonlSessionRepo({ sessionsRoot: f.root }), raw = await repo.create({ id: handle, hostAuthority: { ...hostAuthority, authorityId: "9".repeat(64) }, assertOwned: async () => {} });
    await raw.close(); before = await journal(f.root);
  }
  const result = await generatePiNativeResponse("Current fictional rules", opts);
  expect(result.failureKind).toBe("safety_native_session_authority"); expect(result.retryable).toBe(false); expect(provider).not.toHaveBeenCalled();
  if (before) expect(await journal(f.root)).toEqual(before);
});

it.each(["host_cap", "input_allowance", "mandatory_history"])("fails frozen %s with zero provider/summary calls and no compaction repair", async (reason) => {
  const f = await setup(), provider = vi.fn(() => fauxAssistantMessage([fauxText("must not dispatch")])); f.faux.setResponses([provider]);
  const budget = createHandoffBudget({ contextWindow: 100000, outputReserve: 2000, inputTokens: 100, hostContext: { systemPrompt: "Short rules", tools: [] } });
  let systemPrompt = "Short rules", opts = f.options();
  opts.nativeSessionProjection.dispatchBudget = budget;
  if (reason === "host_cap") systemPrompt = "x".repeat(60000);
  if (reason === "input_allowance") opts.messages = [{ role: "user", content: "x".repeat(600) }];
  if (reason === "mandatory_history") opts.nativeSessionProjection.inherited = { ...inherited, messages: [{ role: "user", content: "x".repeat(250000), timestamp: 1 }] };
  const result = await generatePiNativeResponse(systemPrompt, opts);
  expect(result.error).toContain(`Handoff dispatch budget exceeded: ${reason}`);
  expect(result.failureKind).toBe("safety_handoff_dispatch_budget"); expect(provider).not.toHaveBeenCalled();
  expect((await journal(f.root)).filter((record) => record.kind === "compaction")).toHaveLength(0);
});

it("checks fitting normalized dispatch and pins the frozen output reserve", async () => {
  const f = await setup(), requests = [];
  f.faux.setResponses([(context, options) => { requests.push({ context, options }); return fauxAssistantMessage([fauxText("accepted")]); }]);
  const budget = createHandoffBudget({ contextWindow: 100000, outputReserve: 2000, inputTokens: 100, hostContext: { systemPrompt: "Short rules", tools: [] } });
  const opts = f.options(); opts.nativeSessionProjection.dispatchBudget = budget;
  expect((await generatePiNativeResponse("Short rules", opts)).text).toBe("accepted");
  expect(requests[0].options.maxTokens).toBe(2000);
});

it("compacts the composed view, records inherited coverage and reopens without duplicating its prefix", async () => {
  const f = await setup(), repo = new JsonlSessionRepo({ sessionsRoot: f.root });
  let raw = await repo.create({ id: handle, hostAuthority, assertOwned: async () => {} });
  raw.enableVersion3Writes({ exclusiveWriters: true, hostAuthority });
  const session = createPiSessionAdapter(raw); session.setInheritedProjection(inherited);
  const driver = await createHarnessAdapter(session, { model: f.model, models: f.models, systemPrompt: "Rules", tools: [], inheritedProjection: inherited });
  let seen;
  driver.on("session_before_compact", (event) => {
    seen = event.branchEntries;
    return { compaction: { summary: "Morgan chose amber; no approval; check unknown effects.", tokensBefore: 100, retainedTail: [] } };
  });
  await driver.compact();
  expect(JSON.stringify(seen)).toContain("Historical handoff");
  const context = await session.buildContext(); expect(context.messages).toHaveLength(1); expect(context.messages[0].role).toBe("compactionSummary");
  await driver.close();
  const records = await journal(f.root), checkpoint = records.find((record) => record.kind === "compaction");
  expect(checkpoint.schemaVersion).toBe(3); expect(checkpoint.payload.compaction.checkpoint.inheritedCoverage).toEqual(coverage);
  raw = await repo.open((await repo.list())[0]);
  const reopened = createPiSessionAdapter(raw); reopened.setInheritedProjection(inherited);
  expect((await reopened.buildContext()).messages).toEqual(context.messages);
  reopened.setInheritedProjection({ ...inherited, coverage: { version: 1, sources: [{ ...coverage.sources[0], sourceDigest: "9".repeat(64) }] } });
  await expect(reopened.buildContext()).rejects.toThrow("coverage");
  await reopened.close();
});

it("refuses a composed cut retaining predecessor envelopes rather than copying them into current evidence", async () => {
  const f = await setup(), repo = new JsonlSessionRepo({ sessionsRoot: f.root }), raw = await repo.create({ id: handle, hostAuthority, assertOwned: async () => {} });
  raw.enableVersion3Writes({ exclusiveWriters: true, hostAuthority });
  const session = createPiSessionAdapter(raw); session.setInheritedProjection(inherited);
  const driver = await createHarnessAdapter(session, { model: f.model, models: f.models, systemPrompt: "Rules", tools: [], inheritedProjection: inherited });
  driver.on("session_before_compact", () => ({ compaction: { summary: "Cannot consume prefix", tokensBefore: 100, retainedTail: inherited.messages } }));
  await expect(driver.compact()).rejects.toThrow("must cover the inherited prefix");
  expect((await journal(f.root)).filter((record) => record.kind === "compaction")).toHaveLength(0);
  await driver.close();
});

it("rejects a stale uncoordinated warm mapping before repairing a newly guarded torn tail", async () => {
  const f = await setup(), provider = vi.fn(() => fauxAssistantMessage([fauxText("legacy first turn")]));
  f.faux.setResponses([provider, provider]);
  const opts = f.options(); delete opts.nativeSessionAuthority; delete opts.nativeSessionProjection;
  expect((await generatePiNativeResponse("Rules", opts)).error).toBeNull();
  const repo = new JsonlSessionRepo({ sessionsRoot: f.root });
  const meta = (await repo.list())[0];
  await repo.upgradeHeader(meta, { hostAuthority, assertOwned: async () => {} });
  await appendFile(meta.path, '{"schemaVersion":3');
  const before = await readFile(meta.path);
  const result = await generatePiNativeResponse("Rules", { ...opts, sessionTurn: { ...opts.sessionTurn, turnId: "turn-2", baseRevision: 1,
    reconciliation: { ...opts.sessionTurn.reconciliation, initialInputId: "input-2" } } });
  expect(result.failureKind).toBe("safety_native_session_authority"); expect(provider).toHaveBeenCalledOnce();
  expect(await readFile(meta.path)).toEqual(before);
});

it("denies current-handle creation before publishing a guarded header", async () => {
  const f = await setup(), provider = vi.fn(() => fauxAssistantMessage([fauxText("not admitted")])); f.faux.setResponses([provider]);
  f.assertCurrent.mockImplementation(async ({ action }) => { if (action === "create") throw new Error("Creation is not authorized"); });
  const result = await generatePiNativeResponse("Rules", f.options());
  expect(result.failureKind).toBe("safety_native_session_authority"); expect(provider).not.toHaveBeenCalled();
  const names = await readdir(join(f.root, "mono-v2/journals")).catch((error) => { if (error.code !== "ENOENT") throw error; return []; });
  expect(names.filter((name) => name.endsWith(".jsonl"))).toEqual([]);
});
