import { lstat, chmod, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ModelSwitchPayloadStore } from "../../../dist/model-switch-payloads.js";
import { createModelSwitchState } from "../../../dist/model-switch-billing.js";
import { switchDigest } from "../../../dist/durable-model-switch-contract.js";
const [root, action, phase] = process.argv.slice(2);
const source = { journalId: "fictional-journal", epoch: "1".repeat(64), ordinal: 0, handleId: "2".repeat(64), predecessorJournalId: null,
  ownerKey: "fictional-owner", historyBucket: "fictional-conversation", sourceTipId: "fictional-tip", sourceSeq: 4, sourceDigest: "3".repeat(64),
  provenance: { provider: "faux", api: "faux-api", model: "A", account: null } };
const budget = { policy: "mono-handoff-v1", contextWindow: 100000, hostCap: 16384, inputTokens: 100, outputReserve: 2000, safety: 5000, historyAllowance: 76516, hostContextDigest: "4".repeat(64) };
const state = createModelSwitchState({ ownerKey: source.ownerKey, historyBucket: source.historyBucket, sourceCanonicalDigest: "4".repeat(64), sourceRevision: 2,
  sources: [source], fromModelKey: "faux:A", toModelKey: "faux:B", targetProvenance: { provider: "faux", api: "faux-api", model: "B", account: null },
  targetEpoch: "5".repeat(64), projectionPolicy: "mono-handoff-v1", timestamp: 17, frozenBudgetDigest: switchDigest(budget) },
  { canonicalBytes: 8192, artifactBytes: 32768, retainedNativeBytes: 16384, headerCopyBytes: 16384, pendingBytes: 65536 });
const store = new ModelSwitchPayloadStore(root, await lstat(root)); let armed = action === "begin";
const owner = { ownerKey: source.ownerKey, historyBucket: source.historyBucket, assertOwned: async () => {}, reserve: async () => {},
  withRootTransaction: async (run) => {
    const path = join(root, "storage-test.sqlite"), database = new DatabaseSync(path); await chmod(path, 0o600);
    database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE");
    try { return await run(); } finally { database.exec("ROLLBACK"); database.close(); }
  },
  onPhase: async (current) => { if (armed && current === phase) { process.send?.({ phase }); await new Promise(() => {}); } } };
try {
  if (action === "begin") await store.begin(state, owner);
  if (action === "accept") {
    await store.admit(source.historyBucket, state.identity.switchId, "outgoing", owner);
    // Scripted producer outside root ownership. No network/model/tool call.
    const counter = await open(join(root, "scripted-summary-count"), "w", 0o600); await counter.writeFile("1"); await counter.sync(); await counter.close();
    armed = true;
    await owner.onPhase("summary_started");
    await owner.onPhase("summary_returned");
    await store.accept(source.historyBucket, state.identity.switchId, { version: 1, policy: "mono-handoff-v1",
      coverage: state.identity.sources.map(({ ordinal, epoch, ...entry }) => ({ ...entry, epoch: ordinal })),
      summary: { intent: ["Fictional work"], constraints: ["No deployment"], decisions: [], completedWork: [], failures: [], openWork: ["Verify unknown"], nextActions: [], references: [] },
      checkpoint: null, recent: [], ledger: [{ callId: "fictional-call", outcome: "unknown" }], retainedIds: [], producer: "outgoing", timestamp: 17, target: state.identity.targetProvenance, budget }, owner);
  }
  let repeatRefused = false;
  if (action === "recover") {
    await store.recoverArtifact(source.historyBucket, state.identity.switchId, owner);
    try { await store.admit(source.historyBucket, state.identity.switchId, "outgoing", owner); }
    catch (error) { repeatRefused = error.code === "ERR_HANDOFF_ATTEMPT_ALREADY_RECORDED"; }
  }
  const current = await store.read(source.historyBucket, state.identity.switchId); let summaryCalls = 0;
  try { summaryCalls = Number(await readFile(join(root, "scripted-summary-count"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  process.send?.({ state: current?.state, repeatRefused, summaryCalls });
} catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; }
process.disconnect?.();
