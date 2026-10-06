import { afterEach, expect, it } from "vitest";
import { lstat, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { ModelSwitchPayloadStore } from "../model-switch-payloads.js";
import type { ModelSwitchStorageOwner } from "../model-switch-payloads.js";
import { createModelSwitchState, admitSummaryAttempt, finishSummaryAttempt, advanceUnfitProducer, authorizeSummaryMessage } from "../model-switch-billing.js";
import { MAX_MODEL_SWITCH_FENCE_BYTES, MODEL_SWITCH_DIRECTORY, canonicalSwitchJSON, switchDigest, serializeModelSwitchState, recognizesModelSwitchBinding, validateModelSwitchState, validateTurnHistoryV4 } from "../durable-model-switch-contract.js";
import type { CanonicalJournalDescriptor, ModelSwitchIdentity, ModelSwitchState, TurnHistoryV4 } from "../durable-model-switch-contract.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const source: CanonicalJournalDescriptor = { journalId: "fictional-journal", epoch: "1".repeat(64), ordinal: 0, handleId: "2".repeat(64), predecessorJournalId: null,
  ownerKey: "fictional-owner", historyBucket: "fictional-conversation", sourceTipId: "fictional-tip", sourceSeq: 4, sourceDigest: "3".repeat(64),
  provenance: { provider: "faux", api: "faux-api", model: "A", account: null } };
const budget = { policy: "mono-handoff-v1", contextWindow: 100000, hostCap: 16384, inputTokens: 100, outputReserve: 2000, safety: 5000, historyAllowance: 76516, hostContextDigest: "4".repeat(64) };
const coordinates: Omit<ModelSwitchIdentity, "switchId"> = { ownerKey: source.ownerKey, historyBucket: source.historyBucket, sourceCanonicalDigest: "4".repeat(64), sourceRevision: 2,
  sources: [source], fromModelKey: "faux:A", toModelKey: "faux:B", targetProvenance: { provider: "faux", api: "faux-api", model: "B", account: null },
  targetEpoch: "5".repeat(64), projectionPolicy: "mono-handoff-v1", timestamp: 17, frozenBudgetDigest: switchDigest(budget) };
function initial(): ModelSwitchState { return createModelSwitchState(coordinates, { canonicalBytes: 8192, artifactBytes: 32768, retainedNativeBytes: 16384, headerCopyBytes: 16384, pendingBytes: 65536 }); }
function proposal(state: ModelSwitchState, producer = "outgoing"): Record<string, unknown> {
  return { version: 1, policy: "mono-handoff-v1", coverage: state.identity.sources.map(({ ordinal, epoch: _epoch, ...entry }) => ({ ...entry, epoch: ordinal })),
    summary: { intent: ["Fictional work"], constraints: ["No deployment approval"], decisions: [], completedWork: [], failures: [], openWork: ["Inspect result"], nextActions: ["Wait"], references: [] },
    checkpoint: null, recent: [{ turnId: "fictional-turn", messages: [{ text: "Latest fictional fact" }] }], ledger: [{ outcome: "unknown", callId: "fictional-call" }], retainedIds: ["fictional-message"],
    producer, timestamp: state.identity.timestamp, target: state.identity.targetProvenance, budget };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mono-switch-storage-")); roots.push(root); const identity = await lstat(root);
  const store = new ModelSwitchPayloadStore(root, identity), state = initial(), reservations: number[] = [], adjustments: number[] = [], phases: string[] = [];
  let rootHeld = false;
  const owner: ModelSwitchStorageOwner = { ownerKey: source.ownerKey, historyBucket: source.historyBucket,
    assertOwned: async () => {}, reserve: async (bytes) => { expect(rootHeld).toBe(true); reservations.push(bytes); },
    adjustReservation: async (bytes) => { expect(rootHeld).toBe(true); adjustments.push(bytes); },
    withRootTransaction: async (action) => { expect(rootHeld).toBe(false); rootHeld = true; try { return await action(); } finally { rootHeld = false; } },
    onPhase: async (phase) => { expect(rootHeld).toBe(true); phases.push(phase); } };
  return { root, store, state, owner, reservations, adjustments, phases, rootHeld: () => rootHeld };
}

