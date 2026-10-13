import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { OwnedFileDamagedError } from "@mono-agent/harness/owned-fs.js";
import { PendingTurnPayloadStore } from "../durable-turn-payloads.js";
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
  const retire = vi.fn(async () => {}), store = createDurableHistoryStore({ root, maxStoreBytes: 2 ** 40, maxStagedBytes: 2 ** 40, retireProviderSession: retire, reconcileProviderSessionTurn: async () => ({ status: "absent" }) });
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

it.each(["exact", "logical"])("%s reset tolerates a generation removed between unlocked listing and inspection", async (kind) => {
  const f = await fixture(), turn = await f.store.beginProviderSessionTurn(id, "fictional-pending", { modelKey: "faux:fictional", reconciliation: {
    purpose: "execution", ownerKey: id, initial: { persistText: "Fictional pending input", timestamp: new Date(0).toISOString() } } });
  await turn.abort();
  const directory = join(f.root, ".pending-turns"), current = (await fs.readdir(directory)).find((name) => name.endsWith(".json"))!;
  const obsolete = current.replace(/\.[a-f0-9]{32}\.json$/u, `.${"0".repeat(32)}.json`);
  expect(obsolete).not.toBe(current); await fs.copyFile(join(directory, current), join(directory, obsolete));
  let vanished = false; const list = PendingTurnPayloadStore.prototype.list;
  vi.spyOn(PendingTurnPayloadStore.prototype, "list").mockImplementation(async function(this: PendingTurnPayloadStore) {
    const entries = await list.call(this);
    if (!vanished && entries.some((entry) => entry.name === obsolete)) { vanished = true; await fs.rm(join(directory, obsolete)); }
    return entries; // Emulate a concurrent writer collecting a listed obsolete generation.
  });
  await (kind === "exact" ? f.store.reset(id) : f.store.resetLogicalConversation(id));
  expect(vanished).toBe(true); expect(await f.store.load(id)).toEqual([]); expect(await f.store.load(sibling)).toEqual(input);
  expect((await f.store.stats()).activePreparedAppends).toBe(0);
  await f.store.append(id, [{ role: "user", content: "Fictional successor" }]);
});
it("exhausted canonical disappearance retries are not permanent reset damage", async () => {
  const f = await fixture(), open = fs.open, absent = Object.assign(new Error("Fictional concurrent replacement"), { code: "ENOENT" }); let attempts = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => { if (String(args[0]) === f.path) { attempts++; throw absent; } return open(...args); });
  await expect(f.store.reset(id)).rejects.toBe(absent); expect(attempts).toBe(3);
  vi.restoreAllMocks(); expect(await f.store.load(id)).toEqual(input); await f.store.reset(id);
});
it.each(["unparseable", "insecure"])("logical reset preserves a %s rollover member and its healthy logical fence", async (damage) => {
  const f = await fixture(), child = `${id}#2030-01-02`, childKey = createHash("sha256").update("mono-agent-history-v1\0").update(child).digest("hex");
  await f.store.append(child, input); const turn = await f.store.beginProviderSessionTurn(child, "fictional-child-turn"); await turn.abort(); f.retire.mockClear();
  const path = join(f.root, `${childKey}.history.json`), fencePath = join(f.root, ".locks", `${childKey}.dirty.json`);
  if (damage === "unparseable") await fs.writeFile(path, "{fictional-damage}"); else await fs.chmod(path, 0o644);
  const canonical = await fs.readFile(path), fence = await fs.readFile(fencePath), base = await fs.readFile(f.path);
  expect(JSON.parse(fence.toString()).logicalConversationKey).toBe(key);
  await expect(f.store.resetLogicalConversation(id)).rejects.toMatchObject({ code: "ERR_HISTORY_RESET_DAMAGED", retryable: false, message: expect.stringContaining(basename(path)) });
  expect(await fs.readFile(path)).toEqual(canonical); expect(await fs.readFile(fencePath)).toEqual(fence); expect(await fs.readFile(f.path)).toEqual(base);
  expect(f.retire).not.toHaveBeenCalled(); expect((await f.store.stats()).activePreparedAppends).toBe(0);
  await f.store.append(id, [{ role: "user", content: "Fictional same-logical successor" }]); // The refused reset released its logical claim.
  await f.store.append(sibling, [{ role: "user", content: "Fictional unrelated successor" }]); expect(await fs.readFile(fencePath)).toEqual(fence);
});
for (const kind of ["root", "logical", "legacy"]) it.each([523, 282])("types extended SQLite code %s in " + kind + " acquisition with the actual filename", async (errcode) => {
  const f = await fixture(), legacy = `${key}.sqlite`, canonical = await fs.readFile(f.path), exec = DatabaseSync.prototype.exec;
  if (kind === "legacy") await fs.writeFile(join(f.root, ".locks", legacy), "", { mode: 0o600 });
  const cause = Object.assign(new Error("Fictional extended SQLite failure"), { code: "ERR_SQLITE_ERROR", errcode }); let affected = "";
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    const name = basename(String(this.prepare("PRAGMA database_list").get()?.file));
    if (sql === "BEGIN IMMEDIATE" && (kind === "root" ? name === "root.sqlite" : kind === "legacy" ? name === legacy : name.startsWith("logical-session-shard-"))) { affected = name; throw cause; }
    return exec.call(this, sql);
  });
  const failure = await f.store.reset(id).catch((error: Error) => error);
  expect(affected).not.toBe(""); expect(failure).toMatchObject({ code: "ERR_HISTORY_RESET_DAMAGED", retryable: false, message: expect.stringContaining(affected), cause: { cause } });
  expect(await fs.readFile(f.path)).toEqual(canonical); vi.restoreAllMocks(); await f.store.reset(id);
});
it("uses the structured entry name when acquisition error prose has no filename", async () => {
  const f = await fixture(), exec = DatabaseSync.prototype.exec;
  const damaged = new OwnedFileDamagedError("root.sqlite"); damaged.message = "Fictional generic diagnostic";
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && basename(String(this.prepare("PRAGMA database_list").get()?.file)) === "root.sqlite") throw damaged;
    return exec.call(this, sql);
  });
  await expect(f.store.reset(id)).rejects.toMatchObject({ code: "ERR_HISTORY_RESET_DAMAGED", message: expect.stringContaining("root.sqlite"), cause: damaged });
});
