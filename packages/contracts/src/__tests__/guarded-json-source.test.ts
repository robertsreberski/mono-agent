import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, stat, chmod, symlink, link, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { readSettingsJson, writeSettingsJson } from "../json-source.js";
const failures = vi.hoisted(() => ({ stage: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      if (failures.stage === "edit-parent" && !String(args[0]).endsWith("config.json")) {
        failures.stage = ""; await fs.writeFile(join(String(args[0]), "config.json"), '{"manual":true}');
      }
      return fs.lstat(...args);
    },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      if (String(args[0]).includes(".mono-agent-") && String(args[0]).endsWith(".tmp")) {
        const ignore = await fs.readFile(join(String(args[0]).slice(0, String(args[0]).lastIndexOf("/")), ".gitignore"), "utf8");
        expect(ignore).toContain("/config.json.write-lock/\n");
        expect(ignore).toContain("/config.json.mono-agent-*.tmp\n");
      }
      return fs.mkdir(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      if (["ELOOP", "EMLINK"].includes(failures.stage) && String(args[0]).endsWith("config.json")) throw Object.assign(new Error("fictional system diagnostic"), { code: failures.stage });
      if (failures.stage === "temp" && String(args[0]).includes(".mono-agent-")) throw new Error("injected temp failure");
      if (failures.stage === "sync") {
        try {
          // Only the published config directory sync fails; lock-staging
          // syncs must succeed so the write reaches publication.
          if (!String(args[0]).includes(".mono-agent-") && (await fs.lstat(String(args[0]))).isDirectory()) throw Object.assign(new Error("injected sync failure"), { code: "EIO" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "EIO") throw error;
        }
      }
      const handle = await fs.open(...args);
      if (failures.stage === "released-owner" && String(args[0]).includes(".write-lock/owner-")) {
        failures.stage = "";
        await fs.unlink(String(args[0]));
        await fs.rmdir(String(args[0]).slice(0, String(args[0]).lastIndexOf("/")));
      }
      return handle;
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if ((failures.stage === "backup" && String(args[1]).endsWith(".bak")) || (failures.stage === "publish" && String(args[1]).endsWith("config.json"))) throw new Error("injected rename failure");
      const result = await fs.rename(...args);
      if (failures.stage === "final-parent" && String(args[1]).endsWith(".bak")) failures.stage = "edit-parent";
      return result;
    },
  };
});
const roots: string[] = [];
afterEach(async () => { failures.stage = ""; vi.unstubAllEnvs(); await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); roots.length = 0; });
async function fixture(bytes = '{ "unrelated": { "keep": true }, "credential": "fictional-inline-value" }\r\n') {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guarded-json-"))); roots.push(root);
  const path = join(root, "config.json"); await writeFile(path, bytes);
  return { root, path, bytes, version: (await readSettingsJson(path)).version };
}
it("keeps exact prior bytes in one private ignored backup, preserving sparse fields and legacy callers", async () => {
  const f = await fixture(); execFileSync("git", ["init", "-q", f.root]);
  const log = vi.fn(); const validate = vi.fn(async (candidate, path) => { expect(JSON.parse(await readFile(path, "utf8"))).toEqual(candidate); });
  const result = await writeSettingsJson({ path: f.path, patch: { unrelated: { added: 1 } }, guarded: { expectedVersion: f.version, validate, log } });
  expect(validate).toHaveBeenCalledOnce();
  const backup = JSON.parse(await readFile(`${f.path}.bak`, "utf8"));
  expect(Buffer.from(backup.previousBase64, "base64").toString()).toBe(f.bytes);
  expect(backup.intendedSha256).toBe(result.version);
  expect(result.version).toBe(createHash("sha256").update(await readFile(f.path)).digest("hex"));
  expect((await stat(`${f.path}.bak`)).mode & 0o777).toBe(0o600);
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  execFileSync("git", ["-C", f.root, "check-ignore", "--quiet", "config.json.bak"]);
  expect(log).toHaveBeenCalledWith("Capability configuration saved; activation requires a fresh start.");
  expect(JSON.stringify(log.mock.calls)).not.toContain("fictional-inline-value");
  await writeSettingsJson({ path: f.path, patch: { second: true }, guarded: { expectedVersion: result.version, validate } });
  expect((await readdir(f.root)).filter((name) => name.endsWith(".bak"))).toEqual(["config.json.bak"]);
  expect((await readSettingsJson(f.path)).json.unrelated).toEqual({ keep: true, added: 1 });
  await writeSettingsJson({ path: f.path, patch: { legacy: true } });
  expect((await readSettingsJson(f.path)).json.legacy).toBe(true);
});
it("rejects stale versions, duplicate keys (including escaped aliases), and validator failures before backup/publication", async () => {
  for (const kind of ["version", "duplicates", "validator"] as const) {
    const f = await fixture(kind === "duplicates" ? '{"a":1,"\\u0061":2}' : undefined);
    await expect(writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: kind === "version" ? "0".repeat(64) : f.version, validate: async () => { if (kind === "validator") throw new Error("injected validation failure"); } } })).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).toBe(f.bytes);
    expect((await readdir(f.root)).sort()).toEqual([".gitignore", "config.json"]);
  }
});
it("detects a concurrent manual edit at publication and cleans temporary files", async () => {
  const f = await fixture();
  await expect(writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: f.version, validate: async () => { await writeFile(f.path, '{"manual":true}'); } } })).rejects.toMatchObject({ code: "config_conflict" });
  expect(await readFile(f.path, "utf8")).toBe('{"manual":true}');
  expect((await readdir(f.root)).sort()).toEqual([".gitignore", "config.json"]);
});
it("serializes official writers across the same config, including legacy callers", async () => {
  const f = await fixture(); let release!: () => void; let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const first = writeSettingsJson({ path: f.path, patch: { first: true }, guarded: { expectedVersion: f.version, validate: async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); } } });
  await inside;
  const second = writeSettingsJson({ path: f.path, patch: { second: true } });
  release(); await first; await second;
  expect((await readSettingsJson(f.path)).json).toMatchObject({ first: true, second: true });
});
it("refuses symlink/hardlink targets, unsafe ignore files, and tracked backups without changing prior bytes", async () => {
  for (const kind of ["symlink", "hardlink", "ignore", "backup", "tracked"] as const) {
    const f = await fixture(); const other = join(f.root, "other"); await writeFile(other, "untouched");
    if (kind === "symlink" || kind === "hardlink") { await rm(f.path); if (kind === "symlink") await symlink(other, f.path); else await link(other, f.path); }
    if (kind === "ignore") await symlink(other, join(f.root, ".gitignore"));
    if (kind === "backup") await symlink(other, `${f.path}.bak`);
    if (kind === "tracked") { execFileSync("git", ["init", "-q", f.root]); await writeFile(`${f.path}.bak`, "prior"); execFileSync("git", ["-C", f.root, "add", "config.json.bak"]); }
    await expect(writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: (await readSettingsJson(f.path).catch(() => ({ version: f.version }))).version, validate: async () => {} } })).rejects.toThrow();
    expect(await readFile(other, "utf8")).toBe("untouched");
    if (!["symlink", "hardlink"].includes(kind)) expect(await readFile(f.path, "utf8")).toBe(f.bytes);
  }
});

