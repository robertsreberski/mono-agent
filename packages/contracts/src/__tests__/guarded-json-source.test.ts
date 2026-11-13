import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile, stat, symlink, link, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { readSettingsJson, writeSettingsJson } from "../json-source.js";
const failures = vi.hoisted(() => ({ stage: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (failures.stage === "temp" && String(args[0]).includes(".mono-agent-")) throw new Error("injected temp failure");
      return await fs.open(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if ((failures.stage === "backup" && String(args[1]).endsWith(".bak")) || (failures.stage === "publish" && String(args[1]).endsWith("config.json"))) throw new Error("injected rename failure");
      return await fs.rename(...args);
    },
  };
});
const roots: string[] = [];
afterEach(async () => { failures.stage = ""; await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); roots.length = 0; });
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
    expect(await readdir(f.root)).toEqual(kind === "validator" ? [".gitignore", "config.json"] : ["config.json"]);
  }
});
it("detects a concurrent manual edit at publication and cleans temporary files", async () => {
  const f = await fixture();
  await expect(writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: f.version, validate: async () => { await writeFile(f.path, '{"manual":true}'); } } })).rejects.toMatchObject({ code: "config_conflict" });
  expect(await readFile(f.path, "utf8")).toBe('{"manual":true}');
  expect(await readdir(f.root)).toEqual([".gitignore", "config.json"]);
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
  const backup = JSON.parse(await readFile(`${f.path}.bak`, "utf8"));
  expect(Buffer.from(backup.previousBase64, "base64").toString()).toBe(f.bytes);
  expect((await readdir(f.root)).some((name) => name.endsWith(".tmp") || name.endsWith(".write-lock"))).toBe(false);
});

it.each(["temp", "backup", "publish"])("preserves durable config on injected %s write failure", async (stage) => {
  const f = await fixture(); await writeFile(`${f.path}.bak`, "prior backup", { mode: 0o600 }); failures.stage = stage;
  await expect(writeSettingsJson({ path: f.path, patch: { added: true }, guarded: { expectedVersion: f.version, validate: async () => {} } })).rejects.toThrow();
  expect(await readFile(f.path, "utf8")).toBe(f.bytes);
  if (stage !== "publish") expect(await readFile(`${f.path}.bak`, "utf8")).toBe("prior backup");
  else expect(Buffer.from(JSON.parse(await readFile(`${f.path}.bak`, "utf8")).previousBase64, "base64").toString()).toBe(f.bytes);
  expect((await readdir(f.root)).some((name) => name.endsWith(".tmp") || name.endsWith(".write-lock"))).toBe(false);
});