it("validates canonical v4 chains/binding/provenance/receipts without changing v3", () => {
  const value: TurnHistoryV4 = { version: 4, conversationId: source.historyBucket, messages: [], providerSession: { epoch: source.epoch, revision: 2, modelKey: "faux:A" },
    native: { authority: { version: 1, canonicalVersion: 4, rootId: "7".repeat(64), authorityId: "8".repeat(64), ownerKey: source.ownerKey, historyBucket: source.historyBucket }, chain: [source], projection: null } };
  expect(() => validateTurnHistoryV4(value, (message) => message as never)).not.toThrow();
  for (const mutation of [
    (copy: any) => { copy.native.chain.push(copy.native.chain[0]); },
    (copy: any) => { copy.native.chain[0].ownerKey = "foreign"; },
    (copy: any) => { copy.native.chain[0].predecessorJournalId = copy.native.chain[0].journalId; },
    (copy: any) => { copy.providerSession.epoch = "9".repeat(64); },
    (copy: any) => { delete copy.native.chain[0].provenance.account; },
    (copy: any) => { copy.deliveryKey = "private transport stand-in"; },
  ]) { const copy = structuredClone(value); mutation(copy); expect(() => validateTurnHistoryV4(copy, (message) => message as never)).toThrow(); }
});

it("binds switch identity to source revision/tips/target provenance and frozen budget", () => {
  const state = initial(); validateModelSwitchState(state);
  const reordered = Object.fromEntries(Object.entries(coordinates).reverse()); expect(createModelSwitchState(reordered as typeof coordinates, state.reservation).identity.switchId).toBe(state.identity.switchId);
  for (const key of ["sourceRevision", "frozenBudgetDigest", "targetEpoch"] as const) {
    const copy = structuredClone(state) as any; copy.identity[key] = key === "sourceRevision" ? 3 : "9".repeat(64); expect(() => validateModelSwitchState(copy)).toThrow();
  }
  expect(() => canonicalSwitchJSON({ hidden: new AbortController() })).toThrow();
  expect(() => createModelSwitchState({ ...coordinates, deliveryKey: "fictional private data" } as any, state.reservation)).toThrow();
});

it("enforces two producers, never repeats an unknown admission, and records message generations idempotently", () => {
  let state = initial();
  expect(() => admitSummaryAttempt(state, "incoming")).toThrow("order");
  state = admitSummaryAttempt(state, "outgoing");
  expect(() => admitSummaryAttempt(state, "outgoing")).toThrow("never automatically repeat");
  state = finishSummaryAttempt(state, "outgoing", "unknown"); expect(state.attempts[0]!.outcome).toBe("started");
  state = advanceUnfitProducer(state); state = admitSummaryAttempt(state, "incoming"); state = finishSummaryAttempt(state, "incoming", "unknown");
  expect(state.phase).toBe("pending"); expect(state.attempts).toHaveLength(2);
  expect(() => admitSummaryAttempt(state, "incoming")).toThrow("never automatically repeat");
  state = authorizeSummaryMessage(state, "a".repeat(64)); expect(state.authorizationGeneration).toBe(1);
  state = admitSummaryAttempt(state, "outgoing"); const before = structuredClone(state);
  expect(authorizeSummaryMessage(state, "a".repeat(64))).toEqual(before);
  expect(() => authorizeSummaryMessage(state, "b".repeat(64))).toThrow("handoff pending");
  state = finishSummaryAttempt(state, "outgoing", "rejected"); state = advanceUnfitProducer(state); state = admitSummaryAttempt(state, "incoming"); state = finishSummaryAttempt(state, "incoming", "rejected");
  expect(state.attempts).toHaveLength(4); expect(authorizeSummaryMessage(state, "a".repeat(64))).toEqual(state);
});