it("retains prior config and recoverable backup on an injected final rename failure", async () => {
  const f = await fixture();
  await expect(writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: f.version, validate: async (_candidate, temp) => { await rm(temp); } } })).rejects.toThrow();
  expect(await readFile(f.path, "utf8")).toBe(f.bytes);
  // A save that never publishes must not leave a slot: the previous state is
  // restored, or the slot is cleared when there was none.
  await expect(readFile(`${f.path}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(f.root)).some((name) => name.endsWith(".tmp") || name.endsWith(".write-lock"))).toBe(false);
});

it.each(["temp", "backup", "publish"])("preserves durable config on injected %s write failure", async (stage) => {
  const f = await fixture(); await writeFile(`${f.path}.bak`, "prior backup", { mode: 0o600 }); failures.stage = stage;
  await expect(writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: f.version, validate: async () => {} } })).rejects.toThrow();
  expect(await readFile(f.path, "utf8")).toBe(f.bytes);
  expect(await readFile(`${f.path}.bak`, "utf8")).toBe("prior backup");
  expect((await readdir(f.root)).some((name) => name.endsWith(".tmp") || name.endsWith(".write-lock"))).toBe(false);
});

async function abandonedLock(path: string, pid: number, processStartId?: string) {
  const token = "11111111-1111-4111-8111-111111111111";
  await mkdir(`${path}.write-lock`, { mode: 0o700 });
  await writeFile(`${path}.write-lock/owner-${token}.json`, JSON.stringify({ version: 1, token, pid, startedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", ...(processStartId === undefined ? {} : { processStartId }) }), { mode: 0o600 });
}
it("recovers a provably dead lock owner for a legacy write and cleans an abandoned empty lock", async () => {
  const f = await fixture();
  const deadPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
  await abandonedLock(f.path, deadPid);
  await writeSettingsJson({ path: f.path, patch: { legacy: true } });
  await mkdir(`${f.path}.write-lock`, { mode: 0o700 });
  await writeSettingsJson({ path: f.path, patch: { recoveredEmpty: true } });
  expect((await readSettingsJson(f.path)).json).toMatchObject({ legacy: true, recoveredEmpty: true });
  expect((await readdir(f.root)).some((name) => name.endsWith(".write-lock"))).toBe(false);
});
it("uses start identity to recover a reused PID but never steals from an unverifiable live holder", async () => {
  const f = await fixture();
  if (process.platform === "darwin" || process.platform === "linux") {
    await abandonedLock(f.path, process.pid, "fictional-previous-process-start");
    await writeSettingsJson({ path: f.path, patch: { reused: true } });
  }
  await abandonedLock(f.path, process.pid);
  const start = performance.now();
  await expect(writeSettingsJson({ path: f.path, patch: { stolen: true } })).rejects.toMatchObject({ code: "config_conflict" });
  expect(performance.now() - start).toBeGreaterThanOrEqual(1400);
  expect(performance.now() - start).toBeLessThan(5000);
  expect((await readSettingsJson(f.path)).json).not.toHaveProperty("stolen");
});
it.each([false, true])("allows private guarded writes when git is unavailable (repository=%s)", async (repository) => {
  const f = await fixture(); if (repository) execFileSync("git", ["init", "-q", f.root]);
  vi.stubEnv("PATH", join(f.root, "no-executables"));
  await writeSettingsJson({ path: f.path, patch: { saved: true }, guarded: { expectedVersion: f.version, validate: async () => {} } });
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  expect((await stat(`${f.path}.bak`)).mode & 0o777).toBe(0o600);
});
it.each(["ELOOP", "EMLINK"])("maps %s to the fixed safe refusal", async (stage) => {
  const f = await fixture(); failures.stage = stage;
  await expect(writeSettingsJson({ path: f.path, patch: {}, guarded: { expectedVersion: f.version, validate: async () => {} } })).rejects.toMatchObject({ code: "unsafe_config_write", message: "Configuration write refused; inspect the config and backup in the owner terminal." });
  expect(await readFile(f.path, "utf8")).toBe(f.bytes);
});
it.each([1, 2, 3, 4, 5, 6, 7, 8])("waits for cross-process writers without losing patches (contention round %s)", async () => {
  const f = await fixture();
  const moduleUrl = new URL("../../dist/json-source.js", import.meta.url).href;
  const first = spawn(process.execPath, ["--input-type=module", "-e", `import { writeSettingsJson } from ${JSON.stringify(moduleUrl)}; await writeSettingsJson({ path: ${JSON.stringify(f.path)}, patch: { firstProcess: true }, guarded: { expectedVersion: ${JSON.stringify(f.version)}, validate: async () => { process.stdout.write('locked'); await new Promise(r => setTimeout(r, 600)); } } });`], { stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = ""; first.stderr.on("data", (chunk) => { diagnostic += chunk; });
  const done = new Promise<void>((resolve, reject) => { first.on("error", reject); first.on("close", (status) => status === 0 ? resolve() : reject(new Error(`First writer failed: ${diagnostic}`))); });
  try {
    await new Promise<void>((resolve, reject) => { first.stdout.on("data", () => resolve()); first.on("error", reject); first.on("exit", (status) => { if (status !== 0) reject(new Error(diagnostic)); }); });
    const names = await readdir(`${f.path}.write-lock`);
    const owner = JSON.parse(await readFile(`${f.path}.write-lock/${names[0]}`, "utf8"));
    expect(owner).toMatchObject({ version: 1, pid: first.pid, startedAt: expect.any(String), createdAt: expect.any(String) });
    if (process.platform === "darwin" || process.platform === "linux") expect(owner.processStartId).toEqual(expect.any(String));
    await new Promise<void>((resolve, reject) => {
      const second = spawn(process.execPath, ["--input-type=module", "-e", `import { writeSettingsJson } from ${JSON.stringify(moduleUrl)}; await writeSettingsJson({ path: ${JSON.stringify(f.path)}, patch: { secondProcess: true } });`], { stdio: "pipe" });
      let stderr = ""; second.stderr.on("data", (chunk) => { stderr += chunk; });
      second.on("error", reject); second.on("close", (status) => status === 0 ? resolve() : reject(new Error(`Second writer failed: ${stderr}`)));
    });
    await done;
    expect((await readSettingsJson(f.path)).json).toMatchObject({ firstProcess: true, secondProcess: true });
    expect((await readdir(f.root)).some((name) => name.endsWith(".tmp") || name.endsWith(".write-lock"))).toBe(false);
  } finally { first.kill(); }
});

it("handles an owner released between open and fstat without refusing the next writer", async () => {
  const f = await fixture(); await abandonedLock(f.path, process.pid); failures.stage = "released-owner";
  await writeSettingsJson({ path: f.path, patch: { handedOff: true } });
  expect((await readSettingsJson(f.path)).json.handedOff).toBe(true);
});

it("rechecks config bytes after the final parent identity check, clearing a never-published slot", async () => {
  const f = await fixture(); failures.stage = "final-parent";
  await expect(writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: f.version, validate: async () => {} } })).rejects.toMatchObject({ code: "config_conflict" });
  expect(await readFile(f.path, "utf8")).toBe('{"manual":true}');
  await expect(readFile(`${f.path}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses group/world-writable ignore rules even when all required rules already exist", async () => {
  const f = await fixture();
  await writeSettingsJson({ path: f.path, patch: { first: true } });
  const before = await readFile(f.path);
  for (const mode of [0o620, 0o602]) {
    await chmod(join(f.root, ".gitignore"), mode);
    await expect(writeSettingsJson({ path: f.path, patch: { second: true }, guarded: { expectedVersion: (await readSettingsJson(f.path)).version, validate: async () => {} } })).rejects.toMatchObject({ code: "unsafe_config_write" });
    expect(await readFile(f.path)).toEqual(before);
    expect((await readdir(f.root)).some((name) => name.endsWith(".tmp") || name.endsWith(".write-lock"))).toBe(false);
  }
});

