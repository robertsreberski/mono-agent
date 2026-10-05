import { JsonlSessionRepo } from "../../session-store.js";
import { createRunDriver } from "../../run-driver.js";
import { readTurnEvidence, matchTurnEvidence, digestTurnInput } from "../../turn-evidence.js";
import { repairInterruptedSession } from "../../interruption.js";
const [root, mode] = process.argv.slice(2);
const model = { provider: "faux", id: "fictional-model", api: "faux" };
const descriptor = { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "cross-process-turn", handleId: "cross-process-handle", baseRevision: 0,
  reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "fictional-input" } };
const repo = new JsonlSessionRepo({ sessionsRoot: root });
if (mode === "admit") {
  process.on("message", () => {}); // IPC keeps the controlled foreground worker alive.
  const raw = await repo.create({ id: descriptor.handleId }); const sync = raw.sync.bind(raw);
  raw.sync = async () => {
    await sync();
    if (raw.validator.turns.get(descriptor.turnId)?.start && raw.seq === raw.validator.turns.get(descriptor.turnId).start.seq) {
      process.send({ phase: "inline-start-synced" }); await new Promise(() => {});
    }
  };
  const driver = createRunDriver(raw, { model, tools: [], systemPrompt: "Fictional contract." });
  await driver.beginTurn(descriptor.turnId, "host", descriptor);
  throw new Error("Worker passed the controlled first-sync barrier");
} else {
  const metadata = (await repo.listOwned()).find((item) => item.id === descriptor.handleId);
  const raw = await repo.open(metadata, { repair: false });
  const query = { descriptor, purpose: "execution", expectedModel: model, expectedBaseTip: null,
    expectedInputs: [{ id: "fictional-input", placement: "initial", requestDigest: digestTurnInput("Fictional request.") }] };
  const before = await readTurnEvidence(raw, descriptor.turnId);
  const matched = matchTurnEvidence(before, query);
  if (matched.status !== "matched") throw new Error("Inline start did not match before repair");
  await raw.prepareReconciliation(); await repairInterruptedSession(raw);
  const after = await readTurnEvidence(raw, descriptor.turnId);
  await raw.close();
  process.send({ phase: "storage-only-recovery", evidence: after, beforeStatus: before.status });
  process.disconnect(); process.exit(0);
}