it("reserves canonical/artifact/native-retention/transient-copy capacity BEFORE publishing intent", async () => {
  const { store, state, owner, root, phases, reservations } = await fixture();
  await store.begin(state, owner);
  expect(reservations[0]).toBe(Object.values(state.reservation).reduce((sum, count) => sum + count, 0));
  expect(phases[0]).toBe("reserved");
  const loaded = await store.read(source.historyBucket, state.identity.switchId); expect(loaded!.state).toEqual(state);
  expect(Buffer.byteLength(canonicalSwitchJSON(loaded!.fence))).toBeLessThan(MAX_MODEL_SWITCH_FENCE_BYTES);
  const before = await store.retainedBytes(); expect(before).toBeGreaterThan(0);
  await store.begin(state, owner); expect(await store.retainedBytes()).toBe(before); expect(reservations).toHaveLength(1);
  const files = await readdir(join(root, MODEL_SWITCH_DIRECTORY)); expect(files).toHaveLength(2);
});

it("quota refusal creates no intent/artifacts and leaves the source unchanged", async () => {
  const { store, state, owner, root } = await fixture();
  await expect(store.begin(state, { ...owner, reserve: async () => { throw new Error("capacity refused"); } })).rejects.toThrow("capacity refused");
  expect(await readdir(root)).toEqual([]); expect(await store.read(source.historyBucket, state.identity.switchId)).toBeUndefined();
});

it("persists attempt admission before a fake paid call and excludes root ownership from production", async () => {
  const { store, state, owner, root, rootHeld } = await fixture(); await store.begin(state, owner);
  await store.admit(source.historyBucket, state.identity.switchId, "outgoing", owner);
  expect(rootHeld()).toBe(false); // provider invocation can occur only after storage returns
  const fresh = new ModelSwitchPayloadStore(root, await lstat(root));
  await expect(fresh.admit(source.historyBucket, state.identity.switchId, "outgoing", owner)).rejects.toMatchObject({ code: "ERR_HANDOFF_ATTEMPT_ALREADY_RECORDED" });
  await fresh.finish(source.historyBucket, state.identity.switchId, "outgoing", "unknown", owner);
  await fresh.advanceUnfit(source.historyBucket, state.identity.switchId, owner);
  await fresh.admit(source.historyBucket, state.identity.switchId, "incoming", owner);
  await fresh.finish(source.historyBucket, state.identity.switchId, "incoming", "unknown", owner);
  expect((await fresh.read(source.historyBucket, state.identity.switchId))!.state.phase).toBe("pending");
});

it("publishes ONE immutable content authority before the ready fence and replays exact bytes", async () => {
  const { store, state, owner, root, phases } = await fixture(); await store.begin(state, owner); await store.admit(source.historyBucket, state.identity.switchId, "outgoing", owner);
  phases.length = 0;
  const artifact = proposal(state), reference = await store.accept(source.historyBucket, state.identity.switchId, artifact, owner);
  expect(phases.indexOf("artifact_directory_synced")).toBeLessThan(phases.indexOf("fence_directory_synced"));
  const saved = await store.readArtifact(source.historyBucket, state.identity.switchId, reference); expect(saved.artifact).toEqual(artifact);
  const files = await readdir(join(root, MODEL_SWITCH_DIRECTORY)), content = await readFile(join(root, MODEL_SWITCH_DIRECTORY, files.find((name) => name.endsWith(".handoff.json"))!));
  const retained = await store.retainedBytes(); expect(await store.accept(source.historyBucket, state.identity.switchId, artifact, owner)).toEqual(reference); expect(await store.retainedBytes()).toBe(retained);
  expect(await readFile(join(root, MODEL_SWITCH_DIRECTORY, files.find((name) => name.endsWith(".handoff.json"))!))).toEqual(content);
  await expect(store.accept(source.historyBucket, state.identity.switchId, { ...artifact, summary: { intent: ["changed prose"] } }, owner)).rejects.toThrow("immutable");
  await expect(store.accept(source.historyBucket, state.identity.switchId, { ...artifact, target: { ...coordinates.targetProvenance, model: "C" } }, owner)).rejects.toThrow("frozen");
});