it("reads the backup slot without throwing for missing or malformed envelopes", async () => {
  const { readSettingsJsonBackup } = await import("../guarded-json-source.js");
  const f = await fixture();
  expect(await readSettingsJsonBackup(f.path)).toEqual({ status: "missing" });
  await writeFile(`${f.path}.bak`, "not json", { mode: 0o600 });
  expect(await readSettingsJsonBackup(f.path)).toEqual({ status: "corrupt" });
  for (const envelope of [{ version: 1 }, { version: 1, previousMissing: false, previousBase64: "!!!", intendedSha256: "a".repeat(64) }, { version: 1, previousMissing: false, previousBase64: "", intendedSha256: "short", extra: true }]) {
    await writeFile(`${f.path}.bak`, JSON.stringify(envelope));
    expect(await readSettingsJsonBackup(f.path)).toEqual({ status: "corrupt" });
  }
  await writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: f.version, validate: async () => {} } });
  const backup = await readSettingsJsonBackup(f.path);
  expect(backup.status).toBe("ok");
  if (backup.status === "ok") {
    expect(backup.backup.previousMissing).toBe(false);
    expect(Buffer.from(backup.backup.previousBase64, "base64").toString()).toBe(f.bytes);
  }
});

it("restores exact prior bytes through the guarded protocol and consumes the slot", async () => {
  const { readSettingsJsonBackup, restoreGuardedSettingsJson } = await import("../guarded-json-source.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "guarded-restore-"))); roots.push(root);
  const path = join(root, "config.json");
  const original = '{\r\n  "unrelated": { "keep": true },\r\n  "credential": "fictional-inline-value"\r\n}\r\n';
  await writeFile(path, original);
  const version = (await readSettingsJson(path)).version;
  const saved = await writeSettingsJson({ path, patch: { unrelated: { added: 1 } }, guarded: { expectedVersion: version, validate: async () => {} } });
  expect(await readFile(path, "utf8")).not.toBe(original);
  const backup = await readSettingsJsonBackup(path);
  if (backup.status !== "ok") throw new Error("Expected an undoable backup slot.");
  const restored = await restoreGuardedSettingsJson(path, Buffer.from(backup.backup.previousBase64, "base64"), {
    expectedVersion: saved.version, validate: async (candidate, candidatePath) => {
      expect(candidate).toEqual(JSON.parse(original));
      expect(JSON.parse(await readFile(candidatePath, "utf8"))).toEqual(candidate);
    },
  });
  expect(await readFile(path, "utf8")).toBe(original);
  expect(restored.version).toBe(version);
  expect(await readSettingsJsonBackup(path)).toEqual({ status: "missing" });
  expect((await readdir(root)).some((name) => name.endsWith(".tmp") || name.endsWith(".write-lock"))).toBe(false);
});

it("refuses a stale version or an invalid prior without publishing", async () => {
  const { restoreGuardedSettingsJson } = await import("../guarded-json-source.js");
  const f = await fixture();
  const saved = await writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: f.version, validate: async () => {} } });
  expect(saved.version).not.toBe(f.version);
  await expect(restoreGuardedSettingsJson(f.path, Buffer.from(f.bytes), { expectedVersion: f.version, validate: async () => {} })).rejects.toMatchObject({ code: "config_conflict" });
  for (const prior of ['not json', '{"a":1,"a":2}', '[1,2]', '""']) {
    await expect(restoreGuardedSettingsJson(f.path, Buffer.from(prior), { expectedVersion: saved.version, validate: async () => {} })).rejects.toMatchObject({ code: "unsafe_config_write" });
  }
  expect(await readFile(f.path, "utf8")).not.toBe(f.bytes);
  expect((await readdir(f.root)).some((name) => name.endsWith(".tmp") || name.endsWith(".write-lock"))).toBe(false);
});

