import { mkdtemp, rm, readdir, lstat, chmod, symlink, rename, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { JournalLocks } from "../journal-lock.js";
const roots = [];
async function root() { const r = await mkdtemp(join(tmpdir(), "harness-lock-")); roots.push(r); return r; }
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
function child(root) { return fork(new URL("./fixtures/lock-worker.mjs", import.meta.url), [root], { stdio: ["ignore", "ignore", "ignore", "ipc"] }); }
function phase(worker, name) { return new Promise((resolve, reject) => {
  const message = (event) => { if (event.phase === name) { cleanup(); resolve(event); } };
  const exit = (code) => { cleanup(); reject(new Error(`Lock worker exited before ${name}: ${code}`)); };
  const cleanup = () => { worker.off("message", message); worker.off("exit", exit); };
  worker.on("message", message); worker.on("exit", exit);
}); }

it("excludes a second process and kernel ownership releases after SIGKILL", async () => {
  const r = await root(); const locks = await JournalLocks.open(r); const worker = child(r);
  try {
    await phase(worker, "acquired");
    const path = join(locks.directory, "journal-fictional.sqlite");
    expect(await locks.withCatalog(() => locks.tryLock(path))).toBeNull();
    const exit = once(worker, "exit"); worker.kill("SIGKILL"); await exit;
    const next = await locks.acquireWriter("journal-fictional"); await locks.releaseWriter(next);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); }
}, 10000);

it("reclaims under the catalogue without retaining a split-inode waiter", async () => {
  const r = await root(); const locks = await JournalLocks.open(r);
  const writer = await locks.acquireWriter("journal-fictional"); const worker = child(r);
  const acquired = phase(worker, "acquired");
  try {
    await phase(worker, "blocked");
    await locks.releaseWriter(writer, async () => true);
    await acquired;
    const path = join(locks.directory, "journal-fictional.sqlite");
    expect(await locks.withCatalog(() => locks.tryLock(path))).toBeNull();
    const released = phase(worker, "released"); const exit = once(worker, "exit"); worker.send({ release: true }); await released; await exit;
    const next = await locks.acquireWriter("journal-fictional"); await locks.releaseWriter(next, async () => true);
    expect(await readdir(locks.directory)).toEqual(["catalog.sqlite"]);
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); }
}, 10000);

it("reclaims repeated retired epochs but never the permanent catalogue mutex", async () => {
  const locks = await JournalLocks.open(await root());
  for (let i = 0; i < 20; i++) {
    const writer = await locks.acquireWriter(`epoch-${i}`);
    await locks.releaseWriter(writer, async () => true);
  }
  const writer = await locks.acquireWriter("retained");
  await locks.releaseWriter(writer, async () => false);
  expect((await readdir(locks.directory)).sort()).toEqual(["catalog.sqlite", "retained.sqlite"]);
});

it("rejects insecure or symlinked roots and lock files", async () => {
  const r = await root(); const locks = await JournalLocks.open(r);
  const outside = join(r, "outside.sqlite"); await writeFile(outside, "", { mode: 0o600 });
  await symlink(outside, join(locks.directory, "symlink.sqlite"));
  await expect(locks.acquireWriter("symlink")).rejects.toThrow("ownership unavailable");
  await chmod(locks.catalogPath, 0o644);
  await expect(locks.acquireWriter("blocked")).rejects.toThrow("ownership unavailable");
  await chmod(r, 0o775); await expect(JournalLocks.open(r)).rejects.toThrow("ownership unavailable");
});

it("pins the root identity and never recreates a purged root", async () => {
  const r = await root(); const locks = await JournalLocks.open(r);
  await rename(join(r, "mono-v2"), join(r, "quarantined"));
  await expect(locks.acquireWriter("late")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(r, "mono-v2"))).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(join(r, "mono-v2"), { mode: 0o700 });
  await expect(locks.acquireWriter("late")).rejects.toThrow("ownership unavailable");
});