it("recovers an artifact returned before ready-fence fsync without rebilling or replacing content", async () => {
  const { store, state, owner, root } = await fixture(); await store.begin(state, owner); await store.admit(source.historyBucket, state.identity.switchId, "outgoing", owner);
  await expect(store.accept(source.historyBucket, state.identity.switchId, proposal(state), { ...owner, onPhase: async (phase) => { if (phase === "artifact_directory_synced") throw new Error("lost caller"); } })).rejects.toThrow("lost caller");
  const fresh = new ModelSwitchPayloadStore(root, await lstat(root));
  await expect(fresh.finish(source.historyBucket, state.identity.switchId, "outgoing", "unknown", owner)).rejects.toThrow("roll forward");
  await expect(fresh.accept(source.historyBucket, state.identity.switchId, { ...proposal(state), summary: { intent: ["different result"] } }, owner)).rejects.toThrow("conflicts");
  const reference = await fresh.recoverArtifact(source.historyBucket, state.identity.switchId, owner); expect(reference).toBeDefined();
  const before = await fresh.retainedBytes(); expect(await fresh.recoverArtifact(source.historyBucket, state.identity.switchId, owner)).toEqual(reference); expect(await fresh.retainedBytes()).toBe(before);
  expect((await fresh.read(source.historyBucket, state.identity.switchId))!.state.attempts[0]!.outcome).toBe("accepted");
});

it("foreign owners, malformed files and oversized content fail closed without cleanup", async () => {
  const { store, state, owner, root } = await fixture();
  await expect(store.begin(state, { ...owner, ownerKey: "foreign" })).rejects.toThrow("ownership");
  await store.begin(state, owner); await store.admit(source.historyBucket, state.identity.switchId, "outgoing", owner);
  const before = await store.retainedBytes();
  await expect(store.accept(source.historyBucket, state.identity.switchId, { ...proposal(state), checkpoint: new AbortController() }, owner)).rejects.toThrow();
  expect(await store.retainedBytes()).toBe(before);
  await expect(store.accept(source.historyBucket, state.identity.switchId, { ...proposal(state), recent: ["x".repeat(17 * 1024 * 1024)] }, owner)).rejects.toThrow("limit"); expect(await store.retainedBytes()).toBe(before);
  const directory = join(root, MODEL_SWITCH_DIRECTORY); await writeFile(join(directory, "unknown"), "Fictional preserved evidence", { mode: 0o600 });
  await expect(store.retainedBytes()).rejects.toThrow("ownership"); expect(await readFile(join(directory, "unknown"), "utf8")).toBe("Fictional preserved evidence");
});

async function worker(root: string, action: string, phase: string, kill = false): Promise<any> {
  const child = fork(new URL("./fixtures/model-switch-storage-worker.mjs", import.meta.url), [root, action, phase], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: ["--no-warnings"] });
  let stderr = ""; child.stderr!.on("data", (bytes) => { stderr += bytes; }); const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const result: any = await new Promise((resolve, reject) => { child.on("message", resolve); child.on("error", reject); child.on("exit", (code, signal) => reject(new Error(`worker exited ${code}/${signal}: ${stderr}`))); });
    const exit = once(child, "exit"); if (kill) { expect(result).toEqual({ phase }); child.kill("SIGKILL"); } else expect(result.error).toBeUndefined();
    const [code, signal] = await exit; expect(kill ? signal : code).toBe(kill ? "SIGKILL" : 0); return result;
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}
for (const phase of ["reserved", "payload_file_synced", "payload_renamed", "fence_renamed", "fence_directory_synced"]) {
  it(`recovers switch intent twice in fresh processes after SIGKILL at ${phase}`, async () => {
    const { root } = await fixture(); await worker(root, "begin", phase, true);
    const first = await worker(root, "begin", "recover"), second = await worker(root, "begin", "recover");
    expect(second.state).toEqual(first.state); expect(first.state.phase).toBe("outgoing"); expect(first.state.attempts).toEqual([]);
  });
}
for (const phase of ["summary_started", "summary_returned", "artifact_file_synced", "artifact_renamed", "artifact_directory_synced", "fence_renamed", "obsolete_state_removed", "obsolete_states_directory_synced", "reservation_adjusted"]) {
  it(`recovers paid-attempt/cache boundaries twice after SIGKILL at ${phase}`, async () => {
    const { root } = await fixture(); await worker(root, "begin", "recover"); await worker(root, "accept", phase, true);
    const first = await worker(root, "recover", "recover"), second = await worker(root, "recover", "recover");
    expect(second.state).toEqual(first.state); expect(first.repeatRefused).toBe(true);
    expect(first.state.phase).toBe(["summary_started", "summary_returned", "artifact_file_synced"].includes(phase) ? "outgoing" : "ready");
    expect(first.state.attempts).toHaveLength(1); expect(first.summaryCalls).toBe(1); expect(second.summaryCalls).toBe(1);
  });
}


