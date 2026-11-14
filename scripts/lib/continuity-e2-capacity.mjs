// Provider-free controller scan/serialization capacity alongside the runtime lane.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { rehearseE2Protected } from "./continuity-e2-protected.mjs";
import { bindE2Checkpoint, e2PhaseWork, verifyE2NativeLineage } from "./continuity-e2-lineage.mjs";
import { bindE2NativeCompaction } from "./continuity-e2-journals.mjs";
import { writeE2SummaryResult } from "./continuity-e2-summary-receipts.mjs";
import { digest } from "./continuity-recorded-schema.mjs";
import { convertResponsesMessages } from "../../packages/turn/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
export async function measureE2ControllerCapacity(root) {
  const measurements = [];
  for (const fallback of [false, true]) {
    const base = join(root, `controller-${fallback}`); await mkdir(join(base, "e2-summary-results"), { recursive: true, mode: 0o700 });
    const planned = { index: 0, kind: "proof", arm: "pressure", variant: "ceiling", phase: "whole" }, slot = { slotId: "a".repeat(64), holds: [], lineages: {} }, state = { schedule: [planned], slots: [slot] };
    const readArtifact = path => readFile(path), readPrivate = async path => JSON.parse(await readFile(path, "utf8"));
    const model = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", contextWindow: 272000, maxTokens: 128000 };
    await rehearseE2Protected({ work: e2PhaseWork(base, planned), model, carrier: "carry", fallback,
      onPublication: async ({ summary, checkpoint }) => {
        const payloadDigest = "b".repeat(64), rawUsage = { input_tokens: 10, output_tokens: 10 };
        const result = await writeE2SummaryResult({ runId: "fictional-capacity", slotId: slot.slotId, e2: { paidRole: "summary", model: checkpoint.model, round: 1, outputRoot: base } },
          { role: "assistant", stopReason: "stop", content: [{ type: "text", text: summary }] }, rawUsage, "default", payloadDigest);
        const hold = { requestId: "fictional-capacity:1", paidRole: "summary", round: 1, model: checkpoint.model, payloadDigest, summaryReceipt: { ...result.evidence, verified: true, durable: false }, settlement: { kind: "settled", rawUsage, tier: "default" } };
        slot.lineages.proof = await bindE2Checkpoint({ root: base, state, planned, slot, summaries: [hold], reference: { journalId: checkpoint.journalId, checkpointId: checkpoint.checkpointId, checkpoint: 0 }, readArtifact, readPrivate });
      },
      onSummary: async ({ raw, context, active }) => {
        global.gc(); const before = process.memoryUsage(); let heap = before.heapUsed, rss = before.rss, maximumBytes = 0;
        const operationDigest = digest([...raw.validator.openOperations].at(-1));
        slot.compaction = { checkpoint: 0, operationDigest, nativeSnapshot: [{ retainedAdmission: true }] };
        const started = performance.now();
        for (let i = 0; i < 30; i++) {
          const bytes = Buffer.from(JSON.stringify({ model: model.id, stream: true, store: false, instructions: context.systemPrompt,
            input: convertResponsesMessages({ ...model, input: ["text"] }, context, new Set(["openai-codex"]), { includeSystemPrompt: false }) }));
          maximumBytes = Math.max(maximumBytes, bytes.length);
          const hold = { paidRole: "summary", checkpoint: 0, operationDigest, lineageScope: "proof", lineage: slot.lineages.proof, payloadDigest: digest(bytes) };
          hold.nativeCompaction = await bindE2NativeCompaction(e2PhaseWork(base, planned), operationDigest, hold.payloadDigest, readArtifact);
          await verifyE2NativeLineage(bytes, hold, state, { outputRoot: base, index: 0 }, readArtifact);
          if (fallback ? hold.retainedPredecessor?.assembly !== "legacy-fallback" : hold.retainedPredecessor?.textSha256 !== digest(active.text)) throw Error("controller_capacity_lineage_failed");
          const m = process.memoryUsage(); heap = Math.max(heap, m.heapUsed); rss = Math.max(rss, m.rss);
        }
        const elapsedMs = performance.now() - started; global.gc();
        const result = { workload: "e2-controller-retained-serialization", fallback, cycles: 30, retainedBytes: Buffer.byteLength(active.text), maximumSerializedBytes: maximumBytes,
          elapsedMs, heapDeltaMiB: (heap - before.heapUsed) / 1024 ** 2, rssDeltaMiB: (rss - before.rss) / 1024 ** 2,
          steadyHeapGrowthMiB: (process.memoryUsage().heapUsed - before.heapUsed) / 1024 ** 2 };
        result.acceptedEnvelopeMet = elapsedMs <= 5000 && result.heapDeltaMiB <= 100 && result.rssDeltaMiB <= 128;
        measurements.push(result);
      },
    });
  }
  return measurements;
}
