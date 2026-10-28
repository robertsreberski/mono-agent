import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentUpkeepAccounting } from "@mono-agent/contracts";
import { listRecordedRuns, readRecordedRun } from "../recorded-runs.js";
import { exportUpkeepAccounting } from "../upkeep-accounting.js";

const io = vi.hoisted(() => ({ scans: 0, failScan: false, failExtraScan: false, eventReads: 0, active: 0, peak: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs,
    readdir: vi.fn(async (...args: Parameters<typeof fs.readdir>) => {
      io.scans++;
      if (io.failScan || io.failExtraScan && io.scans > 1) throw Object.assign(new Error("fictional descriptor exhaustion"), { code: "EMFILE" });
      return fs.readdir(...args);
    }),
    open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
      if (!String(args[0]).endsWith(".events.jsonl")) return fs.open(...args);
      io.eventReads++; io.active++; io.peak = Math.max(io.peak, io.active);
      try {
        const handle = await fs.open(...args), close = handle.close.bind(handle);
        let counted = true;
        handle.close = async () => { try { await close(); } finally { if (counted) { counted = false; io.active--; } } };
        return handle;
      } catch (error) { io.active--; throw error; }
    }),
  };
});
const roots: string[] = [];
beforeEach(() => { Object.assign(io, { scans: 0, failScan: false, failExtraScan: false, eventReads: 0, active: 0, peak: 0 }); });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "upkeep-list-")); roots.push(root); return root; }
function accounting(root: string, runId: string): AgentUpkeepAccounting {
  return { version: 1, usageIncluded: false, operationId: "op", databaseId: "db", incarnation: "inc", runId,
    conversationId: "fictional", logicalConversationId: "logical", recorderNamespace: root, model: "fictional:extractor",
    budget: "bootstrap", phase: "result", invocation: "invoked", outcome: "valid", inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0.2 };
}
async function fixture(root: string, runId: string, upkeep = false) {
  const summary = { runId, conversationId: "fictional", status: "succeeded", durationMs: 1, eventCount: 0, artifactPaths: [],
    usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, cost: { cumulativeUsd: 0.1 },
    ...(upkeep ? { upkeepAccounting: [accounting(root, runId)] } : {}) };
  await writeFile(join(root, `${runId}.summary.json`), JSON.stringify(summary));
  await writeFile(join(root, `${runId}.events.jsonl`), "");
}
it("scans a large namespace once and bounds enrichment to eight evidenced runs at a time", async () => {
  const root = await directory();
  for (let i = 0; i < 128; i++) await fixture(root, `run-${i}`, i < 24);
  const result = await listRecordedRuns({ artifactDir: root, maxRuns: Number.MAX_SAFE_INTEGER });
  expect(result.runs).toHaveLength(128); expect(result.warnings).toEqual([]);
  expect(io.scans).toBe(1); expect(io.eventReads).toBe(24); expect(io.peak).toBeLessThanOrEqual(8); expect(io.active).toBe(0);
  for (const run of result.runs.filter(r => !r.upkeepAccounting?.length)) {
    expect(run).not.toHaveProperty("inclusiveCost"); expect(run).not.toHaveProperty("upkeepAccountingPartial");
  }
});
it("never rescans upkeep-free runs, and a failed companion read leaves their summary unchanged", async () => {
  const root = await directory(); await fixture(root, "origin");
  const baseline = await listRecordedRuns({ artifactDir: root });
  io.scans = 0; io.failExtraScan = true;
  expect(await listRecordedRuns({ artifactDir: root })).toEqual(baseline);
  expect(io.scans).toBe(1); expect(io.eventReads).toBe(0);
  io.failExtraScan = false;
  const detail = await readRecordedRun({ artifactDir: root }, "origin");
  io.failScan = true;
  const unavailable = await readRecordedRun({ artifactDir: root }, "origin");
  expect(unavailable?.summary).toEqual(detail?.summary);
  expect(unavailable?.warnings).toContain("Upkeep accounting degraded: companions unavailable.");
  const failedList = await listRecordedRuns({ artifactDir: root });
  expect(failedList.runs).toEqual([]); expect(failedList.warnings).toHaveLength(1);
  expect(failedList.warnings[0]).toContain("Unable to read artifact directory");
});
it("discovers a crash-recovered companion even when the summary has no upkeep evidence", async () => {
  const root = await directory(); await fixture(root, "origin");
  await exportUpkeepAccounting(accounting(root, "origin"));
  const result = await listRecordedRuns({ artifactDir: root });
  expect(io.scans).toBe(1); expect(io.eventReads).toBe(1); expect(result.warnings).toEqual([]);
  expect(result.runs[0]?.upkeepAccounting).toHaveLength(1);
  expect(result.runs[0]?.inclusiveCost?.totalUsd).toBeCloseTo(0.3);
  expect(result.runs[0]?.upkeepAccountingPartial).toBeUndefined();
});