it("cannot replace a pending switch with a newly requested target, even after artifact readiness", async () => {
  const { store, state, owner } = await fixture(); await store.begin(state, owner);
  const other = createModelSwitchState({ ...coordinates, toModelKey: "faux:C", targetEpoch: "9".repeat(64), targetProvenance: { ...coordinates.targetProvenance, model: "C" } }, state.reservation);
  await expect(store.begin(other, owner)).rejects.toThrow("roll forward");
  await store.admit(source.historyBucket, state.identity.switchId, "outgoing", owner);
  await store.accept(source.historyBucket, state.identity.switchId, proposal(state), owner);
  await expect(store.begin(other, owner)).rejects.toThrow("roll forward");
  expect((await store.begin(state, owner)).phase).toBe("ready");
});

it("rejects hard-linked or symlinked fences and replaced storage directories without repair", async () => {
  const { store, state, owner, root } = await fixture(); await store.begin(state, owner);
  const directory = join(root, MODEL_SWITCH_DIRECTORY), names = await readdir(directory);
  const path = join(directory, names.find((name) => name.endsWith(".fence.json"))!), original = await readFile(path);
  const alias = join(root, "hardlink-alias"); await link(path, alias);
  await expect(store.read(source.historyBucket, state.identity.switchId)).rejects.toThrow("ownership");
  expect(await readFile(path)).toEqual(original); await rm(alias);
  await rename(path, `${path}.saved`); await symlink(`${path}.saved`, path);
  await expect(store.read(source.historyBucket, state.identity.switchId)).rejects.toThrow("ownership");
  expect(await readFile(`${path}.saved`)).toEqual(original);
  await rm(path); await rename(`${path}.saved`, path);
  await rename(directory, `${directory}.saved`); await mkdir(directory, { mode: 0o700 });
  await expect(store.read(source.historyBucket, state.identity.switchId)).rejects.toThrow("ownership");
  expect(await readFile(join(`${directory}.saved`, names.find((name) => name.endsWith(".fence.json"))!))).toEqual(original);
});

it("stores an actual P3a checkpoint proposal, including optional ledger fields, without a producer call", async () => {
  const { MemorySessionRepo, createEvidenceView, buildHandoff, createHandoffBudget } = await import("@mono-agent/harness");
  const repository = new MemorySessionRepo(), native = await repository.create({ id: source.handleId, cwd: "/fictional" });
  await native.beginTurn("fictional-open-turn", {}, "synthetic", undefined);
  await native.appendMessage({ role: "user", content: "Fictional interrupted request", timestamp: 17 }, "00000000-0000-4000-8000-000000000007");
  await native.write("input_queued", { inputId: "fictional-queued-input", state: "queued", placement: "live" });
  const frozen = { ...source, journalId: native.metadata.journalId, sourceDigest: createHash("sha256").update(JSON.stringify(native.records)).digest("hex"), sourceSeq: native.seq, sourceTipId: native.tip };
  const { ordinal, epoch: _epoch, ...sourceData } = frozen;
  const descriptor = { ...sourceData, epoch: ordinal };
  const header = { format: "mono-harness", version: 2, ownershipSchemaVersion: 1, ownership: { kind: "unbound" }, initialHandle: { id: source.handleId }, ...native.metadata };
  const view = createEvidenceView({ ownerKey: source.ownerKey, historyBucket: source.historyBucket, segments: [{ descriptor, header, records: native.records }] });
  const hostContext = { systemPrompt: "Fictional rules" }, actualBudget = createHandoffBudget({ contextWindow: 100000, outputReserve: 2000, inputTokens: 100, hostContext });
  const built = buildHandoff(view, { hostContext, budget: actualBudget, target: coordinates.targetProvenance, timestamp: 17, producer: "checkpoint" });
  expect(built.status).toBe("ready");
  if (!("artifact" in built) || !built.artifact) throw new Error("Expected a ready P3a artifact");
  const { store, owner } = await fixture();
  const state = createModelSwitchState({ ...coordinates, sources: [frozen], frozenBudgetDigest: switchDigest(actualBudget) }, initial().reservation);
  await store.begin(state, owner); await store.advanceUnfit(source.historyBucket, state.identity.switchId, owner);
  const reference = await store.accept(source.historyBucket, state.identity.switchId, built.artifact, owner);
  expect((await store.readArtifact(source.historyBucket, state.identity.switchId, reference)).artifact).toEqual(JSON.parse(JSON.stringify(built.artifact)));
  expect((await store.read(source.historyBucket, state.identity.switchId))!.state.attempts).toEqual([]);
  await native.close();
});