it("reports a definite conflict when the restore rename fails, leaving the config and slot usable", async () => {
  const { readSettingsJsonBackup, restoreGuardedSettingsJson } = await import("../guarded-json-source.js");
  const f = await fixture();
  const saved = await writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: f.version, validate: async () => {} } });
  failures.stage = "publish";
  const backup = await readSettingsJsonBackup(f.path);
  if (backup.status !== "ok") throw new Error("Expected an undoable backup slot.");
  await expect(restoreGuardedSettingsJson(f.path, Buffer.from(backup.backup.previousBase64, "base64"), { expectedVersion: saved.version, validate: async () => {} })).rejects.toMatchObject({ code: "config_conflict" });
  expect(await readFile(f.path, "utf8")).not.toBe(f.bytes);
  // Nothing was published: the slot still fences, so a retry stays available instead of uncertain.
  const retry = await readSettingsJsonBackup(f.path);
  expect(retry.status).toBe("ok");
  if (retry.status === "ok") expect(retry.backup.intendedSha256).toBe(saved.version);
  expect((await readdir(f.root)).some((name) => name.endsWith(".tmp") || name.endsWith(".write-lock"))).toBe(false);
});

it.each(["directory", "symlink", "unreadable"])("degrades an %s backup slot to unreadable instead of throwing", async (kind) => {
  const { readSettingsJsonBackup } = await import("../guarded-json-source.js");
  const f = await fixture();
  const target = join(f.root, "other");
  if (kind === "directory") { await rm(`${f.path}.bak`, { force: true }); await mkdir(`${f.path}.bak`); }
  else if (kind === "symlink") { await writeFile(target, "other"); await symlink(target, `${f.path}.bak`); }
  else { await writeFile(`${f.path}.bak`, "prior", { mode: 0o600 }); await chmod(`${f.path}.bak`, 0o000); }
  try {
    expect(await readSettingsJsonBackup(f.path)).toEqual({ status: "unreadable" });
  } finally {
    if (kind === "unreadable") await chmod(`${f.path}.bak`, 0o600).catch(() => undefined);
  }
});

