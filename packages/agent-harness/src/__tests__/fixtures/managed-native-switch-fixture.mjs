import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonlSessionRepo } from "@mono-agent/harness/session-store.js";
import { createManagedNativeJournalStorage } from "@mono-agent/runtime-adapter";
import { createDurableHistoryStore } from "../../../dist/durable-history.js";
import { createModelSwitchState } from "../../../dist/model-switch-billing.js";
import { switchDigest, switchConversationKey } from "../../../dist/durable-model-switch-contract.js";
export const bucket = "fictional-native-conversation";
export function openStore(base, nativePhase = async () => {}, limits = {}) {
  const native = createManagedNativeJournalStorage({ sessionsRoot: join(base, "native"), onPhase: nativePhase });
  const store = createDurableHistoryStore({ root: join(base, "history"), nativeJournalStorage: native,
    retireProviderSession: async () => { throw new Error("Switch must preserve native evidence"); }, ...limits });
  return { native, store };
}
export async function fixture(base) {
  await mkdir(join(base, "history"), { mode: 0o700 });
  const { store, native } = openStore(base);
  const turn = await store.beginProviderSessionTurn(bucket, "fictional-source", { modelKey: "faux:A" });
  const repo = new JsonlSessionRepo({ sessionsRoot: join(base, "native") }), session = await repo.create({ id: turn.providerSessionId, cwd: "/fictional" });
  await session.scopedWrite(async () => {
    await session.writeRecord("owner_binding", { kind: "host", ownerKey: bucket, historyBucket: bucket });
    await session.writeRecord("handle_binding", { handleId: turn.providerSessionId, baseRevision: 0, authoritative: true, model: { provider: "faux", id: "A", api: "faux-api" } });
  }, "bind");
  await session.appendMessage({ role: "user", content: "Fictional source fact", timestamp: 17 }, "source-message"); await session.sync();
  const metadata = { ...session.metadata }; await session.close(); await repo.close();
  await (await turn.prepareCommit([{ role: "user", content: "Fictional source fact" }], { providerSessionSynced: true })).commit();
  const authority = await store.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true });
  if (authority.status !== "owned") throw new Error("Expected owned root authority"); await authority.release();
  const source = await store.modelSwitchStorageSource(bucket); if (source.status !== "supported") throw new Error("Expected supported source");
  const descriptor = await native.freeze({ epoch: source.sourceEpoch, ordinal: 0, handleId: turn.providerSessionId, predecessorJournalId: null,
    ownerKey: bucket, historyBucket: bucket, provenance: { provider: "faux", api: "faux-api", model: "A", account: null } });
  const budget = { policy: "mono-handoff-v1", contextWindow: 100000, hostCap: 16384, inputTokens: 100, outputReserve: 2000, safety: 5000, historyAllowance: 76516, hostContextDigest: "4".repeat(64) };
  const state = createModelSwitchState({ ownerKey: bucket, historyBucket: bucket, sourceCanonicalDigest: source.sourceCanonicalDigest,
    sourceRevision: source.sourceRevision, sources: [descriptor], fromModelKey: "faux:A", toModelKey: "faux:B",
    targetProvenance: { provider: "faux", api: "faux-api", model: "B", account: null }, targetEpoch: "5".repeat(64),
    projectionPolicy: "mono-handoff-v1", timestamp: 17, frozenBudgetDigest: switchDigest(budget) },
    { canonicalBytes: 8192, artifactBytes: 32768, retainedNativeBytes: 16384, headerCopyBytes: 16384, pendingBytes: 65536 });
  const canonicalPath = join(base, "history", `${switchConversationKey(bucket)}.history.json`);
  return { base, store, native, state, budget, canonicalPath, nativePath: metadata.path, original: await readFile(metadata.path) };
}
export async function ready(f) {
  const lease = await f.store.beginModelSwitchStorage(f.state); if (lease.status !== "owned") throw new Error("Expected owned switch");
  await lease.advanceUnfit(); const reference = await lease.accept({ version: 1, policy: "mono-handoff-v1",
    coverage: f.state.identity.sources.map(({ ordinal, epoch: _epoch, ...entry }) => ({ ...entry, epoch: ordinal })),
    summary: null, checkpoint: null, recent: [], ledger: [], retainedIds: [], producer: "checkpoint", timestamp: f.state.identity.timestamp,
    target: f.state.identity.targetProvenance, budget: f.budget });
  await lease.release(); return reference;
}