it("recognizes a switch binding independently of later cold epochs and projection references", () => {
  const state = initial(), current = { ...source, journalId: "fictional-cold-current", ordinal: 1, epoch: "9".repeat(64), handleId: "6".repeat(64), predecessorJournalId: source.journalId, provenance: { ...source.provenance, model: "B" } };
  const record: TurnHistoryV4 = { version: 4, conversationId: source.historyBucket, messages: [], providerSession: { epoch: current.epoch, revision: 0, modelKey: "faux:B" },
    native: { authority: { version: 1, canonicalVersion: 4, rootId: "7".repeat(64), authorityId: "8".repeat(64), ownerKey: source.ownerKey, historyBucket: source.historyBucket }, chain: [source, current], projection: null },
    lastSwitch: { version: 1, switchId: state.identity.switchId, intentDigest: switchDigest(state.identity), fromEpoch: source.epoch, toEpoch: state.identity.targetEpoch, artifact: { id: "a".repeat(64), hash: "a".repeat(64) } } };
  expect(() => validateTurnHistoryV4(record, (message) => message as never)).not.toThrow();
  expect(recognizesModelSwitchBinding(record, state.identity)).toBe(true);
  expect(() => recognizesModelSwitchBinding({ ...record, lastSwitch: { ...record.lastSwitch!, intentDigest: "b".repeat(64) } }, state.identity)).toThrow("conflicts");
});

it("freezes caller-owned intent and proposed content before asynchronous ownership checks", async () => {
  const { store, state, owner } = await fixture(); const expected = structuredClone(state);
  await store.begin(state, { ...owner, onPhase: async (phase) => { if (phase === "reserved") (state.identity as any).targetEpoch = "9".repeat(64); } });
  expect((await store.read(source.historyBucket, expected.identity.switchId))!.state).toEqual(expected);
  await store.admit(source.historyBucket, expected.identity.switchId, "outgoing", owner);
  const content = proposal(expected), frozen = structuredClone(content);
  const reference = await store.accept(source.historyBucket, expected.identity.switchId, content, {
    ...owner, assertOwned: async () => { content.summary = { intent: ["Changed by an asynchronous caller"] }; },
  });
  expect((await store.readArtifact(source.historyBucket, expected.identity.switchId, reference)).artifact).toEqual(frozen);
});

it("distinguishes never-created storage/missing fences from disappearance of a pinned directory", async () => {
  const { store, state, owner, root } = await fixture();
  expect(await store.read(source.historyBucket, state.identity.switchId)).toBeUndefined();
  await store.begin(state, owner);
  expect(await store.read(source.historyBucket, "e".repeat(64))).toBeUndefined();
  await rename(join(root, MODEL_SWITCH_DIRECTORY), join(root, "preserved-storage"));
  await expect(store.read(source.historyBucket, state.identity.switchId)).rejects.toThrow("unavailable");
  await expect(store.read(source.historyBucket, "e".repeat(64))).rejects.toThrow("unavailable");
  expect((await readdir(join(root, "preserved-storage"))).length).toBe(2);
});

