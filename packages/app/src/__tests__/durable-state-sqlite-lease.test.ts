import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSqliteLease } from "../durable-state/sqlite-lease.js";
import { loadOrCreateContinuationSecret } from "../continuation-secret.js";

const roots: string[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), "node_modules/sqlite-lease-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("shared SQLite lease", () => {
  it("preserves the durable filename and exact cross-process exclusion diagnostic", async () => {
    const root = await directory();
    const owner = await acquireSqliteLease(root);
    try {
      expect(await readdir(root)).toContain("continuations-owner.sqlite");
      const entry = new URL("../../dist/durable-state/sqlite-lease.js", import.meta.url).href;
      const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `
        import { acquireSqliteLease } from ${JSON.stringify(entry)};
        try { const lease = await acquireSqliteLease(${JSON.stringify(root)}); await lease.release(); process.exitCode = 1; }
        catch (error) { console.log(error.message); }
      `], { encoding: "utf8" });
      expect(output.trim()).toBe(`Continuation state is already owned by another live process: ${root}`);
    } finally { await owner.release(); }
    await owner.release();
    const replacement = await acquireSqliteLease(root);
    await replacement.release();
  });

  it("keeps the continuation-owned secret identity and bytes", async () => {
    const root = await directory();
    const secret = await loadOrCreateContinuationSecret(root);
    expect(secret).toHaveLength(32);
    expect(await loadOrCreateContinuationSecret(root)).toEqual(secret);
    expect(await readFile(join(root, "continuation-secret"), "utf8")).toBe(`${secret.toString("base64url")}\n`);
  });

  it("refuses a symlink state root without opening a database", async () => {
    const root = await directory();
    const target = join(root, "target");
    await mkdir(target, { mode: 0o700 });
    const alias = join(root, "alias");
    await symlink(target, alias);
    await expect(acquireSqliteLease(alias)).rejects.toThrow(`Continuation state path is not a real directory: ${alias}`);
    expect(await readdir(target)).toEqual([]);
    if (process.platform !== "win32") await chmod(target, 0o700);
  });
});
