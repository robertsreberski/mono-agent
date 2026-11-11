// Faux-only observation of shipping checkpoints before source-journal retirement.
// No paid adapter, proof protocol changes, alternate renderer or lineage exemptions.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serializeConversation } from "../../../packages/turn/dist/engine/compaction-kit/utils.js";
import { expect } from "vitest";
import { productionModules } from "../../lib/continuity-runner.mjs";
import { ROOT } from "../../lib/continuity-observation-input.mjs";
import { bindE2Checkpoint, verifyE2NativeLineage, e2BodySummaryRepresentations } from "../../lib/continuity-e2-lineage.mjs";
import { writeE2SummaryResult } from "../../lib/continuity-e2-summary-receipts.mjs";
import { digest } from "../../lib/continuity-recorded-schema.mjs";
import { convertResponsesMessages } from "../../../packages/turn/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";

export async function retentionLineage(root, protocol) {
  const modules = await productionModules(ROOT), prompts = [], checkpoints = [];
  await mkdir(join(root, "work")); await mkdir(join(root, "e2-summary-results"), { mode: 0o700 });
  const protocolPath = join(root, "lineage-protocol.json"), bytes = JSON.stringify(protocol);
  await writeFile(protocolPath, bytes, { mode: 0o600 });
  const planned = { index: 0, kind: "replay", phase: "whole" };
  const slot = { slotId: "a".repeat(64), lineages: {} };
  const state = { schedule: [planned], slots: [slot], pilot: { registration: { protocol: { path: protocolPath, sha256: digest(bytes) } } } };
  const readArtifact = path => readFile(path), readPrivate = async path => JSON.parse(await readFile(path, "utf8"));
  let round = 0;
  const app = { ...modules.app, createConfiguredAgentRuntime(options) {
    const native = modules.app.createConfiguredAgentRuntime(options);
    const branch = Number(/branch-(\d)/u.exec(options.cwd)[1]);
    return new Proxy(native, { get(target, key) {
      if (key !== "run") { const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; }
      return async (prompt, runtimeOptions) => {
        const generated = [], decorator = runtimeOptions.piModelsDecorator;
        return target.run(prompt, { ...runtimeOptions,
          piModelsDecorator: models => {
            const routed = decorator(models);
            return new Proxy(routed, { get(original, method) {
              if (method !== "completeSimple") return Reflect.get(original, method);
              return async (model, context, callOptions) => {
                prompts.push({ branch, model, context: structuredClone(context) });
                const message = await original.completeSimple(model, context, callOptions);
                generated.push({ model: `${model.provider}:${model.id}`, message }); return message;
              };
            } });
          },
          onCompactionRecorded: async record => {
            await runtimeOptions.onCompactionRecorded(record);
            expect(generated.length).toBeGreaterThan(0); expect(generated.length).toBeLessThanOrEqual(2);
            const summaries = [];
            for (const result of generated.splice(0)) {
              const rawUsage = { input_tokens: 10, output_tokens: 10 }, payloadDigest = "b".repeat(64);
              const receipt = await writeE2SummaryResult({ runId: "fictional-retention", slotId: slot.slotId, e2: { paidRole: "summary", model: result.model, round: ++round, outputRoot: root } }, result.message, rawUsage, "default", payloadDigest);
              summaries.push({ requestId: `fictional-retention:${round}`, paidRole: "summary", round, model: result.model, payloadDigest,
                summaryReceipt: { ...receipt.evidence, verified: true, durable: false }, settlement: { kind: "settled", rawUsage, tier: "default" } });
            }
            const reference = { journalId: record.checkpoint.journalId, checkpointId: record.checkpoint.checkpointId,
              checkpoint: branch === 0 ? 0 : protocol.branches[0].checkpoints.length };
            const lineage = await bindE2Checkpoint({ root, state, planned, slot, summaries, reference, readPrivate, readArtifact });
            slot.lineages[branch] = lineage; checkpoints.push({ branch, reference, summary: record.checkpoint.summary });
          },
        });
      };
    } });
  } };
  const serialized = (context, model) => Buffer.from(JSON.stringify({ input: convertResponsesMessages({ provider: "openai-codex", api: "openai-codex-responses", id: model?.id ?? "gpt-6.1-sol", input: ["text"] }, context,
    new Set(["openai", "openai-codex", "opencode"]), { includeSystemPrompt: false }) }));
  return { modules: { ...modules, app }, checkpoints, prompts,
    async verify(contexts) {
      const counts = { pack: 0, serializedPrompts: 0 };
      for (const observation of [...contexts, ...prompts]) {
        const { branch, context, model } = observation, body = serialized(context, model);
        const found = e2BodySummaryRepresentations(JSON.parse(body));
        const presence = await verifyE2NativeLineage(body, { lineageScope: branch, lineage: slot.lineages[branch] }, state, { outputRoot: root, index: 0 }, readArtifact);
        if (contexts.includes(observation)) {
          counts.pack += presence.pack;
          // Exercise the shipping subsequent-compaction serialization even when
          // this short faux schedule does not trigger a second native reduction.
          if (presence.pack) {
            const prompt = `<conversation>\n${serializeConversation(context.messages)}\n</conversation>\n\n`;
            const serializedBody = serialized({ messages: [{ role: "user", content: prompt, timestamp: 1 }] }, model);
            const serializedPresence = await verifyE2NativeLineage(serializedBody, { lineageScope: branch, lineage: slot.lineages[branch] }, state, { outputRoot: root, index: 0 }, readArtifact);
            expect(serializedPresence.pack).toBe(presence.pack); counts.serializedPrompts++;
          }
        }
        else if (found.some(r => r.kind === "pack")) counts.serializedPrompts++;
      }
      return counts;
    },
  };
}
