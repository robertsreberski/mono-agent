// Genuine owned canonical/native switch, adapted from managed-native-switch-fixture.
// All data is fictional; no app credentials, model transport or real registry.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { JsonlSessionRepo } from "@mono-agent/turn/engine";
import { createManagedNativeJournalStorage } from "@mono-agent/turn/ai";
import { createDurableHistoryStore } from "../../../packages/conversation/dist/history/canonical/store.js";
import { createModelSwitchState } from "../../../packages/conversation/dist/history/model-switch/billing.js";
import { switchDigest } from "../../../packages/conversation/dist/history/model-switch/contract.js";
import { SOL, LUNA } from "../../lib/continuity-e2-protocol.mjs";
export async function coldSwitchFixture(work, summary, beforeSwitch) {
  const bucket = "fictional-cold-conversation", sessionsRoot = join(work, "sessions");
  await mkdir(join(work, "history"), { recursive: true, mode: 0o700 });
  const native = createManagedNativeJournalStorage({ sessionsRoot });
  const store = createDurableHistoryStore({ root: join(work, "history"), nativeJournalStorage: native,
    retireProviderSession: async () => { throw Error("Switch must preserve accepted evidence"); } });
  const turn = await store.beginProviderSessionTurn(bucket, "fictional-source", { modelKey: SOL });
  const model = { provider: "openai-codex", id: SOL.split(":")[1], api: "openai-codex-responses" };
  const repo = new JsonlSessionRepo({ sessionsRoot }), session = await repo.create({ id: turn.providerSessionId, cwd: work });
  await session.scopedWrite(async () => {
    await session.writeRecord("owner_binding", { kind: "host", ownerKey: bucket, historyBucket: bucket });
    await session.writeRecord("handle_binding", { handleId: turn.providerSessionId, baseRevision: 0, authoritative: true, model });
  }, "bind");
  await session.beginTurn("fictional-turn"); await session.openOperation("fictional-compaction", { model });
  const checkpointId = await session.appendCompaction({ summary, retainedTail: [], tokensBefore: 100, details: { readFiles: [], modifiedFiles: [] } });
  await session.closeOperation("fictional-compaction", "completed"); await session.endTurn("fictional-turn", "completed"); await session.sync();
  const metadata = { ...session.metadata }; await session.close(); await repo.close();
  await (await turn.prepareCommit([{ role: "user", content: "Fictional source fact" }], { providerSessionSynced: true })).commit();
  const authority = await store.acquireNativeHistoryAuthority(bucket);
  if (authority.status !== "owned") throw Error("Expected owned root authority"); await authority.release();
  await beforeSwitch({ journalId: metadata.journalId, checkpointId, checkpoint: 0 });
  const source = await store.modelSwitchStorageSource(bucket);
  if (source.status !== "supported") throw Error("Expected supported source");
  const descriptor = await native.freeze({ epoch: source.sourceEpoch, handleId: turn.providerSessionId,
    ownerKey: bucket, historyBucket: bucket, provenance: { provider: model.provider, api: model.api, model: model.id, account: null } });
  const budget = { policy: "mono-handoff-v1", contextWindow: 100000, hostCap: 16384, inputTokens: 100, outputReserve: 2000, safety: 5000, historyAllowance: 76516, hostContextDigest: "4".repeat(64) };
  const state = createModelSwitchState({ ownerKey: bucket, historyBucket: bucket, sourceCanonicalDigest: source.sourceCanonicalDigest,
    sourceRevision: source.sourceRevision, sourceEpoch: source.sourceEpoch, source: descriptor, fromModelKey: SOL, toModelKey: LUNA,
    targetProvenance: { provider: model.provider, api: model.api, model: LUNA.split(":")[1], account: null }, targetEpoch: "5".repeat(64),
    projectionPolicy: "mono-handoff-v1", timestamp: 17, frozenBudgetDigest: switchDigest(budget) },
  { canonicalBytes: 8192, artifactBytes: 32768, nativeBytes: 8192, pendingBytes: 65536 }, budget, "a".repeat(64));
  const lease = await store.beginModelSwitchStorage(state);
  if (lease.status !== "owned") throw Error("Expected owned switch");
  await lease.advanceUnfit();
  const { epoch: _epoch, ...coverage } = descriptor;
  await lease.accept({ version: 1, policy: "mono-handoff-v1", coverage: [coverage], summary: null, checkpoint: null,
    recent: [], ledger: [], retainedIds: [], producer: "checkpoint", timestamp: 17, target: state.identity.targetProvenance, budget });
  await lease.release();
  const result = await store.rollForwardModelSwitch(bucket, state.identity.switchId, {});
  if (result.status !== "committed") throw Error("Expected committed switch");
  return { path: metadata.path, result };
}