it("keeps the new backup envelope when only the post-publish sync fails", async () => {
  const f = await fixture();
  await writeFile(join(f.root, ".gitignore"), "/config.json.bak\n/config.json.tmp\n/config.json.mono-agent-*.tmp\n/config.json.write-lock/\n");
  failures.stage = "sync";
  await expect(writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: f.version, validate: async () => {} } })).rejects.toThrow();
  const published = JSON.parse(await readFile(f.path, "utf8"));
  expect(published).toMatchObject({ unrelated: { keep: true }, added: true });
  const backup = JSON.parse(await readFile(`${f.path}.bak`, "utf8"));
  expect(backup.intendedSha256).toBe(createHash("sha256").update(await readFile(f.path)).digest("hex"));
  expect(Buffer.from(backup.previousBase64, "base64").toString()).toBe(f.bytes);
  expect((await readdir(f.root)).some((name) => name.endsWith(".tmp") || name.endsWith(".write-lock"))).toBe(false);
});

it("reports a committed restore as success when the directory sync fails", async () => {
  const { readSettingsJsonBackup, restoreGuardedSettingsJson } = await import("../guarded-json-source.js");
  const f = await fixture();
  const saved = await writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: f.version, validate: async () => {} } });
  const backup = await readSettingsJsonBackup(f.path);
  if (backup.status !== "ok") throw new Error("Expected an undoable backup slot.");
  failures.stage = "sync";
  const restored = await restoreGuardedSettingsJson(f.path, Buffer.from(backup.backup.previousBase64, "base64"), { expectedVersion: saved.version, validate: async () => {} });
  expect(restored.version).toBe(f.version);
  expect(await readFile(f.path, "utf8")).toBe(f.bytes);
  expect(await readSettingsJsonBackup(f.path)).toEqual({ status: "missing" });
});
