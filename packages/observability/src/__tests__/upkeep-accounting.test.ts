import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createJsonlRunRecorder, readRecordedRun, pruneRunArtifacts } from "../index.js";
import { exportUpkeepAccounting } from "../upkeep-accounting.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const artifactDir = await mkdtemp(join(tmpdir(), "upkeep-artifacts-")); roots.push(artifactDir);
  const recorder = createJsonlRunRecorder({ artifactDir, runId: "origin", conversationId: "fictional" });
  await recorder.start!();
  const dispatch = { version: 1, usageIncluded: false, operationId: "operation", databaseId: "database", incarnation: "incarnation", runId: "origin", conversationId: "fictional", logicalConversationId: "logical", recorderNamespace: artifactDir, model: "fictional:extractor", budget: "bootstrap", phase: "dispatch", invocation: "uncertain", outcome: "uncertain", inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null };
  const result = { ...dispatch, phase: "result", invocation: "invoked", outcome: "valid", inputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, outputTokens: 2, costUsd: 0.2 };
  return { artifactDir, recorder, dispatch, result };
}
it("merges immutable companions, events and summary views once without touching inference totals", async () => {
  const f = await fixture();
  f.recorder.onEvent({ type: "continuity_upkeep", accounting: f.dispatch });
  const summary = await f.recorder.finish({ usage: { input_tokens: 9 }, cost: { totalUsd: 0.1 } });
  const before = await readFile(join(f.artifactDir, "origin.summary.json"), "utf8");
  await exportUpkeepAccounting(f.result); await exportUpkeepAccounting(f.result);
  await exportUpkeepAccounting(f.dispatch); // delayed uncertainty cannot overwrite result
  expect(await readFile(join(f.artifactDir, "origin.summary.json"), "utf8")).toBe(before);
  expect((await readdir(f.artifactDir)).filter(name => name.includes(".upkeep.")).length).toBe(2);
  const detail = await readRecordedRun({ artifactDir: f.artifactDir }, "origin");
  expect(detail?.upkeepAccounting).toEqual([f.result]);
  expect(detail?.summary.usage).toEqual(summary.usage); expect(detail?.summary.cost).toEqual(summary.cost);
  expect(detail?.warnings).toEqual([]);
  // Legacy/external summary evidence remains separate too.
  await writeFile(join(f.artifactDir, "origin.summary.json"), JSON.stringify({ ...JSON.parse(before), upkeepAccounting: [f.dispatch, f.result] }));
  expect((await readRecordedRun({ artifactDir: f.artifactDir }, "origin"))?.upkeepAccounting).toEqual([f.result]);
});
it("retains nullable usage and warns on conflicting identities or corrupt companion evidence", async () => {
  const f = await fixture(); await f.recorder.finish({});
  await exportUpkeepAccounting(f.dispatch);
  await exportUpkeepAccounting({ ...f.result, inputTokens: null, costUsd: null });
  await expect(exportUpkeepAccounting({ ...f.result, costUsd: -1 })).rejects.toThrow();
  await expect(exportUpkeepAccounting({ ...f.result, model: "fictional:other" })).rejects.toThrow("Conflicting upkeep companion");
  const path = (await readdir(f.artifactDir)).find(name => name.endsWith(".result.json"))!;
  await writeFile(join(f.artifactDir, path), "invalid");
  const detail = await readRecordedRun({ artifactDir: f.artifactDir }, "origin");
  expect(detail?.upkeepAccounting).toEqual([f.dispatch]);
  expect(detail?.warnings.join(" ")).toContain("Upkeep accounting degraded");
});
it("retains companions while running, prunes them with the origin, and never recreates pruned runs", async () => {
  const f = await fixture(); await exportUpkeepAccounting(f.dispatch);
  expect((await pruneRunArtifacts({ artifactDir: f.artifactDir, maxCount: 0 })).prunedRunCount).toBe(0);
  await f.recorder.finish({}); await exportUpkeepAccounting(f.result);
  const dry = await pruneRunArtifacts({ artifactDir: f.artifactDir, maxCount: 0, dryRun: true });
  expect(dry.removedFileCount).toBe(4);
  const pruned = await pruneRunArtifacts({ artifactDir: f.artifactDir, maxCount: 0 });
  expect(pruned.removedFileCount).toBe(4); expect(pruned.prunedRunIds).toEqual(["origin"]);
  expect(await exportUpkeepAccounting(f.result)).toBe("pruned"); expect(await readdir(f.artifactDir)).toEqual([]);
  expect(await readRecordedRun({ artifactDir: f.artifactDir }, "origin")).toBeUndefined();
});
it("fails closed for conflicting origin identity and never creates missing namespaces", async () => {
  const f = await fixture(); await f.recorder.finish({});
  await expect(exportUpkeepAccounting({ ...f.result, conversationId: "other" })).rejects.toThrow("Conflicting upkeep origin");
  const absent = join(f.artifactDir, "absent");
  expect(await exportUpkeepAccounting({ ...f.result, recorderNamespace: absent })).toBe("pruned");
  expect(await readdir(f.artifactDir)).not.toContain("absent");
});

it("closes concurrent retention/export races without resurrecting any artifacts", async () => {
  const f = await fixture(); await f.recorder.finish({});
  await Promise.allSettled([exportUpkeepAccounting(f.dispatch), exportUpkeepAccounting(f.result), pruneRunArtifacts({ artifactDir: f.artifactDir, maxCount: 0 })]);
  expect(await readdir(f.artifactDir)).toEqual([]);
  expect(await exportUpkeepAccounting(f.result)).toBe("pruned");
});

it("cleans orphaned companions after a crash between summary removal and companion sweep", async () => {
  const f = await fixture(); await f.recorder.finish({}); await exportUpkeepAccounting(f.result);
  await rm(join(f.artifactDir, "origin.summary.json"));
  const result = await pruneRunArtifacts({ artifactDir: f.artifactDir, maxCount: 0 });
  expect(result.removedFileCount).toBe(1);
  expect((await readdir(f.artifactDir)).some(name => name.includes(".upkeep."))).toBe(false);
});