it("reconciles provisional artifact capacity and reclaims only superseded state after durable replacement", async () => {
  const { store, state, owner, root } = await fixture();
  const directory = join(root, MODEL_SWITCH_DIRECTORY), held: number[] = [], reserves: number[] = [];
  let reservation = 0;
  const quotaOwner = { ...owner, reserve: async (bytes: number) => { reservation += bytes; reserves.push(bytes); },
    adjustReservation: async (bytes: number) => { reservation = bytes; held.push(bytes); } };
  await store.begin(state, quotaOwner);
  const total = Object.values(state.reservation).reduce((sum, value) => sum + value, 0);
  for (let generation = 0; generation < 4; generation++) {
    await store.admit(source.historyBucket, state.identity.switchId, "outgoing", quotaOwner);
    await store.finish(source.historyBucket, state.identity.switchId, "outgoing", "rejected", quotaOwner);
    await store.advanceUnfit(source.historyBucket, state.identity.switchId, quotaOwner);
    await store.admit(source.historyBucket, state.identity.switchId, "incoming", quotaOwner);
    await store.finish(source.historyBucket, state.identity.switchId, "incoming", "unknown", quotaOwner);
    expect(reservation).toBe(total);
    const names = await readdir(directory); expect(names.filter((name) => name.endsWith(".state.json"))).toHaveLength(1); expect(names.filter((name) => name.endsWith(".fence.json"))).toHaveLength(1);
    await store.authorizeMessage(source.historyBucket, state.identity.switchId, String(generation + 1).repeat(64), quotaOwner);
  }
  await store.admit(source.historyBucket, state.identity.switchId, "outgoing", quotaOwner);
  const before = (await store.read(source.historyBucket, state.identity.switchId))!.state;
  const expectedReady = { ...before, phase: "ready", artifact: { id: "a".repeat(64), hash: "a".repeat(64) } };
  const reference = await store.accept(source.historyBucket, state.identity.switchId, proposal(state), quotaOwner);
  expect(reserves.at(-1)).toBe(serializeModelSwitchState({ ...expectedReady, artifact: reference, attempts: before.attempts.map((entry) => entry.generation === 4 && entry.producer === "outgoing" ? { ...entry, outcome: "accepted", artifact: reference } : entry) } as ModelSwitchState).byteLength + MAX_MODEL_SWITCH_FENCE_BYTES);
  expect(reservation).toBe(total - state.reservation.artifactBytes);
  expect((await store.read(source.historyBucket, state.identity.switchId))!.state.attempts).toHaveLength(9);
  expect((await readdir(directory)).length).toBe(3);
  await store.recoverArtifact(source.historyBucket, state.identity.switchId, quotaOwner);
  expect(reservation).toBe(total - state.reservation.artifactBytes); expect(held.every((bytes) => bytes === total || bytes === total - state.reservation.artifactBytes)).toBe(true);
});

it("keeps the referenced generation on pre-fence failures and preserves unrecognized future admissions", async () => {
  const { store, state, owner, root } = await fixture(); await store.begin(state, owner);
  const directory = join(root, MODEL_SWITCH_DIRECTORY), original = (await readdir(directory)).find((name) => name.endsWith(".state.json"))!;
  await expect(store.admit(source.historyBucket, state.identity.switchId, "outgoing", { ...owner, onPhase: async (phase) => { if (phase === "payload_directory_synced") throw new Error("before fence"); } })).rejects.toThrow("before fence");
  expect((await store.read(source.historyBucket, state.identity.switchId))!.state.attempts).toHaveLength(0);
  expect(await readFile(join(directory, original))).toEqual(serializeModelSwitchState(state));
  await store.begin(state, owner); // Cannot erase the orphan's unseen admission merely by name or age.
  expect((await readdir(directory)).filter((name) => name.endsWith(".state.json"))).toHaveLength(2);
  await store.admit(source.historyBucket, state.identity.switchId, "outgoing", owner);
  expect((await readdir(directory)).filter((name) => name.endsWith(".state.json"))).toHaveLength(1);
});
