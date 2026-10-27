import { mkdtemp, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ToolHistoryWriter, ToolHistoryReader } from "@mono-agent/conversation";
import { createJsonlRunRecorder, readRecordedRun } from "@mono-agent/observability";
import { recoverConfiguredUpkeepAccounting } from "../composition/configured-tool-history.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "configured-accounting-")); roots.push(root); return root; }
it("does no work for an absent journal, including when upkeep is disabled", async () => {
  const root = await fixture(), open = vi.spyOn(ToolHistoryWriter, "open"), warning = vi.fn();
  await recoverConfiguredUpkeepAccounting(root, join(root, "tool-output"), warning);
  expect(open).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
});
it("startup recovers pending origin-run exports without enabling continuity or extracting anything", async () => {
  const root = await fixture(), artifactDir = join(root, "runs"), artifactRoot = join(artifactDir, "tool-output");
  const recorder = createJsonlRunRecorder({ artifactDir, runId: "origin", conversationId: "fictional" }); await recorder.start!();
  const writer = await ToolHistoryWriter.open({ root, artifactRoot, continuityEnabled: true });
  try {
    const scope = { logicalId: "logical", conversationId: "fictional" };
    const expected = (await writer.mutateUpkeep({ kind: "inspect", scope }))!;
    const fence = (await writer.mutateUpkeep({ kind: "claim", expected, ownerToken: "owner" }))!;
    const reservation = { ...fence, operationId: "operation", runId: "origin", recorderNamespace: artifactDir, model: "fictional:extractor-override", budget: "bootstrap" as const, manifest: "a".repeat(64), parent: null };
    await writer.mutateUpkeep({ kind: "reserve", reservation }); await writer.mutateUpkeep({ kind: "dispatch", reservation });
  } finally { await writer.close(); }
  await recorder.finish({ model: "fictional:answer" });
  const reader = new ToolHistoryReader(root), db = new DatabaseSync(reader.databasePath);
  db.exec("UPDATE continuity_upkeep_accounting SET exported=NULL,next_attempt_ms=0"); db.close();
  for (const name of await readdir(artifactDir)) if (name.includes(".upkeep.")) await rm(join(artifactDir, name));
  const warning = vi.fn(); await recoverConfiguredUpkeepAccounting(root, artifactRoot, warning);
  expect(warning).not.toHaveBeenCalled(); expect(reader.hasPendingUpkeepAccounting()).toBe(false);
  expect((await readRecordedRun({ artifactDir }, "origin"))?.upkeepAccounting?.[0]).toMatchObject({ model: "fictional:extractor-override", invocation: "uncertain", costUsd: null, usageIncluded: false });
  const files = await readdir(artifactDir); await recoverConfiguredUpkeepAccounting(root, artifactRoot, warning);
  expect(await readdir(artifactDir)).toEqual(files);
});

it("treats zero-length and upgrade-pending stores as no startup accounting work", async () => {
  const root = await fixture(), reader = new ToolHistoryReader(root), warning = vi.fn();
  await mkdir(join(root, "tool-history"), { mode: 0o700 });
  await writeFile(reader.databasePath, "", { mode: 0o600 });
  const open = vi.spyOn(ToolHistoryWriter, "open");
  await recoverConfiguredUpkeepAccounting(root, join(root, "tool-output"), warning);
  expect(open).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
  open.mockRestore();
  const writer = await ToolHistoryWriter.open({ root }); await writer.close();
  const db = new DatabaseSync(reader.databasePath); db.exec("PRAGMA user_version=1"); db.close();
  const upgradeOpen = vi.spyOn(ToolHistoryWriter, "open");
  await recoverConfiguredUpkeepAccounting(root, join(root, "tool-output"), warning);
  expect(upgradeOpen).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
  expect(() => reader.stats()).toThrow("upgrade-pending"); // explicit readers still fail closed
});
it("does not reacquire on every startup for permanently corrupt accounting rows", async () => {
  const root = await fixture(), writer = await ToolHistoryWriter.open({ root, artifactRoot: join(root, "tool-output"), continuityEnabled: true });
  try { await writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "logical", conversationId: "fictional" } }); } finally { await writer.close(); }
  const reader = new ToolHistoryReader(root), db = new DatabaseSync(reader.databasePath);
  db.exec("INSERT INTO continuity_upkeep_accounting(operation_id,phase,payload,error) VALUES ('corrupt','result','{}','invalid_journal')"); db.close();
  const warning = vi.fn(); await recoverConfiguredUpkeepAccounting(root, join(root, "tool-output"), warning);
  expect(reader.hasPendingUpkeepAccounting()).toBe(false);
  const check = new DatabaseSync(reader.databasePath, { readOnly: true });
  expect(check.prepare("SELECT exported,error FROM continuity_upkeep_accounting WHERE operation_id='corrupt'").get()).toEqual({ exported: "failed", error: "invalid_journal" }); check.close();
  const open = vi.spyOn(ToolHistoryWriter, "open");
  await recoverConfiguredUpkeepAccounting(root, join(root, "tool-output"), warning);
  expect(open).not.toHaveBeenCalled();
});
