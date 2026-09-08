import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ path: "", afterUnlink: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (args[0] !== fault.path) return await actual.rm(...args);
    fault.path = "";
    if (fault.afterUnlink) await actual.rm(...args);
    throw new Error("injected fence cleanup failure");
  } };
});
const { createDurableHistoryStore } = await import("../durable-history.js");
const dirs: string[] = [];
afterEach(async () => { fault.path = ""; await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it.each([false, true])("preserves bound fence ownership when cleanup fails after unlink=%s", async (afterUnlink) => {
  const root = await mkdtemp(join(tmpdir(), "model-fence-fault-"));
  dirs.push(root);
  const retired: Array<[string, string | undefined]> = [];
  const store = createDurableHistoryStore({ root, retireProviderSession: async (id, key) => { retired.push([id, key]); } });
  const turn = await store.beginProviderSessionTurn("bound", "one", { modelKey: "faux:override" });
  const key = createHash("sha256").update("mono-agent-history-v1\0bound").digest("hex");
  const path = join(root, ".locks", `${key}.dirty.json`);
  const original = JSON.parse(await readFile(path, "utf8"));
  const prepared = await turn.prepareCommit([{ role: "assistant", content: "committed" }], { providerSessionSynced: true });
  fault.path = path;
  fault.afterUnlink = afterUnlink;
  await prepared.commit();
  expect(await store.load("bound")).toEqual([{ role: "assistant", content: "committed" }]);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
  expect(original).toMatchObject({ version: 4, modelKey: "faux:override" });
  expect((await store.stats()).lastPostCommitMaintenanceError).toContain("injected fence cleanup failure");
  // Matching binding plus revision+1 proves the committed transcript is safe.
  await store.append("other", [{ role: "user", content: "maintenance" }]);
  expect(retired).toEqual([]);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  const resumed = await store.beginProviderSessionTurn("bound", "two", { modelKey: "faux:override" });
  expect(resumed.providerSessionId).toBe(turn.providerSessionId);
  await resumed.abort();
});
