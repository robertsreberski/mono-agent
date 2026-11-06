import { expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import child from "node:child_process";
import workers from "node:worker_threads";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialedHomeCanary } from "./fixtures/lookup-credentialed-home.mjs";
import { installLookupProofScope } from "./fixtures/lookup-proof-scope.mjs";

async function fixture() {
  const ownedRoot = await fsp.mkdtemp(join(fs.realpathSync(tmpdir()), "lookup-canary-"));
  const home = join(ownedRoot, "home"), root = join(home, "checkout"), evidence = join(ownedRoot, "evidence");
  await fsp.mkdir(root, {recursive: true}); await fsp.mkdir(evidence);
  return {ownedRoot, root, home, testHome: home, evidence, mode: "unit", credential: join(ownedRoot, "credential/auth.json")};
}

it("covers path APIs, ROOT script code and strict noncode reads without permitting home data", async () => {
  const p = await fixture(), path = join(p.home, "private"), script = join(p.root, "scripts/lib/module.mjs");
  await fsp.mkdir(join(p.root, "scripts/lib"), {recursive: true}); await fsp.writeFile(script, "export {};\n");
  const guard = credentialedHomeCanary(p);
  try {
    for (const [object, names] of [[fs, ["existsSync", "exists", "statfsSync", "statfs", "globSync", "glob", "openAsBlob", "watch", "watchFile", "lchownSync", "lchown", "lchmodSync", "lchmod", "lutimesSync", "lutimes"]], [fsp, ["statfs", "glob", "watch", "lchown", "lchmod", "lutimes"]]]) for (const name of names) {
      if (typeof object[name] !== "function") continue;
      expect(() => object[name](path, {cwd: p.home})).toThrow("test_real_home_denied");
    }
    guard.constructed(); expect(fs.existsSync(script)).toBe(true); expect(fs.readFileSync(script, "utf8")).toBe("export {};\n");
    expect(guard.result().scriptCodeAccesses).toEqual([{api: "existsSync", path: "scripts/lib/module.mjs"}, {api: "readFileSync", path: "scripts/lib/module.mjs"}]);
    expect(() => fs.existsSync(join(p.root, "auth.json"))).toThrow("test_root_data_read_denied");
    expect(() => fs.readFileSync(join(p.root, "data.json"))).toThrow("test_root_data_read_denied");
    expect(() => fs.writeFileSync(script, "no")).toThrow("test_real_home_denied");
  } finally {guard.restore(); await fsp.rm(p.ownedRoot, {recursive: true, force: true});}
}, 30000);

it("opens and consumes an owned Blob while refusing home and noncode ROOT Blob reads", async () => {
  const p = await fixture(), owned = join(p.evidence, "blob.txt"), script = join(p.root, "scripts/lib/blob.mjs");
  await fsp.mkdir(join(p.root, "scripts/lib"), {recursive: true});
  await fsp.writeFile(owned, "fictional blob bytes"); await fsp.writeFile(script, "export {};\n");
  const guard = credentialedHomeCanary(p);
  try {
    guard.constructed();
    expect(await (await fs.openAsBlob(owned)).text()).toBe("fictional blob bytes");
    expect(await (await fs.openAsBlob(script)).text()).toBe("export {};\n");
    expect(guard.result().scriptCodeAccesses).toContainEqual({api: "openAsBlob", path: "scripts/lib/blob.mjs"});
    expect(() => fs.openAsBlob(join(p.home, "private.txt"))).toThrow("test_real_home_denied");
    expect(() => fs.openAsBlob(join(p.root, "private.txt"))).toThrow("test_root_data_read_denied");
  } finally {guard.restore(); await fsp.rm(p.ownedRoot, {recursive: true, force: true});}
}, 30000);

it.each(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])("refuses non-allowlisted child_process.%s", async family => {
  const p = await fixture(), scope = installLookupProofScope(p);
  try {expect(() => child[family]("/bin/echo", ["denied"])).toThrow("test_subprocess_denied");}
  finally {scope.restore(); await fsp.rm(p.ownedRoot, {recursive: true, force: true});}
}, 30000);

it("propagates the filesystem, subprocess and egress canaries into nested workers", async () => {
  const p = await fixture(), scope = installLookupProofScope(p);
  try {
    const worker = new workers.Worker(new URL("./fixtures/lookup-scope-worker.mjs", import.meta.url), {workerData: {nested: true}});
    const [result] = await once(worker, "message"); await once(worker, "exit");
    for (const value of [result, result.nested]) {
      expect(value).toMatchObject({canaries: 9, unexpected: [], files: {canaries: 8, denied: []}});
      expect(value.threadId).toBeGreaterThan(0);
    }
    expect(result.threadId).not.toBe(result.nested.threadId);
  } finally {scope.restore(); await fsp.rm(p.ownedRoot, {recursive: true, force: true});}
}, 30000);
