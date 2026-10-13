import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDurableHistoryStore } from "../durable-history.js";
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof fs>() }));
const roots: string[] = [], id = "fictional-reset-owner", sibling = "fictional-sibling";
const key = createHash("sha256").update("mono-agent-history-v1\0").update(id).digest("hex");
const input = [{ role: "user" as const, content: "Fictional old input" }];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "reset-refusal-")); roots.push(root);
  const retire = vi.fn(async () => {}), store = createDurableHistoryStore({ root, maxStoreBytes: 2 ** 40, maxStagedBytes: 2 ** 40, retireProviderSession: retire });
  await store.append(id, input); await store.append(sibling, input); retire.mockClear();
  return { root, store, retire, path: join(root, `${key}.history.json`) };
}
it.each(["unparseable", "truncated", "insecure", "oversized", "unreadable", "symlink", "hardlink"])("exact and logical reset refuse %s canonical damage without moving it or changing a target", async (damage) => {
  const f = await fixture(), target = join(f.root, "fictional-target");
  if (damage === "symlink") { await fs.writeFile(target, "Fictional target bytes"); await fs.rm(f.path); await fs.symlink(target, f.path); }
  else if (damage === "hardlink") await fs.link(f.path, target);
  else if (damage === "unparseable") await fs.writeFile(f.path, "{}\n");
  else if (damage === "truncated") await fs.writeFile(f.path, "{");
  else if (damage === "insecure") await fs.chmod(f.path, 0o644);
  else if (damage === "oversized") await fs.truncate(f.path, 2 ** 28);
  const before = await fs.lstat(f.path), names = await fs.readdir(f.root), bytes = damage === "oversized" ? undefined : await fs.readFile(f.path);
  if (damage === "unreadable") {
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === f.path) throw Object.assign(new Error("Fictional unreadable record"), { code: "EACCES" });
      return open(...args);
    });
  }
  for (const reset of [() => f.store.reset(id), () => f.store.resetLogicalConversation(id)]) {
    await expect(reset()).rejects.toMatchObject({ code: "ERR_HISTORY_RESET_DAMAGED", retryable: false, message: expect.stringContaining(basename(f.path)) });
    const after = await fs.lstat(f.path);
    expect([after.ino, after.size, after.mode, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.size, before.mode, before.mtimeMs, before.ctimeMs]);
    if (bytes) expect(await fs.readFile(f.path)).toEqual(bytes);
    expect(await fs.readdir(f.root)).toEqual(names);
  }
  expect(f.retire).not.toHaveBeenCalled();
  if (damage === "symlink") expect(await fs.readlink(f.path)).toBe(target);
  if (damage === "symlink" || damage === "hardlink") expect(await fs.readFile(target)).toEqual(bytes);
  await f.store.append(sibling, [{ role: "user", content: "Fictional unrelated input" }]);
  expect((await f.store.load(sibling)).at(-1)?.content).toBe("Fictional unrelated input");
});
it("reset succeeds only after a stopped-writer canonical set-aside", async () => {
  const f = await fixture(); await fs.writeFile(f.path, "{}\n");
  await expect(f.store.reset(id)).rejects.toMatchObject({ code: "ERR_HISTORY_RESET_DAMAGED", message: expect.stringContaining("docs/runtime/sessions-concurrency.md#offline-repair-of-damaged-conversations") });
  // No active fixture owner: simulate an operator's backed-up, stopped-writer repair.
  await fs.rename(f.path, `${f.path}.damaged-1`); await f.store.reset(id);
  expect(await f.store.load(id)).toEqual([]); expect(await fs.readFile(`${f.path}.damaged-1`, "utf8")).toBe("{}\n");
  await f.store.append(id, [{ role: "user", content: "Fictional fresh input" }]);
  expect(await f.store.load(id)).toEqual([{ role: "user", content: "Fictional fresh input" }]);
});
it.each(["EIO", "EMFILE"])("%s remains an operational failure rather than permanent damage", async (code) => {
  const f = await fixture(), before = await fs.readFile(f.path), error = Object.assign(new Error("Fictional operational failure"), { code }), open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => { if (String(args[0]) === f.path) throw error; return open(...args); });
  await expect(f.store.reset(id)).rejects.toBe(error); expect(await fs.readFile(f.path)).toEqual(before);
});
it.each(["json", "json.tmp"])("damaged pending %s evidence refuses reset before canonical publication", async (suffix) => {
  const f = await fixture(), directory = join(f.root, ".pending-turns"); await fs.mkdir(directory, { mode: 0o700 });
  const name = `${key}.${"a".repeat(64)}.${"b".repeat(32)}.${suffix}`, path = join(directory, name);
  await fs.writeFile(path, "{fictional-damage}", { mode: suffix.endsWith("tmp") ? 0o644 : 0o600 });
  const canonical = await fs.readFile(f.path);
  await expect(f.store.reset(id)).rejects.toMatchObject({ code: "ERR_HISTORY_RESET_DAMAGED", retryable: false, message: expect.stringContaining(name) });
  expect(await fs.readFile(f.path)).toEqual(canonical); expect(await fs.readFile(path, "utf8")).toBe("{fictional-damage}");
  await f.store.append(sibling, [{ role: "user", content: "Fictional unrelated input" }]); expect(await fs.readFile(path, "utf8")).toBe("{fictional-damage}");
});
