import { rename } from "node:fs/promises";
import { ToolHistoryWriter } from "../../../dist/tool-history/writer.js";
import { createJsonlRunRecorder } from "@mono-agent/observability";
const [root, artifactDir, phase] = process.argv.slice(2);
const recorder = createJsonlRunRecorder({ artifactDir, runId: "origin", conversationId: "fictional" });
await recorder.start();
const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true });
const scope = { logicalId: "logical", conversationId: "fictional" };
const expected = await writer.mutateUpkeep({ kind: "inspect", scope });
const fence = await writer.mutateUpkeep({ kind: "claim", expected, ownerToken: "fixture-owner" });
const reservation = { ...fence, ...scope, operationId: "operation", runId: "origin", recorderNamespace: artifactDir,
  model: "fictional:extractor", budget: "bootstrap", manifest: "a".repeat(64), parent: null };
await writer.mutateUpkeep({ kind: "reserve", reservation });
if (phase === "pending") await rename(`${artifactDir}/origin.summary.json`, `${artifactDir}/origin.held-summary`);
await writer.mutateUpkeep({ kind: "dispatch", reservation });
if (phase === "result") await writer.mutateUpkeep({ kind: "outcome", reservation, receipt: {
  operationId: reservation.operationId, model: reservation.model, api: "openai-responses", capEnforcement: "request",
  providerInvoked: true, status: "valid", reason: "completed", elapsedMs: 1, inputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, outputTokens: 2,
  providerUsage: { input: 3, cacheRead: 4, cacheWrite: 5, output: 2 }, estimatedInputTokens: 100, estimatedInputCostUsd: 1, costUsd: 0.2, visibleEstimate: 2, outputOverrun: false,
} });
await writer.replayUpkeepAccounting(); // drain the attempted export; pending mode cannot publish
// Die before receipt emission AND before any recorder event/checkpoint.
process.send({ ready: true });
await new Promise(() => { setInterval(() => {}, 1_000); });
