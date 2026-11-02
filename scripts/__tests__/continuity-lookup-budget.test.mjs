import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({ buildCheckpoint: vi.fn(), runProbe: vi.fn(), productionModules: vi.fn() }));
vi.mock("../lib/continuity-runner.mjs", () => mocks);
import { measureBudget } from "../continuity-lookup-budget.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)), dirs = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.productionModules.mockResolvedValue({ conversation: { ToolHistoryReader: class {
    searchContinuity() { return { available: true, items: [] }; }
  } } });
});
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function scratch() {
  const base = join(root, ".worklab-tmp"); await mkdir(base, { recursive: true });
  const output = await mkdtemp(join(base, "lookup-sizing-failure-")); dirs.push(output); return output;
}

it("cleans partial checkpoint scratch when checkpoint creation throws", async () => {
  const output = await scratch(); let checkpointDir;
  mocks.buildCheckpoint.mockImplementation(async ({ dir }) => {
    checkpointDir = dir; await mkdir(dir, { recursive: true }); await writeFile(join(dir, "partial"), "fictional partial checkpoint");
    throw new Error("fictional_checkpoint_failure");
  });
  await expect(measureBudget({ output })).rejects.toThrow("fictional_checkpoint_failure");
  await expect(access(checkpointDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(mocks.runProbe).not.toHaveBeenCalled();
});

it("refuses an unverified retained reference before it can influence frozen maxima", async () => {
  const output = await scratch(); let checkpointDir;
  mocks.buildCheckpoint.mockImplementation(async ({ dir }) => {
    checkpointDir = dir; await mkdir(dir, { recursive: true });
    return { work: join(dir, "work"), snapshot: join(dir, "snapshot"), record: { conversationId: "web:fiction", continuity: { records: 1 } } };
  });
  mocks.runProbe.mockResolvedValue({ failure: null, store: { healthy: true }, lookup: { exhausted: null, source: { availability: "retained" }, sourceReturned: false } });
  await expect(measureBudget({ output })).rejects.toThrow("inventory_source_digest_unverified");
  expect(mocks.runProbe).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(join(output, "inventory-progress.json"), "utf8")).paths).toEqual([]);
  await expect(access(join(output, "budget.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(checkpointDir)).rejects.toMatchObject({ code: "ENOENT" });
});
