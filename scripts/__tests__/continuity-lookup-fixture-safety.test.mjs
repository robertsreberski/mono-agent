import { EventEmitter } from "node:events";
import { fixtureDriverReply, stopFixtureDrivers } from "./fixtures/lookup-pilot-reply.mjs";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyLeafSnapshot } from "./fixtures/lookup-leaf-witness.mjs";
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "lookup-leaf-fictional-")); roots.push(root); return root; }

it("recursively witnesses nested leaf metadata without following directory symlinks", async () => {
  const root = await fixture(), leaf = join(root, "leaf"), outside = join(root, "outside");
  await mkdir(join(leaf, "nested"), {recursive: true}); await mkdir(outside);
  await writeFile(join(leaf, "nested/file"), "fictional"); await writeFile(join(outside, "untouched"), "outside");
  await symlink(outside, join(leaf, "external")); const before = await dependencyLeafSnapshot([leaf]);
  expect(before.map(row => row.slice(0, 2))).toEqual([[leaf, "directory"], [join(leaf, "external"), "symlink"], [join(leaf, "nested"), "directory"], [join(leaf, "nested/file"), "file"]]);
  expect(before.every(row => row.length === 7 && row.slice(2).every(value => /^\d+$/u.test(value)))).toBe(true);
  await writeFile(join(outside, "untouched"), "outside changed"); expect(await dependencyLeafSnapshot([leaf])).toEqual(before);
});
it("detects a nested write and a symlink replacement without relying on top-level entries", async () => {
  const root = await fixture(), leaf = join(root, "leaf"); await mkdir(leaf);
  const file = join(leaf, "file"), link = join(leaf, "link"); await writeFile(file, "a"); await symlink("file", link);
  const before = await dependencyLeafSnapshot([leaf]); await writeFile(file, "written");
  expect(await dependencyLeafSnapshot([leaf])).not.toEqual(before);
  const afterWrite = await dependencyLeafSnapshot([leaf]); await unlink(link); await symlink("fictional-other", link);
  expect(await dependencyLeafSnapshot([leaf])).not.toEqual(afterWrite);
});
it("includes ctime and refuses a disappeared witnessed leaf", async () => {
  const root = await fixture(), leaf = join(root, "leaf"); await mkdir(leaf); const path = join(leaf, "file");
  await writeFile(path, "same size"); await utimes(path, 1, 1); const before = await dependencyLeafSnapshot([leaf]);
  await writeFile(path, "new bytes"); await utimes(path, 1, 1); const after = await dependencyLeafSnapshot([leaf]);
  const beforeFile = before.find(row => row[0] === path), afterFile = after.find(row => row[0] === path);
  expect(afterFile[5]).toBe(beforeFile[5]);
  expect(afterFile[6]).not.toBe(beforeFile[6]);
  await rm(leaf, {recursive: true}); await expect(dependencyLeafSnapshot([leaf])).rejects.toMatchObject({code: "ENOENT"});
});

it("waits for a buffered reply delivered after exit but before channel close", async () => {
  const child = new EventEmitter(); child.kill = vi.fn(); child.send = vi.fn((_input, done) => done());
  const reply = fixtureDriverReply(child, {fictional: true}); let settled = false; reply.then(() => { settled = true; });
  child.emit("message", {ready: true}); expect(child.send).toHaveBeenCalledTimes(1);
  child.emit("exit", 0, null); await Promise.resolve(); expect(settled).toBe(false);
  child.emit("message", {failed: "lookup_pilot_real_route_unavailable"}); child.emit("close", 0, null);
  expect(await reply).toEqual({failed: "lookup_pilot_real_route_unavailable"}); expect(child.kill).not.toHaveBeenCalled();
});
it("fails loudly when channel close proves the driver sent no reply", async () => {
  const child = new EventEmitter(); child.kill = vi.fn(); const reply = fixtureDriverReply(child, {});
  const rejected = expect(reply).rejects.toMatchObject({code: "fixture_reply_missing"}); child.emit("exit", 0, null); child.emit("close", 0, null); await rejected;
});
it("reports an input-send error instead of waiting for an undefined reply", async () => {
  const child = new EventEmitter(); child.kill = vi.fn(); child.send = (_input, done) => done(Object.assign(new Error("fictional closed channel"), {code: "ERR_IPC_CHANNEL_CLOSED"}));
  const reply = fixtureDriverReply(child, {}), rejected = expect(reply).rejects.toMatchObject({code: "ERR_IPC_CHANNEL_CLOSED"}); child.emit("message", {ready: true}); await rejected;
});

it("stops the driver and awaits its close before taking the final probe witness", async () => {
  const probes = [], child = {exitCode: null, signalCode: null, kill: vi.fn()};
  let close; const exit = new Promise(resolve => { close = resolve; });
  const stopped = stopFixtureDrivers([{child, exit}]); let read = false;
  const witness = stopped.then(() => { read = true; return [...probes]; });
  expect(child.kill).toHaveBeenCalledWith("SIGKILL"); await Promise.resolve(); expect(read).toBe(false);
  probes.push({pid: 123, startIdentity: "fictional-late-probe"}); child.signalCode = "SIGKILL"; close();
  expect(await witness).toEqual([{pid: 123, startIdentity: "fictional-late-probe"}]);
});
