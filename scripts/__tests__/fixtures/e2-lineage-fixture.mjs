// Fictional bounded native journal and generated receipts; no real credentials/stores.
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepo } from "../../../packages/turn/dist/engine/session-store.js";
import { e2PhaseWork, bindE2Checkpoint } from "../../lib/continuity-e2-lineage.mjs";
import { writeE2SummaryResult } from "../../lib/continuity-e2-summary-receipts.mjs";
import { guardedAuthorization } from "../../lib/continuity-guarded-authorization.mjs";
import { guardedState } from "../../lib/continuity-guarded-state.mjs";
import { digest } from "../../lib/continuity-recorded-schema.mjs";
import { SOL } from "../../lib/continuity-e2-protocol.mjs";
const split = "\n\n---\n\n**Turn Context (split turn):**\n\n";
const readArtifact = (...args) => guardedAuthorization("e2-validation").readArtifact(...args);
const readPrivate = (...args) => guardedState("e2-validation").readPrivate(...args);
export async function lineageFixture(texts = ["Fictional committed evidence."], assembled = texts.join(split), details = { readFiles: [], modifiedFiles: [] }, plannedPatch = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-lineage-")));
  await mkdir(join(root, "e2-summary-results"), { mode: 0o700 });
  const planned = { index: 0, kind: "proof", arm: "pressure", variant: "ceiling", phase: "whole", ...plannedPatch }, slot = { slotId: "a".repeat(64), holds: [] }, state = { schedule: [planned], slots: [slot] };
  if (planned.kind === "replay") {
    const path = join(root, "protocol.json"), bytes = JSON.stringify({ branches: [{ checkpoints: [{}, {}, {}, {}] }, { checkpoints: [{}] }] });
    await writeFile(path, bytes, { mode: 0o600 }); state.pilot = { registration: { protocol: { path, sha256: digest(bytes) } } };
  }
  const work = e2PhaseWork(root, planned, planned.branch ?? 0); await mkdir(work, { recursive: true, mode: 0o700 });
  const repo = new JsonlSessionRepo({ sessionsRoot: join(work, "sessions") }), session = await repo.create({ id: "fictional-session", cwd: work });
  await session.beginTurn("fictional-turn"); await session.openOperation("fictional-compaction", { model: { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses" } });
  const checkpointId = await session.appendCompaction({ summary: assembled, retainedTail: [], tokensBefore: 100, details });
  await session.closeOperation("fictional-compaction", "completed"); await session.endTurn("fictional-turn", "completed"); await session.sync();
  const metadata = session.metadata;
  const reference = { journalId: session.metadata.journalId, checkpointId, checkpoint: planned.branch === 1 ? 4 : 2 }, journalPath = session.metadata.path; await session.close(); await repo.close();
  const rawUsage = { input_tokens: 10, output_tokens: 10 };
  for (const [i, text] of texts.entries()) {
    const round = i + 1, payloadDigest = "b".repeat(64), message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] };
    const result = await writeE2SummaryResult({ runId: "fictional-run", slotId: slot.slotId, e2: { paidRole: "summary", model: SOL, round, outputRoot: root } }, message, rawUsage, "default", payloadDigest);
    slot.holds.push({ requestId: `fictional-run:${round}`, paidRole: "summary", round, model: SOL, payloadDigest, summaryReceipt: { ...result.evidence, verified: true, durable: false },
      settlement: { kind: "settled", rawUsage, tier: "default" } });
  }
  const bind = () => bindE2Checkpoint({ root, state, planned, slot, summaries: slot.holds, reference, readPrivate, readArtifact });
  return { root, state, planned, slot, reference, journalPath, assembled, bind, metadata, work, readArtifact, digest, options: { root, state, planned, slot, summaries: slot.holds, reference, readPrivate, readArtifact } };
}
